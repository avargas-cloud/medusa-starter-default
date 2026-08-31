/**
 * verify-agent-bill-confirm-gate.ts — READ-ONLY.
 *
 * THE INVARIANT
 * -------------
 *   No purchasing-agent regular bill may be `confirmed` or `synced` while its
 *   purchase order has units still outstanding.
 *
 * The agent invoices the WHOLE purchase order — there are no per-shipment
 * invoices — so a bill confirmed on a partial arrival matches no document the
 * supplier ever produced, and gets posted to QuickBooks anyway.
 *
 * WHAT THIS CHECK REFUSES TO USE
 * ------------------------------
 * `purchase_order.status`. It is a display tag: `po-received-status.ts` only
 * rewrites receipt-driven values and a manual one wins, so a PO can read
 * `received` with units outstanding. A gate built on it would pass exactly the
 * case it exists to catch — and §1 asserts by name that the route does not
 * reach for it, because that regression would otherwise be invisible: every
 * test would still be green and only a hand-tagged PO would slip through.
 *
 * Run:
 *   env DATABASE_URL="$(grep ^DATABASE_URL= .env|cut -d= -f2-)" \
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-agent-bill-confirm-gate.ts
 */

import fs from "node:fs";
import path from "node:path";
import Knex from "knex";
import {
  decideConfirmReceiptRequirement,
  loadConfirmReceiptFacts,
} from "../../lib/purchase-orders/po-receipt-completeness";

const SRC = path.resolve(__dirname, "../..");

let failures = 0;
let checks = 0;
function check(ok: boolean, label: string, detail = ""): void {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
}

/** Body with `import` lines stripped: a "calls X" check must not be satisfied by the import. */
function bodyWithoutImports(rel: string): string {
  return fs
    .readFileSync(path.join(SRC, rel), "utf8")
    .split("\n")
    .filter((l) => !/^\s*import\b/.test(l) && !/^\s*}\s*from\s+"/.test(l))
    .join("\n");
}

const CONFIRM_ROUTE =
  "api/admin/purchase-orders/[id]/receipts/[receiptId]/vendor-bill/confirm/route.ts";
const SAVE_ROUTE = "api/admin/vendor-bills/[id]/route.ts";
const HELPER = "lib/purchase-orders/po-receipt-completeness.ts";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(2);
  }

  console.log("\n§1 — la regla está donde tiene que estar (estático)\n");

  const confirmRoute = bodyWithoutImports(CONFIRM_ROUTE);
  check(
    /decideConfirmReceiptRequirement\s*\(/.test(confirmRoute),
    "el confirm del regular consulta el gate de recepción"
  );
  check(
    /agent_po_not_fully_received/.test(confirmRoute),
    "y lo rechaza con un código propio",
    "no reusa po_not_receivable, que significa otra cosa"
  );

  const saveRoute = bodyWithoutImports(SAVE_ROUTE);
  check(
    /!isAgentPurchaseBill/.test(saveRoute),
    "el Save EXIME al bill de agente del cap contra lo recibido"
  );
  check(
    /qty_exceeds_po/.test(saveRoute),
    "pero conserva el cap contra lo ORDENADO para todos",
    "es el que impide facturar la misma unidad dos veces"
  );
  check(
    /confirm_gate/.test(saveRoute),
    "el detalle expone confirm_gate para que la pantalla lo refleje"
  );

  // La contingencia de las dos reglas cruzándose: "fully received" excluye un PO
  // de fill-from-po, y a la vez es el único momento en que un bill de agente
  // puede existir. Sin la exención, seedear las líneas se vuelve imposible justo
  // ahí — un callejón que no crea ninguna de las dos reglas por separado.
  const fillRoute = bodyWithoutImports("api/admin/vendor-bills/[id]/fill-from-po/route.ts");
  check(
    /!isAgentPo\s*&&/.test(fillRoute),
    "fill-from-po EXIME al PO de agente de po_not_open",
    "si no, el bill no se puede armar en el único momento en que puede confirmarse"
  );

  // La afirmación que protege el diseño entero: la completitud se MIDE.
  const helper = fs.readFileSync(path.join(SRC, HELPER), "utf8");
  const helperCode = helper.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  check(
    !/purchase_order\.status|po\.status|\bstatus\b\s*(=|IN)/.test(helperCode),
    "el helper NUNCA lee purchase_order.status",
    "un tag puesto a mano pasaría el gate que existe para frenarlo"
  );
  check(
    /qty_ordered\s*-\s*COALESCE\(pol\.qty_cancelled/.test(helperCode) &&
      /qty_received/.test(helperCode),
    "mide Σ recibido contra Σ(ordenado − cancelado), el mismo yardstick que Billed"
  );

  console.log("\n§2 — el invariante, contra datos vivos\n");

  const knex = Knex({ client: "pg", connection: url, pool: { min: 0, max: 3 } });
  try {
    const rows = await knex.raw(
      `SELECT vb.id, vb.number, vb.status
         FROM vendor_bill vb
        WHERE vb.deleted_at IS NULL
          AND vb.bill_type = 'regular'
          AND vb.status IN ('confirmed', 'synced')
          AND vb.purchase_order_id IS NOT NULL
        ORDER BY vb.number`,
      []
    );

    const violations: string[] = [];
    let agentBills = 0;
    for (const r of rows.rows as Array<{ id: string; number: string; status: string }>) {
      const f = await loadConfirmReceiptFacts(knex as never, r.id);
      if (!f || !f.is_agent_purchase) continue;
      agentBills += 1;
      const v = decideConfirmReceiptRequirement(f);
      if (!v.satisfied) {
        violations.push(
          `${r.number} (${r.status}) — ${f.qty_received}/${f.qty_ordered} recibidas`
        );
      }
    }

    check(
      violations.length === 0,
      "ningún bill de agente quedó confirmado con el PO incompleto",
      violations.length === 0 ? `${agentBills} bills de agente revisados` : violations.join(" · ")
    );
    for (const v of violations) console.log(`         VIOLA   ${v}`);

    // CONTROL POSITIVO — sin esto el §2 de arriba es VACUO.
    //
    // "Ningún bill viola el invariante" pasa hoy porque el estado malo no
    // existe todavía: pasaría idéntico con el gate borrado. Un assert de "no
    // pasó nada" necesita que el sistema haya QUERIDO que pase algo.
    //
    // Así que se cruza la decisión contra un SQL escrito APARTE, que resuelve
    // "PO de agente incompleto" sin tocar el helper. Si las dos listas no
    // coinciden, o el helper dejó de medir o el SQL dejó de describir lo mismo
    // — en ambos casos hay que mirar. Derivado, nunca anclado a números de bill
    // concretos: un fixture atado a bills vivos es cómo un verificador llegó a
    // 14/10 sin que nadie lo notara.
    const sqlIncomplete = await knex.raw(
      `SELECT vb.id
         FROM vendor_bill vb
         JOIN purchase_order po ON po.id = vb.purchase_order_id AND po.deleted_at IS NULL
         JOIN qb_vendor v ON v.id = po.vendor_id
        WHERE vb.deleted_at IS NULL
          AND vb.bill_type = 'regular'
          AND vb.status = 'draft'
          AND COALESCE(v.metadata @> '{"is_china_agent": true}'::jsonb
                       OR lower(v.metadata->>'is_china_agent') = 'true', false)
          AND (SELECT COALESCE(SUM(COALESCE(l.qty_received, 0)), 0)
                 FROM purchase_order_line l
                WHERE l.purchase_order_id = po.id AND l.deleted_at IS NULL)
            < (SELECT COALESCE(SUM(GREATEST(l.qty_ordered - COALESCE(l.qty_cancelled, 0), 0)), 0)
                 FROM purchase_order_line l
                WHERE l.purchase_order_id = po.id AND l.deleted_at IS NULL)`,
      []
    );
    const expectBlocked = new Set(
      (sqlIncomplete.rows as Array<{ id: string }>).map((r) => r.id)
    );

    const drafts0 = await knex.raw(
      `SELECT vb.id, vb.number
         FROM vendor_bill vb
        WHERE vb.deleted_at IS NULL AND vb.bill_type = 'regular'
          AND vb.status = 'draft' AND vb.purchase_order_id IS NOT NULL`,
      []
    );
    const actuallyBlocked = new Set<string>();
    for (const r of drafts0.rows as Array<{ id: string }>) {
      const f = await loadConfirmReceiptFacts(knex as never, r.id);
      if (!f) continue;
      if (!decideConfirmReceiptRequirement(f).satisfied) actuallyBlocked.add(r.id);
    }
    const sameSet =
      expectBlocked.size === actuallyBlocked.size &&
      [...expectBlocked].every((id) => actuallyBlocked.has(id));
    check(
      sameSet && expectBlocked.size > 0,
      "el gate frena EXACTAMENTE los drafts de agente con el PO incompleto",
      expectBlocked.size === 0
        ? "no hay ninguno hoy — el control positivo perdió su sujeto, revisar antes de confiar en §2"
        : `SQL independiente dice ${expectBlocked.size}, el gate frena ${actuallyBlocked.size}`
    );

    // Lo que el gate FRENA hoy — reportado, nunca fallado. Un verificador que
    // sólo dice "ok" no enseña qué está mirando.
    const drafts = await knex.raw(
      `SELECT vb.id, vb.number
         FROM vendor_bill vb
        WHERE vb.deleted_at IS NULL AND vb.bill_type = 'regular'
          AND vb.status = 'draft' AND vb.purchase_order_id IS NOT NULL
        ORDER BY vb.number`,
      []
    );
    const blocked: string[] = [];
    for (const r of drafts.rows as Array<{ id: string; number: string }>) {
      const f = await loadConfirmReceiptFacts(knex as never, r.id);
      if (!f || !f.is_agent_purchase) continue;
      const v = decideConfirmReceiptRequirement(f);
      if (!v.satisfied) blocked.push(`${r.number} — ${f.qty_received}/${f.qty_ordered}`);
    }
    console.log(`\n         ${blocked.length} draft(s) de agente que el gate frena hoy:`);
    for (const b of blocked) console.log(`         frenado ${b}`);
  } finally {
    await knex.destroy();
  }

  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} checks\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify-agent-bill-confirm-gate crashed:", err);
  process.exit(2);
});

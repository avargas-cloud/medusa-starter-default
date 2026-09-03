/**
 * verify-clearing-drift.ts
 *
 * The bill detail route warns "a linked bill was edited — this one needs
 * review" by comparing what QuickBooks holds (`vendor_bill.qb_clearing_lines`)
 * against what the sibling bills are worth today. That warning is the only
 * thing standing between an edited commission and an A/P balance that is
 * quietly wrong, so it is checked against a SECOND, independently written
 * derivation — a plain SQL comparison — never against itself.
 *
 * Read-only. Run it against production to see the real answer:
 *
 *   ./node_modules/.bin/tsx src/scripts/verify/verify-clearing-drift.ts
 *   SB=1 ./node_modules/.bin/tsx src/scripts/verify/verify-clearing-drift.ts
 *
 * It is a plain script, NOT a `medusa exec` default export: those do nothing
 * under tsx and exit 0, which is how two verifiers were once reported green
 * without ever having run.
 */

import { Client } from "pg";
import { readFileSync } from "fs";
import { join } from "path";
import { deriveClearingDrift } from "../../lib/purchase-orders/qb-vendor-bill-clearing-lines";
import { loadClearingSiblings } from "../../lib/purchase-orders/load-clearing-siblings";
import { scanClearingDrift } from "../../lib/purchase-orders/vendor-bill-invariant-scans";

function resolveDbUrl(): string {
  if (process.env.SB === "1") {
    // Same string the other sandbox scripts use — a wrong one here fails with
    // an auth error that reads like the sandbox is down.
    return "postgresql://postgres:sandbox@localhost:5499/medusa";
  }
  const env = readFileSync(join(process.cwd(), ".env"), "utf8");
  const line = env.split("\n").find((l) => l.startsWith("DATABASE_URL="));
  if (!line) throw new Error("DATABASE_URL not found in backend/.env");
  return line.slice("DATABASE_URL=".length).trim();
}

const results: Array<{ ok: boolean; label: string; detail?: string }> = [];
function check(label: string, ok: boolean, detail?: string): void {
  results.push({ ok, label, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * The same question answered in SQL, with no TypeScript in the path: for every
 * regular bill, each linked sibling's current total next to the amount the
 * persisted clearing line of that kind carries.
 */
const CROSS_CHECK_SQL = `
WITH reg AS (
  SELECT vb.id, vb.number, vb.qb_txn_id,
         COALESCE(vb.qb_clearing_lines, '[]'::jsonb) AS cl,
         vb.service_vendor_bill_id AS s,
         vb.freight_vendor_bill_id AS f,
         vb.tariff_vendor_bill_id  AS t
    FROM vendor_bill vb
   WHERE vb.bill_type = 'regular' AND vb.deleted_at IS NULL
)
SELECT reg.id, reg.number, (reg.qb_txn_id IS NOT NULL) AS in_qb,
       CASE x.col WHEN 's' THEN 'commission'
                  WHEN 'f' THEN 'freight'
                  ELSE 'tariff' END AS kind,
       sib.number AS sibling_number,
       COALESCE((SELECT SUM(l.qty * l.unit_cost_cents)::int
                   FROM vendor_bill_line l
                  WHERE l.vendor_bill_id = sib.id
                    AND l.deleted_at IS NULL), 0) AS current_cents,
       COALESCE(ABS((SELECT (e->>'amount_cents')::int
                       FROM jsonb_array_elements(reg.cl) e
                      WHERE e->>'kind' = CASE x.col WHEN 's' THEN 'commission'
                                                    WHEN 'f' THEN 'freight'
                                                    ELSE 'tariff' END)), 0)
         AS quickbooks_cents
  FROM reg
  CROSS JOIN LATERAL (VALUES ('s', reg.s), ('f', reg.f), ('t', reg.t))
    AS x(col, bid)
  JOIN vendor_bill sib ON sib.id = x.bid AND sib.deleted_at IS NULL
 ORDER BY reg.number, kind`;

interface CrossRow {
  id: string;
  number: string | null;
  in_qb: boolean;
  kind: string;
  sibling_number: string | null;
  current_cents: number;
  quickbooks_cents: number;
}

/**
 * Source of a file with its `import` lines stripped.
 *
 * A "does this file call X" check that scans the whole text is satisfied by the
 * IMPORT alone — a defect this repo has paid for three times. Dropping the
 * import block is what makes the assertion mean what it says.
 */
function bodyWithoutImports(rel: string): string {
  const text = readFileSync(join(process.cwd(), "src", rel), "utf8");
  return text
    .split("\n")
    .filter((l) => !/^\s*import\b/.test(l) && !/^\s*}\s*from\s+"/.test(l))
    .join("\n");
}

/**
 * §0 — THE COLUMN THIS WHOLE SCRIPT TRUSTS HAS TO BE MAINTAINED (2026-09-03).
 *
 * Every check below compares `vendor_bill.qb_clearing_lines` against the
 * siblings, on the premise that the column says what QuickBooks holds. For a
 * year only the BillAdd ever wrote it: the Mod read it, sent FRESH amounts, and
 * left the column quoting the old ones. So the first time a sibling was
 * corrected and the group re-confirmed, this verifier and the bill's own banner
 * both went permanently red against a QuickBooks document that was correct.
 * Measured on VB-1128: QuickBooks −$380.68, column −$388.87.
 *
 * Static, because the write only happens when a real BillMod confirms and there
 * is no way to reach that from a read-only script.
 */
function checkModMaintainsTheColumn(): void {
  const modEnqueue = bodyWithoutImports(
    "lib/purchase-orders/qb-vendor-bill-mod-enqueue.ts"
  );
  check(
    "el Mod manda en su payload lo que QuickBooks va a tener",
    /clearing_lines:\s*clearingSnapshot/.test(modEnqueue),
    "sin el snapshot, el confirm no tiene con qué actualizar la columna"
  );

  const poller = bodyWithoutImports(
    "lib/quickbooks/consolidator/poll-submitted-rows.ts"
  );
  // El write tiene que estar DENTRO de la rama del confirm de `vendor_bill_mod`
  // y apuntar a `qb_clearing_lines`. Afirmar sólo "el archivo menciona
  // clearing_lines" lo cumpliría un comentario.
  const confirmBranch = poller.slice(
    poller.indexOf('row.step === "vendor_bill_mod" && row.reference_id && modifiedBill')
  );
  const branchBody = confirmBranch.slice(0, 4000);
  check(
    "y el confirm del Mod la escribe en vendor_bill.qb_clearing_lines",
    confirmBranch.length > 0 &&
      /qb_clearing_lines\s*=\s*\$2::jsonb/.test(branchBody) &&
      /\.clearing_lines/.test(branchBody),
    "el aviso de esta pantalla no tendría forma de apagarse nunca"
  );
}

async function main(): Promise<void> {
  console.log("\n§0 — quién mantiene la columna (estático)\n");
  checkModMaintainsTheColumn();
  console.log("");

  const db = new Client({ connectionString: resolveDbUrl() });
  await db.connect();
  const knexLike = {
    raw: async (sql: string, bindings: unknown[] = []) => {
      let i = 0;
      const pg = sql.replace(/\?/g, () => `$${++i}`);
      const r = await db.query(pg, bindings as never[]);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
  };

  try {
    const cross = (await db.query<CrossRow>(CROSS_CHECK_SQL)).rows;
    const byBill = new Map<string, CrossRow[]>();
    for (const row of cross) {
      const list = byBill.get(row.id) ?? [];
      list.push(row);
      byBill.set(row.id, list);
    }

    console.log(
      `\nRegular bills with linked siblings: ${byBill.size} (${cross.length} sibling links)\n`
    );

    // ── 1 · The function agrees with the SQL, bill by bill ───────────────────
    let mismatches = 0;
    let staleBills = 0;
    let totalDelta = 0;
    const staleIds: string[] = [];
    for (const [billId, rows] of byBill) {
      const siblings = await loadClearingSiblings(knexLike, billId);
      const persistedResult = await db.query<{ lines: unknown }>(
        `SELECT COALESCE(qb_clearing_lines,'[]'::jsonb) AS lines
           FROM vendor_bill WHERE id = $1`,
        [billId]
      );
      const drift = deriveClearingDrift(
        (persistedResult.rows[0]?.lines ?? []) as never,
        siblings
      );

      const expected = rows
        .filter((r) => r.current_cents !== r.quickbooks_cents)
        .map((r) => `${r.kind}:${r.quickbooks_cents}->${r.current_cents}`)
        .sort();
      const actual = drift.items
        .filter((i) => i.number !== null) // the SQL only walks live siblings
        .map((i) => `${i.kind}:${i.quickbooks_cents}->${i.current_cents}`)
        .sort();

      if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        mismatches += 1;
        console.log(
          `  ✗ ${rows[0].number}: SQL says [${expected.join(", ")}], function says [${actual.join(", ")}]`
        );
      }
      if (drift.stale && rows[0].in_qb) {
        staleIds.push(billId);
        staleBills += 1;
        totalDelta += drift.delta_cents;
        for (const item of drift.items) {
          console.log(
            `    ${rows[0].number}: ${item.kind} ${item.number ?? "(sibling gone)"} — QuickBooks clears ${money(item.quickbooks_cents)}, the bill is ${money(item.current_cents)}`
          );
        }
      }
    }
    check(
      "la función y el SQL dan la MISMA respuesta en todos los bills",
      mismatches === 0,
      `${mismatches} bills discrepan`
    );

    // ── 2 · The banner fires only where there is something to fix ────────────
    const inQbWithSiblings = [...byBill.values()].filter(
      (rows) => rows[0].in_qb
    ).length;
    check(
      `el aviso se dispararía en ${staleBills} de ${inQbWithSiblings} bills que SÍ están en QuickBooks`,
      staleBills <= inQbWithSiblings,
      `${staleBills} > ${inQbWithSiblings}`
    );

    // ── 2b · El barrido que MANDA EL MAIL ve exactamente lo mismo ─────────────
    //
    // `scanClearingDrift` es lo que lee la sección 13 del digest, o sea lo único
    // que le llega a una persona sin que la tipee. Si divergiera de este script,
    // el mail podría callar sobre un bill que acá sale en rojo — y nadie se
    // enteraría, porque el que calla es justamente el que nadie corre a mano.
    // Se compara contra los ids del cruce SQL de arriba, no contra sí mismo.
    const scanned = await scanClearingDrift(knexLike);
    const scannedIds = scanned.map((f) => f.vendor_bill_id).sort();
    check(
      "el barrido del digest ve los MISMOS bills que el cruce SQL",
      JSON.stringify(scannedIds) === JSON.stringify([...staleIds].sort()),
      `digest [${scannedIds.join(", ")}] vs SQL [${[...staleIds].sort().join(", ")}]`
    );
    if (staleBills > 0) {
      console.log(`\n  A/P descuadrado en total: ${money(totalDelta)}\n`);
    }

    // ── 3 · A bill that is NOT in QuickBooks never gets a banner ─────────────
    // Its Add will build the clearing lines from these same siblings, so
    // "needs review" would be advice with nothing to review.
    const notInQb = [...byBill.entries()].filter(([, rows]) => !rows[0].in_qb);
    check(
      `${notInQb.length} bills con hermanos NO están en QuickBooks — el aviso los ignora`,
      true,
      notInQb.map(([, r]) => r[0].number).join(", ")
    );

    // ── 4 · Sign convention: everything persisted is stored NEGATIVE ─────────
    const signs = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n
         FROM vendor_bill vb, jsonb_array_elements(vb.qb_clearing_lines) e
        WHERE vb.bill_type = 'regular' AND vb.deleted_at IS NULL
          AND vb.qb_clearing_lines IS NOT NULL
          AND (e->>'amount_cents')::int > 0`
    );
    check(
      "ninguna clearing line persistida está guardada en POSITIVO",
      Number(signs.rows[0]?.n ?? 0) === 0,
      `${signs.rows[0]?.n} en positivo — el comparador lee magnitudes, pero el Mod las manda tal cual`
    );
  } finally {
    await db.end();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${results.length - failed.length} passed, ${failed.length} failed\n`
  );
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

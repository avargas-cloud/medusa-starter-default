/**
 * verify-qb-sales-parity.ts — el mes del POS contra el mes de QuickBooks.
 *
 * Correr:
 *   env DATABASE_URL="$(grep ^DATABASE_URL= .env|cut -d= -f2-)" \
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-qb-sales-parity.ts --months=2026-08
 *
 *   # varios meses de una:
 *   … verify-qb-sales-parity.ts --months=2026-05,2026-06,2026-07,2026-08
 *
 * Sin `--months` toma el ÚLTIMO MES COMPLETO. Es un script tsx plano, no un
 * `medusa exec`: los verify con `export default` corridos con tsx no ejecutan
 * nada y salen 0 — un verificador que puede quedarse mudo y aprobado no sirve.
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────
 *
 * El motivo declarado por el operador, textual: *"para que la gente no vea una
 * diferencia y piense que es un error del store-pos"*. Hasta el 2026-09-04 esa
 * pregunta sólo se podía contestar con una sospecha. Ahora se contesta con un
 * número, y el número tiene que ser CERO.
 *
 * La diferencia que lo motivó eran $310,00 en agosto 2026 — el flete. El item
 * de QB `SHIPPING & HANDLING` apunta a `Sales:Shipping and Delivery Income`, o
 * sea una cuenta de INGRESO, así que *Sales by Customer Summary* lo contaba
 * como venta; nuestros reportes sumaban sólo líneas de ítem. Detalle:
 * `_lib/shipping-revenue.ts` y `docs/REPORTS_SHIPPING_PARITY_PLAN.md`.
 *
 * ── Es READ-ONLY contra los dos lados ────────────────────────────────────────
 *
 * A QuickBooks sólo le manda `*QueryRq`. Ningún Add, Mod, Delete ni Void. A
 * Postgres, sólo SELECT. Se puede correr contra producción sin pedir permiso a
 * nadie, que es justamente lo que lo hace útil.
 *
 * ── Lo que NO prueba ─────────────────────────────────────────────────────────
 *
 * Que los totales del mes coincidan no dice que cada documento esté bien: dos
 * errores opuestos se cancelan. Para el diff documento por documento está
 * `scripts/qb-recon/` (4 operaciones al bridge, no una por documento).
 */

import { readFileSync } from "fs";
import { resolve } from "path";

import { Client } from "pg";

import { etMidnightUtc } from "../../lib/date/et";
import { NET_ITEM_REVENUE } from "../../api/admin/reports/_lib/revenue-expr";
import {
  CM_REFUND_CENTS_EXPR,
  CM_REFUND_DATE_COL,
  CM_REFUND_SCOPE_SQL,
  SALES_ACTIVE_STATUSES_SQL,
} from "../../api/admin/reports/_lib/sales-revenue";
import {
  CM_SHIPPING_REFUND_CENTS,
  INVOICE_SHIPPING_CENTS,
} from "../../api/admin/reports/_lib/shipping-revenue";

type DocType = "Invoice" | "SalesReceipt" | "CreditMemo";

const failures: string[] = [];
const money = (cents: number): string =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const check = (name: string, ok: boolean, detail = ""): void => {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};

/** Lee una clave del .env sin imprimir su valor. */
function envFromFile(key: string): string {
  const file = readFileSync(resolve(__dirname, "../../../.env"), "utf8");
  const line = file.split("\n").find((l) => l.startsWith(`${key}=`));
  if (!line) throw new Error(`Falta ${key} en backend/.env`);
  return line.slice(key.length + 1).trim();
}

/**
 * Una consulta de headers al bridge. `IncludeLineItems=false` a propósito: sin
 * eso una ventana de un mes trae megabytes de líneas para sumar un escalar.
 *
 * Los iterators de QBXML NO sobreviven entre operaciones (QB 3391), así que
 * cada ventana es autocontenida y no se paginan resultados.
 */
async function qbQuery(
  url: string,
  key: string,
  doc: DocType,
  from: string,
  to: string
): Promise<Record<string, unknown>[]> {
  const qbxml =
    `<?xml version="1.0" encoding="utf-8"?><?qbxml version="10.0"?>` +
    `<QBXML><QBXMLMsgsRq onError="stopOnError"><${doc}QueryRq>` +
    `<TxnDateRangeFilter><FromTxnDate>${from}</FromTxnDate><ToTxnDate>${to}</ToTxnDate></TxnDateRangeFilter>` +
    `<IncludeLineItems>false</IncludeLineItems>` +
    `</${doc}QueryRq></QBXMLMsgsRq></QBXML>`;

  const headers = {
    "Content-Type": "application/json",
    "x-api-key": key,
    "bypass-tunnel-reminder": "true",
  };

  const submit = await fetch(`${url}/api/sync/direct-query`, {
    method: "POST",
    headers,
    body: JSON.stringify({ qbxml }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!submit.ok) throw new Error(`bridge ${submit.status} al encolar ${doc}`);
  const { operationId } = (await submit.json()) as { operationId?: string };
  if (!operationId) throw new Error(`el bridge no devolvió operationId para ${doc}`);

  // Pollear el RESULTADO, nunca dar por buena la encolada — la regla del repo
  // para todo lo que pasa por el bridge.
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 6_000));
    const st = await fetch(`${url}/api/sync/status/${operationId}`, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await st.json()) as { operation?: { status?: string; result?: unknown } };
    const status = body.operation?.status;
    if (status === "failed") throw new Error(`la operación de ${doc} falló en el bridge`);
    if (status !== "completed") continue;

    const r = (body.operation?.result ?? {}) as Record<string, any>;
    const rs = r.QBXML?.QBXMLMsgsRs ?? r.QBXMLMsgsRs ?? r;
    const q = rs?.[`${doc}QueryRs`] ?? {};
    const code = q.statusCode;
    // statusCode 1 = "no encontró nada", que es un mes vacío legítimo.
    if (code !== undefined && code !== "0" && code !== "1") {
      throw new Error(`QB statusCode=${code} ${q.statusMessage ?? ""} en ${doc}`);
    }
    const ret = q[`${doc}Ret`] ?? [];
    return Array.isArray(ret) ? ret : [ret];
  }
  throw new Error(`timeout esperando ${doc} en el bridge`);
}

const num = (x: unknown): number => {
  const n = typeof x === "string" ? parseFloat(x) : typeof x === "number" ? x : 0;
  return Number.isFinite(n) ? n : 0;
};
/** Dólares de QB → centavos enteros, sin arrastrar float. */
const cents = (x: unknown): number => Math.round(num(x) * 100);

/**
 * `Subtotal` es el campo correcto y no `TotalAmount`, por dos razones que ya
 * costaron un rodeo:
 *
 *  1. `InvoiceRet` NO trae `TotalAmount`. Usarlo da $0,00 SILENCIOSO — parece
 *     que no hubo ventas en el mes.
 *  2. `InvoiceRet.Subtotal` YA incluye la línea de flete y EXCLUYE el impuesto,
 *     que es exactamente la base sobre la que reportamos nosotros.
 */
const sumSubtotal = (rows: Record<string, unknown>[]): number =>
  rows.reduce((a, r) => a + cents(r.Subtotal), 0);

function monthWindow(month: string): { fromIso: string; toIso: string; qbFrom: string; qbTo: string } {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) throw new Error(`mes inválido: ${month}`);
  const from = etMidnightUtc(y, m - 1, 1);
  const to = etMidnightUtc(y, m, 1);
  // QB filtra por TxnDate, que es una fecha de CALENDARIO del negocio: el
  // último día del mes va inclusive, no el primero del siguiente.
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    fromIso: from.toISOString(),
    toIso: to.toISOString(),
    qbFrom: `${month}-01`,
    qbTo: `${month}-${String(lastDay).padStart(2, "0")}`,
  };
}

async function posSide(db: Client, fromIso: string, toIso: string) {
  const ACTIVE = `i.deleted_at IS NULL AND ${SALES_ACTIVE_STATUSES_SQL}`;
  const WINDOW = `i.issued_at >= $1 AND i.issued_at < $2`;

  const lineas = await db.query(
    `SELECT COALESCE(ROUND(SUM(${NET_ITEM_REVENUE})), 0)::bigint AS c
     FROM pos_invoice_item pii
     JOIN pos_invoice i ON i.id = pii.invoice_id AND ${ACTIVE} AND ${WINDOW}
     WHERE pii.deleted_at IS NULL`,
    [fromIso, toIso]
  );
  const flete = await db.query(
    `SELECT COALESCE(SUM(${INVOICE_SHIPPING_CENTS}), 0)::bigint AS c,
            COUNT(*) FILTER (WHERE COALESCE(i.shipping,0) <> 0)::int AS n
     FROM pos_invoice i WHERE ${ACTIVE} AND ${WINDOW}`,
    [fromIso, toIso]
  );
  const devol = await db.query(
    `SELECT COALESCE(SUM(${CM_REFUND_CENTS_EXPR}), 0)::bigint AS c,
            COALESCE(SUM(${CM_SHIPPING_REFUND_CENTS}), 0)::bigint AS ship
     FROM pos_credit_memo cm
     WHERE ${CM_REFUND_SCOPE_SQL}
       AND ${CM_REFUND_DATE_COL} >= $1 AND ${CM_REFUND_DATE_COL} < $2`,
    [fromIso, toIso]
  );

  const lineasC = Number(lineas.rows[0].c);
  const fleteC = Number(flete.rows[0].c);
  const devolC = Number(devol.rows[0].c) + Number(devol.rows[0].ship);
  return {
    lineas: lineasC,
    flete: fleteC,
    facturasConFlete: Number(flete.rows[0].n),
    bruto: lineasC + fleteC,
    devoluciones: devolC,
    neto: lineasC + fleteC - devolC,
  };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("❌ Falta DATABASE_URL. Sin destino explícito este gate no corre.");
    process.exit(1);
  }

  const arg = process.argv.find((a) => a.startsWith("--months="));
  let months: string[];
  if (arg) {
    months = arg.slice("--months=".length).split(",").map((s) => s.trim()).filter(Boolean);
  } else {
    const now = new Date();
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    months = [`${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}`];
  }

  console.log(`\n🔎 verify-qb-sales-parity — ${url.replace(/\/\/[^@]*@/, "//***@")}`);
  console.log(`   meses: ${months.join(", ")}\n`);

  const bridgeUrl = envFromFile("QB_BRIDGE_URL");
  const bridgeKey = envFromFile("QB_API_KEY");

  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    for (const month of months) {
      const { fromIso, toIso, qbFrom, qbTo } = monthWindow(month);
      console.log(`${month}  (ET ${qbFrom} → ${qbTo})`);

      const pos = await posSide(db, fromIso, toIso);

      let inv: Record<string, unknown>[];
      let sr: Record<string, unknown>[];
      let cm: Record<string, unknown>[];
      try {
        // En serie a propósito: los iterators de QBXML no conviven bien y el
        // bridge atiende una operación por vez.
        inv = await qbQuery(bridgeUrl, bridgeKey, "Invoice", qbFrom, qbTo);
        sr = await qbQuery(bridgeUrl, bridgeKey, "SalesReceipt", qbFrom, qbTo);
        cm = await qbQuery(bridgeUrl, bridgeKey, "CreditMemo", qbFrom, qbTo);
      } catch (e) {
        // Un bridge caído NO puede leerse como paridad. Falla ruidoso.
        check(`${month}: QuickBooks respondió`, false, (e as Error).message);
        continue;
      }

      const qbBruto = sumSubtotal(inv) + sumSubtotal(sr);
      const qbDevol = sumSubtotal(cm);
      const qbNeto = qbBruto - qbDevol;
      const difBruto = pos.bruto - qbBruto;
      const difNeto = pos.neto - qbNeto;

      console.log(
        `    QB   ${inv.length} invoices + ${sr.length} sales receipts − ${cm.length} credit memos`
      );
      console.log(
        `    POS  líneas ${money(pos.lineas)} + flete ${money(pos.flete)} (${pos.facturasConFlete} facturas) = ${money(pos.bruto)}`
      );
      console.log(`    QB   bruto ${money(qbBruto)} · neto ${money(qbNeto)}`);
      console.log(`    POS  bruto ${money(pos.bruto)} · neto ${money(pos.neto)}`);

      check(`${month}: bruto POS = bruto QB`, difBruto === 0, `dif ${money(difBruto)}`);
      check(`${month}: neto POS = neto QB`, difNeto === 0, `dif ${money(difNeto)}`);

      // Control negativo: sin el término de flete la paridad se ROMPE. Sin esto
      // el check de arriba podría estar pasando porque el mes no tuvo flete —
      // que es como estuvieron todos los meses hasta abril 2026— en vez de
      // porque el flete se sumó.
      if (pos.flete !== 0) {
        check(
          `${month}: control negativo — sin el flete NO cuadraría`,
          pos.lineas - qbBruto !== 0,
          `sin flete quedaría ${money(pos.lineas - qbBruto)}`
        );
      } else {
        console.log(`    ⏭️  ${month}: sin flete en el mes, el control negativo no aplica`);
      }
      console.log("");
    }
  } finally {
    await db.end();
  }

  if (failures.length > 0) {
    console.error(`❌ ${failures.length} chequeo(s) fallaron:`);
    for (const f of failures) console.error(`   - ${f}`);
    process.exit(1);
  }
  console.log("✅ verify-qb-sales-parity: el POS y QuickBooks dicen lo mismo.\n");
}

main().catch((e) => {
  console.error("❌ verify-qb-sales-parity explotó:", e);
  process.exit(1);
});

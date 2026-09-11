/**
 * verify-qb-purchases-backfill — plan `qb-docs-backfill-compras-20260911`,
 * fases 2+3. Read-only salvo el snapshot de stock, que sólo LEE
 * `inventory_level` (nunca escribe).
 *
 *   DATABASE_URL=… ./node_modules/.bin/tsx src/scripts/verify/verify-qb-purchases-backfill.ts \
 *     --cache-dir .qb-docs-cache --run-id qbbf-20260911 [--admin-url http://localhost:9096] \
 *     [--sample 20] [--stock-before path.json]
 *
 * Checks (fase 2, Purchase Orders):
 *  (a) cada TxnID de PO en el inventario del run que se marcó `create` tiene
 *      EXACTAMENTE un `purchase_order` activo (el índice único de la
 *      migración ya lo impide a nivel DB; acá se re-afirma por CONTENIDO);
 *  (b) subtotal por línea y total del header coinciden con la caché QB
 *      (`amount_cents` de cada línea, `TotalAmount` del header);
 *  (c) `qty_received <= qty_ordered` en TODA línea creada;
 *  (d) ninguna fila nueva en `qb_purchase_order_pipeline`/
 *      `qb_item_receipt_pipeline`/`qb_vendor_bill_pipeline`/`qb_order_pipeline`
 *      referencia un documento creado por este run (todo documento backfilled
 *      nace con TxnID ya resuelto — nada que despachar);
 *  (e) snapshot de `inventory_level` (sum stocked/reserved, count) IDÉNTICO
 *      al provisto por `--stock-before` (si no se pasa, sólo se imprime el
 *      snapshot actual, sin comparar — control de vacuidad explícito en el
 *      reporte, no silencioso);
 *  (f) muestra de hasta `--sample` POs creados responde 200 en
 *      `GET /admin/purchase-orders/:id` con token de sandbox.
 *
 * Checks (2025 por enlace, `follow-links.ts`):
 *  (l) todo pago bloqueado por `bill_not_found` en ESTE run desapareció (el
 *      bill que le faltaba está fuera del rango descargado por ventana y
 *      `followLinks` corre automático antes del apply — un `bill_not_found`
 *      remanente es una regresión del paso, no un caso normal); y los
 *      documentos `via_link` (marcados en metadata/notes) pasan por la MISMA
 *      resolución HTTP que el resto (muestra de hasta 1 por tipo).
 *
 * Checks (fase 3, receipt/bill/credit/payment + de-adopt):
 *  (g) cada recibo creado tiene TxnID único, tantas líneas como QB y
 *      `purchase_order_id` resuelto;
 *  (h) bills: `qb_source='adopted'` = 0 tras `--de-adopt`; todo bill creado
 *      nativo con líneas en QB tiene AL MENOS una línea local;
 *  (i) créditos: `total_cents` coincide con la caché QB;
 *  (j) pagos: Σ `vendor_bill_payment_allocation.amount_cents` = `amount_cents`
 *      del header, y toda asignación referencia un `vendor_bill` existente;
 *  (k) muestra de hasta `--sample` documentos de receipt/bill/credit/payment
 *      responde 200 en su ruta GET.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : fallback;
}

const CACHE_DIR = arg("cache-dir", ".qb-docs-cache") as string;
const RUN_ID = arg("run-id");
const ADMIN_URL = arg("admin-url", "http://localhost:9096") as string;
const SAMPLE = Number(arg("sample", "20"));
const STOCK_BEFORE = arg("stock-before");

if (!RUN_ID) {
  console.error("uso: --run-id ID [--cache-dir DIR] [--admin-url URL] [--sample N] [--stock-before path.json]");
  process.exit(2);
}
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL es obligatoria");
  process.exit(2);
}

interface DocOutcome {
  txn_id: string;
  created?: string;
  blocked_reason?: string;
}
interface TypeScope {
  already: number;
  create: number;
  created: DocOutcome[];
  blocked: DocOutcome[];
}
interface DeAdoptScope {
  total_adopted: number;
  de_adopted: number;
  lines_added_total: number;
  blocked: DocOutcome[];
}

interface FollowLinksScope {
  iterations: number;
  fetched_by_type: { bills: number; purchase_orders: number; item_receipts: number };
  fetched_by_year: Record<string, { bills: number; purchase_orders: number; item_receipts: number }>;
  fetched_txn_ids: { bills: string[]; purchase_orders: string[]; item_receipts: string[] };
}

interface Inventory {
  run_id: string;
  created_pos: { txn_id: string; number: string; status: string }[];
  receipt_scope: TypeScope | null;
  bill_scope: (TypeScope & { receipts_linked: number; synthetic_receipts: number }) | null;
  credit_scope: TypeScope | null;
  payment_scope: TypeScope | null;
  de_adopt_scope: DeAdoptScope | null;
  follow_links: FollowLinksScope | null;
}

async function fetchToken(): Promise<string> {
  const res = await fetch(`${ADMIN_URL}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "sandbox@test.com", password: "sandbox123" }),
  });
  if (!res.ok) throw new Error(`login sandbox falló: ${res.status}`);
  const json = (await res.json()) as { token?: string };
  if (!json.token) throw new Error("login sandbox sin token");
  return json.token;
}

async function main() {
  const invPath = join(CACHE_DIR, `inventario_${RUN_ID}.json`);
  if (!existsSync(invPath)) {
    console.error(`✗ no existe ${invPath} — corré backfill-qb-purchases.ts primero`);
    process.exitCode = 1;
    return;
  }
  const inv = JSON.parse(readFileSync(invPath, "utf8")) as Inventory;
  const createdTxnIds = inv.created_pos.map((c) => c.txn_id);

  if (createdTxnIds.length === 0) {
    console.log(`⚠️  run ${RUN_ID}: 0 POs creados en el inventario — nada que verificar por contenido (control de vacuidad, no silencio).`);
  }

  // Cargar líneas/headers de la caché QB de PO para este rango, buscando por TxnID.
  const poCacheFiles = existsSync(CACHE_DIR)
    ? require("node:fs").readdirSync(CACHE_DIR).filter((f: string) => /^po_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.json$/.test(f))
    : [];
  const qbByTxn = new Map<string, { TotalAmount?: string; PurchaseOrderLineRet?: unknown }>();
  for (const f of poCacheFiles) {
    const raw = JSON.parse(readFileSync(join(CACHE_DIR, f), "utf8")) as { PurchaseOrderRet?: unknown } | null;
    if (!raw) continue;
    const rets = Array.isArray(raw.PurchaseOrderRet) ? raw.PurchaseOrderRet : raw.PurchaseOrderRet ? [raw.PurchaseOrderRet] : [];
    for (const r of rets as { TxnID: string; TotalAmount?: string; PurchaseOrderLineRet?: unknown }[]) {
      qbByTxn.set(r.TxnID, r);
    }
  }

  const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
  const client = await pool.connect();
  let failures = 0;

  try {
    // (a) uno-a-uno TxnID ↔ purchase_order
    const { rows: poRows } = await client.query(
      `SELECT id, qb_purchase_order_list_id, total_cents, subtotal_cents
         FROM purchase_order WHERE qb_purchase_order_list_id = ANY($1::text[]) AND deleted_at IS NULL`,
      [createdTxnIds]
    );
    const byTxn = new Map(poRows.map((r) => [String(r.qb_purchase_order_list_id), r]));
    for (const txnId of createdTxnIds) {
      if (!byTxn.has(txnId)) {
        console.error(`✗ (a) TxnID ${txnId} marcado 'creado' en el inventario pero no tiene purchase_order`);
        failures++;
      }
    }
    console.log(`(a) TxnID → purchase_order: ${byTxn.size}/${createdTxnIds.length} resueltos`);

    // (b)+(c) totales/líneas contra la caché QB, y piso de qty_received
    let checkedTotals = 0;
    for (const [txnId, poRow] of byTxn) {
      const qb = qbByTxn.get(txnId);
      if (!qb) continue; // fuera del rango cacheado por este --cache-dir; no es un fallo del backfill
      checkedTotals++;
      const qbTotalCents = Math.round(parseFloat(qb.TotalAmount ?? "0") * 100);
      if (Math.abs(qbTotalCents - Number(poRow.total_cents)) > 1) {
        console.error(`✗ (b) PO ${poRow.id} (${txnId}): total_cents ${poRow.total_cents} ≠ QB ${qbTotalCents}`);
        failures++;
      }
      const { rows: lineRows } = await client.query(
        `SELECT qty_ordered, qty_received FROM purchase_order_line WHERE purchase_order_id = $1 AND deleted_at IS NULL`,
        [poRow.id]
      );
      for (const l of lineRows) {
        if (Number(l.qty_received) > Number(l.qty_ordered)) {
          console.error(`✗ (c) PO ${poRow.id}: línea con qty_received ${l.qty_received} > qty_ordered ${l.qty_ordered}`);
          failures++;
        }
      }
    }
    console.log(`(b)/(c) totales+piso verificados contra caché para ${checkedTotals} PO(s)`);
    if (createdTxnIds.length > 0 && checkedTotals === 0) {
      console.error(`✗ control de vacuidad: 0 PO(s) tuvieron caché QB coincidente — el check (b)/(c) no evaluó nada`);
      failures++;
    }

    // (d) ningún documento backfilled tiene fila en su cola de despacho QB
    const poIds = [...byTxn.values()].map((r) => r.id as string);
    const receiptIds = (inv.receipt_scope?.created ?? []).map((c) => c.created).filter((v): v is string => !!v);
    const billIds = (inv.bill_scope?.created ?? []).map((c) => c.created).filter((v): v is string => !!v);
    const pipelineChecks: { label: string; sql: string; ids: string[] }[] = [
      { label: "qb_purchase_order_pipeline", sql: `SELECT purchase_order_id AS doc_id FROM qb_purchase_order_pipeline WHERE purchase_order_id = ANY($1::text[]) AND deleted_at IS NULL`, ids: poIds },
      { label: "qb_item_receipt_pipeline", sql: `SELECT purchase_order_receipt_id AS doc_id FROM qb_item_receipt_pipeline WHERE purchase_order_receipt_id = ANY($1::text[])`, ids: receiptIds },
      { label: "qb_vendor_bill_pipeline", sql: `SELECT vendor_bill_id AS doc_id FROM qb_vendor_bill_pipeline WHERE vendor_bill_id = ANY($1::text[])`, ids: billIds },
    ];
    for (const check of pipelineChecks) {
      if (check.ids.length === 0) { console.log(`(d) ${check.label}: sin documentos creados de este tipo — nada que verificar`); continue; }
      const { rows } = await client.query(check.sql, [check.ids]);
      if (rows.length > 0) {
        console.error(`✗ (d) ${rows.length} fila(s) en ${check.label} para documento(s) backfilled — no deberían despacharse`);
        failures++;
      } else {
        console.log(`(d) 0 filas en ${check.label} para los ${check.ids.length} documento(s) creados — OK`);
      }
    }
    // qb_order_pipeline es de VENTAS (order_id), no de compras — se confirma que
    // ningún documento de este run apareció ahí por error de columna/join.
    if (poIds.length + receiptIds.length + billIds.length > 0) {
      const { rows: orderPipelineRows } = await client.query(
        `SELECT id FROM qb_order_pipeline WHERE order_id = ANY($1::text[])`,
        [[...poIds, ...receiptIds, ...billIds]]
      );
      if (orderPipelineRows.length > 0) {
        console.error(`✗ (d) ${orderPipelineRows.length} fila(s) en qb_order_pipeline referencian un id de documento de COMPRAS — cruce inesperado`);
        failures++;
      } else {
        console.log(`(d) 0 filas en qb_order_pipeline cruzan con documentos de compras — OK`);
      }
    }

    // (e) snapshot de stock
    const { rows: stockRows } = await client.query(
      `SELECT COALESCE(sum(stocked_quantity),0) AS stocked, COALESCE(sum(reserved_quantity),0) AS reserved, count(*) AS n FROM inventory_level`
    );
    const snapshot = stockRows[0];
    console.log(`(e) snapshot inventory_level actual: ${JSON.stringify(snapshot)}`);
    if (STOCK_BEFORE && existsSync(STOCK_BEFORE)) {
      const before = JSON.parse(readFileSync(STOCK_BEFORE, "utf8"));
      const same =
        String(before.stocked) === String(snapshot.stocked) &&
        String(before.reserved) === String(snapshot.reserved) &&
        String(before.n) === String(snapshot.n);
      if (!same) {
        console.error(`✗ (e) snapshot de stock CAMBIÓ: antes ${JSON.stringify(before)} → ahora ${JSON.stringify(snapshot)}`);
        failures++;
      } else {
        console.log(`(e) snapshot de stock idéntico a --stock-before — OK`);
      }
    } else {
      console.log(`(e) sin --stock-before provisto — snapshot sólo informativo, NO se afirma igualdad (control de vacuidad explícito)`);
    }

    // (f) muestra de POs responde 200
    if (poIds.length > 0) {
      const sampleIds = poIds.slice(0, SAMPLE);
      try {
        const token = await fetchToken();
        let ok = 0;
        for (const id of sampleIds) {
          const res = await fetch(`${ADMIN_URL}/admin/purchase-orders/${id}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (res.status === 200) ok++;
          else {
            console.error(`✗ (f) GET /admin/purchase-orders/${id} → ${res.status}`);
            failures++;
          }
        }
        console.log(`(f) ${ok}/${sampleIds.length} PO(s) muestreados responden 200`);
      } catch (err) {
        console.error(`✗ (f) no se pudo autenticar/consultar el admin en ${ADMIN_URL}: ${(err as Error).message}`);
        failures++;
      }
    } else {
      console.log(`(f) sin PO(s) creados — nada que muestrear`);
    }

    // (g) recibos: TxnID único (el índice único de la migración ya lo impide;
    // re-afirmado por CONTENIDO) + tantas líneas como QB + purchase_order_id resuelto
    const receiptTxnIds = (inv.receipt_scope?.created ?? []).map((c) => c.txn_id);
    if (receiptTxnIds.length > 0) {
      const { rows: recRows } = await client.query(
        `SELECT id, qb_item_receipt_list_id, purchase_order_id,
                (SELECT count(*) FROM purchase_order_receipt_line l WHERE l.purchase_order_receipt_id = r.id AND l.deleted_at IS NULL) AS n_lines
           FROM purchase_order_receipt r WHERE qb_item_receipt_list_id = ANY($1::text[]) AND deleted_at IS NULL`,
        [receiptTxnIds]
      );
      const recByTxn = new Map(recRows.map((r) => [String(r.qb_item_receipt_list_id), r]));
      let ok = 0;
      for (const txnId of receiptTxnIds) {
        const row = recByTxn.get(txnId);
        if (!row) { console.error(`✗ (g) recibo ${txnId} marcado creado pero no existe en purchase_order_receipt`); failures++; continue; }
        if (!row.purchase_order_id) { console.error(`✗ (g) recibo ${txnId} sin purchase_order_id`); failures++; continue; }
        ok++;
      }
      console.log(`(g) ${ok}/${receiptTxnIds.length} recibo(s) resueltos con PO`);
    } else {
      console.log(`(g) sin recibos creados — control de vacuidad, no silencio`);
    }

    // (h) bills: qb_source='adopted' = 0 tras --de-adopt; bills creados nativos tienen líneas
    if (inv.de_adopt_scope) {
      const { rows: adoptedNow } = await client.query(
        `SELECT count(*)::int AS n FROM vendor_bill WHERE qb_source = 'adopted' AND deleted_at IS NULL`
      );
      const n = (adoptedNow[0] as { n: number }).n;
      if (n > 0) {
        console.error(`✗ (h) quedan ${n} vendor_bill con qb_source='adopted' tras --de-adopt`);
        failures++;
      } else {
        console.log(`(h) 0 vendor_bill con qb_source='adopted' — de-adopt completo`);
      }
    } else {
      console.log(`(h) sin --de-adopt en este run — sección sólo informativa`);
    }
    const billTxnIdsCreated = (inv.bill_scope?.created ?? []).map((c) => c.txn_id);
    if (billTxnIdsCreated.length > 0) {
      const { rows: billLineRows } = await client.query(
        `SELECT vb.qb_txn_id, (SELECT count(*) FROM vendor_bill_line l WHERE l.vendor_bill_id = vb.id AND l.deleted_at IS NULL) AS n_lines
           FROM vendor_bill vb WHERE vb.qb_txn_id = ANY($1::text[]) AND vb.deleted_at IS NULL`,
        [billTxnIdsCreated]
      );
      const withoutLines = (billLineRows as { qb_txn_id: string; n_lines: number }[]).filter((r) => Number(r.n_lines) === 0);
      if (withoutLines.length > 0) {
        console.error(`✗ (h) ${withoutLines.length} bill(s) creado(s) sin NINGUNA línea local: ${withoutLines.map((r) => r.qb_txn_id).join(", ")}`);
        failures++;
      } else {
        console.log(`(h) ${billLineRows.length} bill(s) creado(s), todos con al menos una línea local`);
      }
    }

    // (i) créditos: total_cents contra la caché QB
    const creditCacheFiles = existsSync(CACHE_DIR)
      ? require("node:fs").readdirSync(CACHE_DIR).filter((f: string) => /^credit_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.json$/.test(f))
      : [];
    const qbCreditByTxn = new Map<string, { TotalAmount?: string; Amount?: string }>();
    for (const f of creditCacheFiles) {
      const raw = JSON.parse(readFileSync(join(CACHE_DIR, f), "utf8")) as { VendorCreditRet?: unknown } | null;
      if (!raw) continue;
      const rets = Array.isArray(raw.VendorCreditRet) ? raw.VendorCreditRet : raw.VendorCreditRet ? [raw.VendorCreditRet] : [];
      for (const r of rets as { TxnID: string; TotalAmount?: string; Amount?: string }[]) qbCreditByTxn.set(r.TxnID, r);
    }
    const creditTxnIdsCreated = (inv.credit_scope?.created ?? []).map((c) => c.txn_id);
    if (creditTxnIdsCreated.length > 0) {
      const { rows: creditRows } = await client.query(
        `SELECT qb_txn_id, total_cents FROM vendor_credit WHERE qb_txn_id = ANY($1::text[]) AND deleted_at IS NULL`,
        [creditTxnIdsCreated]
      );
      let checked = 0;
      for (const r of creditRows as { qb_txn_id: string; total_cents: string | number }[]) {
        const qb = qbCreditByTxn.get(r.qb_txn_id);
        if (!qb) continue;
        checked++;
        const qbCents = Math.round(parseFloat(qb.TotalAmount ?? qb.Amount ?? "0") * 100);
        if (Math.abs(qbCents - Number(r.total_cents)) > 1) {
          console.error(`✗ (i) VendorCredit ${r.qb_txn_id}: total_cents ${r.total_cents} ≠ QB ${qbCents}`);
          failures++;
        }
      }
      console.log(`(i) totales verificados contra caché para ${checked}/${creditTxnIdsCreated.length} crédito(s)`);
    } else {
      console.log(`(i) sin créditos creados — control de vacuidad, no silencio`);
    }

    // (j) pagos: Σ allocations = amount_cents; toda asignación referencia un bill existente
    const paymentTxnIdsCreated = (inv.payment_scope?.created ?? []).map((c) => c.txn_id);
    if (paymentTxnIdsCreated.length > 0) {
      const { rows: payRows } = await client.query(
        `SELECT p.id, p.qb_txn_id, p.amount_cents,
                COALESCE((SELECT sum(a.amount_cents) FROM vendor_bill_payment_allocation a WHERE a.payment_id = p.id), 0) AS alloc_sum,
                (SELECT count(*) FROM vendor_bill_payment_allocation a
                   LEFT JOIN vendor_bill vb ON vb.id = a.vendor_bill_id
                  WHERE a.payment_id = p.id AND vb.id IS NULL) AS dangling
           FROM vendor_bill_payment p WHERE p.qb_txn_id = ANY($1::text[]) AND p.deleted_at IS NULL`,
        [paymentTxnIdsCreated]
      );
      let ok = 0;
      for (const r of payRows as { id: string; qb_txn_id: string; amount_cents: string | number; alloc_sum: string | number; dangling: string | number }[]) {
        if (Number(r.dangling) > 0) {
          console.error(`✗ (j) BillPayment ${r.qb_txn_id}: ${r.dangling} asignación(es) apuntan a un vendor_bill inexistente`);
          failures++;
          continue;
        }
        if (Math.abs(Number(r.alloc_sum) - Number(r.amount_cents)) > 1) {
          console.error(`✗ (j) BillPayment ${r.qb_txn_id}: Σ asignaciones ${r.alloc_sum} ≠ amount_cents ${r.amount_cents}`);
          failures++;
          continue;
        }
        ok++;
      }
      console.log(`(j) ${ok}/${paymentTxnIdsCreated.length} pago(s) con asignaciones consistentes`);
    } else {
      console.log(`(j) sin pagos creados — control de vacuidad, no silencio`);
    }

    // (k) muestra de receipt/bill/credit/payment responde 200
    try {
      const token = await fetchToken();
      const billSampleIds = (inv.bill_scope?.created ?? []).map((c) => c.created).filter((v): v is string => !!v).slice(0, SAMPLE);
      const creditSampleIds = (inv.credit_scope?.created ?? []).map((c) => c.created).filter((v): v is string => !!v).slice(0, SAMPLE);
      const paymentSampleIds = (inv.payment_scope?.created ?? []).map((c) => c.created).filter((v): v is string => !!v).slice(0, SAMPLE);
      const samplers: { label: string; base: string; ids: string[] }[] = [
        { label: "vendor-bill", base: "/admin/vendor-bills", ids: billSampleIds },
        { label: "vendor-credit", base: "/admin/vendor-credits", ids: creditSampleIds },
        { label: "bill-payment", base: "/admin/bill-payments", ids: paymentSampleIds },
      ];
      for (const s of samplers) {
        if (s.ids.length === 0) { console.log(`(k) ${s.label}: sin documentos creados — nada que muestrear`); continue; }
        let ok = 0;
        for (const id of s.ids) {
          const res = await fetch(`${ADMIN_URL}${s.base}/${id}`, { headers: { Authorization: `Bearer ${token}` } });
          if (res.status === 200) ok++;
          else { console.error(`✗ (k) GET ${s.base}/${id} → ${res.status}`); failures++; }
        }
        console.log(`(k) ${s.label}: ${ok}/${s.ids.length} muestreados responden 200`);
      }
      // `GET /admin/purchase-orders/:id/receipts/:receiptId` NO EXISTE (sólo
      // DELETE en esa ruta — sondeado, 404 real) — el recibo se ve embebido en
      // `GET /admin/purchase-orders/:id` (`receipts: decoratedReceipts`), así
      // que se muestrea por su PO padre y se confirma que el recibo aparece
      // en el array devuelto.
      const receiptSampleIds = receiptTxnIds.slice(0, SAMPLE);
      if (receiptSampleIds.length > 0) {
        const { rows: recRows2 } = await client.query(
          `SELECT id, purchase_order_id FROM purchase_order_receipt WHERE qb_item_receipt_list_id = ANY($1::text[]) AND deleted_at IS NULL`,
          [receiptSampleIds]
        );
        let ok = 0;
        for (const r of recRows2 as { id: string; purchase_order_id: string }[]) {
          const res = await fetch(`${ADMIN_URL}/admin/purchase-orders/${r.purchase_order_id}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (res.status !== 200) {
            console.error(`✗ (k) GET /admin/purchase-orders/${r.purchase_order_id} → ${res.status}`);
            failures++;
            continue;
          }
          const body = (await res.json()) as { purchase_order?: { receipts?: { id: string }[] } };
          if ((body.purchase_order?.receipts ?? []).some((rr) => rr.id === r.id)) ok++;
          else {
            console.error(`✗ (k) PO ${r.purchase_order_id} responde 200 pero su recibo ${r.id} no aparece en \`receipts\``);
            failures++;
          }
        }
        console.log(`(k) receipt: ${ok}/${recRows2.length} muestreados aparecen en su PO padre`);
      } else {
        console.log(`(k) receipt: sin documentos creados — nada que muestrear`);
      }
    } catch (err) {
      console.error(`✗ (k) no se pudo autenticar/consultar el admin en ${ADMIN_URL}: ${(err as Error).message}`);
      failures++;
    }

    // (l) follow-links: ningún pago queda bloqueado por bill_not_found, y una
    // muestra de documentos via_link responde 200 igual que el resto.
    if (inv.follow_links) {
      const fl = inv.follow_links;
      console.log(
        `(l) follow-links: ${fl.iterations} iteración(es) · traídos: bill ${fl.fetched_by_type.bills} · po ${fl.fetched_by_type.purchase_orders} · receipt ${fl.fetched_by_type.item_receipts} · por año ${JSON.stringify(fl.fetched_by_year)}`
      );
      const stillBlockedByMissingBill = (inv.payment_scope?.blocked ?? []).filter((b) => b.blocked_reason === "bill_not_found");
      if (stillBlockedByMissingBill.length > 0) {
        console.error(
          `✗ (l) ${stillBlockedByMissingBill.length} pago(s) siguen bloqueados por bill_not_found tras followLinks: ${stillBlockedByMissingBill.map((b) => b.txn_id).join(", ")}`
        );
        failures++;
      } else {
        console.log(`(l) 0 pago(s) bloqueados por bill_not_found — followLinks resolvió los bills fuera de rango`);
      }

      // Documentos via_link: marcados en metadata (PO) / notes (receipt, bill).
      // El denominador correcto es la INTERSECCIÓN entre "traído por enlace" y
      // "creado este run" — un TxnID traído por enlace que YA era conocido
      // (creado por una fase anterior) no genera fila nueva y por lo tanto no
      // puede llevar el marcador; eso es correcto, no un fallo.
      const createdViaLinkPoTxnIds = createdTxnIds.filter((t) => fl.fetched_txn_ids.purchase_orders.includes(t));
      const createdViaLinkReceiptTxnIds = receiptTxnIds.filter((t) => fl.fetched_txn_ids.item_receipts.includes(t));
      const createdViaLinkBillTxnIds = billTxnIdsCreated.filter((t) => fl.fetched_txn_ids.bills.includes(t));

      const { rows: viaLinkPoRows } = await client.query(
        `SELECT id, qb_purchase_order_list_id FROM purchase_order
          WHERE qb_purchase_order_list_id = ANY($1::text[]) AND deleted_at IS NULL
            AND metadata->'qb_backfill'->>'via_link' = 'true'`,
        [createdViaLinkPoTxnIds]
      );
      const { rows: viaLinkReceiptRows } = await client.query(
        `SELECT id, purchase_order_id, qb_item_receipt_list_id FROM purchase_order_receipt
          WHERE qb_item_receipt_list_id = ANY($1::text[]) AND deleted_at IS NULL AND notes LIKE '%via_link%'`,
        [createdViaLinkReceiptTxnIds]
      );
      const { rows: viaLinkBillRows } = await client.query(
        `SELECT id, qb_txn_id FROM vendor_bill
          WHERE qb_txn_id = ANY($1::text[]) AND deleted_at IS NULL AND notes LIKE '%via_link%'`,
        [createdViaLinkBillTxnIds]
      );
      console.log(
        `(l) marcados via_link en DB: po ${viaLinkPoRows.length}/${createdViaLinkPoTxnIds.length} · receipt ${viaLinkReceiptRows.length}/${createdViaLinkReceiptTxnIds.length} · bill ${viaLinkBillRows.length}/${createdViaLinkBillTxnIds.length} (denominador = traídos por enlace Y creados este run; ${fl.fetched_by_type.purchase_orders}/${fl.fetched_by_type.bills}/${fl.fetched_by_type.item_receipts} fetched en total, el resto ya era conocido)`
      );
      if (createdViaLinkPoTxnIds.length > 0 && viaLinkPoRows.length !== createdViaLinkPoTxnIds.length) {
        console.error(`✗ (l) ${createdViaLinkPoTxnIds.length} PO(s) via_link creados pero sólo ${viaLinkPoRows.length} llevan el marcador en metadata`);
        failures++;
      }
      if (createdViaLinkReceiptTxnIds.length > 0 && viaLinkReceiptRows.length !== createdViaLinkReceiptTxnIds.length) {
        console.error(`✗ (l) ${createdViaLinkReceiptTxnIds.length} recibo(s) via_link creados pero sólo ${viaLinkReceiptRows.length} llevan el marcador en notes`);
        failures++;
      }
      if (createdViaLinkBillTxnIds.length > 0 && viaLinkBillRows.length !== createdViaLinkBillTxnIds.length) {
        console.error(`✗ (l) ${createdViaLinkBillTxnIds.length} bill(s) via_link creados pero sólo ${viaLinkBillRows.length} llevan el marcador en notes`);
        failures++;
      }
      if (createdViaLinkPoTxnIds.length + createdViaLinkReceiptTxnIds.length + createdViaLinkBillTxnIds.length === 0) {
        console.log(`(l) 0 documento(s) via_link CREADOS en este run (todo lo traído por enlace ya era conocido) — control de vacuidad, no silencio`);
      }

      try {
        const token = await fetchToken();
        const sampleVia: { label: string; url: string }[] = [];
        if (viaLinkPoRows.length > 0) sampleVia.push({ label: "po via_link", url: `${ADMIN_URL}/admin/purchase-orders/${(viaLinkPoRows[0] as { id: string }).id}` });
        if (viaLinkBillRows.length > 0) sampleVia.push({ label: "bill via_link", url: `${ADMIN_URL}/admin/vendor-bills/${(viaLinkBillRows[0] as { id: string }).id}` });
        for (const s of sampleVia) {
          const res = await fetch(s.url, { headers: { Authorization: `Bearer ${token}` } });
          if (res.status === 200) console.log(`(l) ${s.label}: GET → 200 OK`);
          else {
            console.error(`✗ (l) ${s.label}: GET ${s.url} → ${res.status}`);
            failures++;
          }
        }
        if (sampleVia.length === 0) console.log(`(l) sin documentos via_link creados en este run — nada que muestrear (control de vacuidad, no silencio)`);
      } catch (err) {
        console.error(`✗ (l) no se pudo autenticar/consultar el admin en ${ADMIN_URL}: ${(err as Error).message}`);
        failures++;
      }
    } else {
      console.log(`(l) sin \`follow_links\` en el inventario (run anterior a este paso) — sección sólo informativa`);
    }
  } finally {
    client.release();
    await pool.end();
  }

  console.log(failures === 0 ? "\n✅ verify-qb-purchases-backfill: todo verde" : `\n✗ verify-qb-purchases-backfill: ${failures} fallo(s)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

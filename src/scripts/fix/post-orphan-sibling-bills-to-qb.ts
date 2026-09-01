/**
 * post-orphan-sibling-bills-to-qb.ts
 *
 * Encola el BillAdd de los bills SECUNDARIOS (service/freight/tariff) que quedaron
 * confirmados sin documento en QuickBooks, y cuyo bill REGULAR ya vive alla.
 *
 * DRY-RUN POR DEFECTO. `APPLY=true` para encolar de verdad.
 *
 * ── POR QUE ESTE SCRIPT LE PREGUNTA A QUICKBOOKS ─────────────────────────────
 * Un `BillAdd` NO es idempotente: encolarlo dos veces mintea dos documentos. Que
 * nuestra base diga `qb_txn_id IS NULL` NO prueba que el Bill no exista alla — el
 * caso VB-1082/PO-1111 fue exactamente ese: QuickBooks devolvio `0x8004041C`
 * DESPUES de haber guardado el Bill, asi que el documento existia y nuestra fila
 * no se entero. Un contador cargandolo a mano produce lo mismo.
 *
 * Asi que antes de cada encolado se le pregunta a QuickBooks, con la MISMA query y
 * el MISMO matcher que usa el consolidator en produccion
 * (`purchase-operations.ts`): `/api/bills/query` por FECHA del documento — los
 * filtros por RefNumber contra este bridge dan `0x80040400` — y se matchea por
 * vendor ListID + (Memo o RefNumber).
 *
 * ── EL CONTROL POSITIVO NO ES OPCIONAL ───────────────────────────────────────
 * "QuickBooks no lo encontro" y "la query esta rota" producen EXACTAMENTE la misma
 * respuesta vacia, y una de las dos autoriza a crear un duplicado. Por eso primero
 * se consulta un bill que SI sabemos que esta en QuickBooks: si el control no lo
 * encuentra, el script ABORTA sin escribir nada. Sin ese control, un ausente es
 * una conclusion que no nos podemos permitir.
 *
 * ── LO QUE ESTE SCRIPT NO HACE ───────────────────────────────────────────────
 * No le pega al bridge para CREAR. Solo escribe la fila de pipeline; el poller que
 * ya corre en produccion despacha, igual que en un confirm normal. Y si encuentra
 * el Bill ya en QuickBooks NO encola: lo reporta con su TxnID, porque eso es una
 * reparacion de enlace (otra decision) y no un create.
 *
 *   ./node_modules/.bin/tsx src/scripts/fix/post-orphan-sibling-bills-to-qb.ts
 *   APPLY=true ONLY=VB-1072,VB-1071 ./node_modules/.bin/tsx src/scripts/fix/...
 */
import Knex from "knex";

import { bridgeFetch, pollRawOperationResult } from "../../lib/quickbooks/client/core";
import { enqueueQbVendorBillAdd } from "../../lib/purchase-orders/qb-vendor-bill-enqueue";

const APPLY = process.env.APPLY === "true";
const ONLY = (process.env.ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** Bill que SI esta en QuickBooks — el control positivo de la query. */
const CONTROL = {
  number: "VB-1061",
  ref: "V260717-C1",
  date: "2026-07-17",
  vendorListId: "800018B4-1621454061",
};

type Rec = Record<string, unknown>;
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;
const toRecords = (v: unknown): Rec[] =>
  Array.isArray(v) ? (v as Rec[]) : v && typeof v === "object" ? [v as Rec] : [];

function extractBillRets(raw: unknown): Rec[] {
  // El envelope varia por version del bridge; se camina defensivo y se normaliza
  // el *Ret, que puede venir como objeto suelto cuando hay uno solo.
  const seen: Rec[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (!node || typeof node !== "object" || depth > 8) return;
    const rec = node as Rec;
    if (rec.BillQueryRs) {
      seen.push(...toRecords((rec.BillQueryRs as Rec).BillRet));
    }
    for (const v of Object.values(rec)) walk(v, depth + 1);
  };
  walk(raw, 0);
  return seen;
}

/** MISMA regla que `matchExistingVendorBill` del consolidator. */
function matchBill(candidates: Rec[], vendorListId: string | null, ref: string | null, memo: string | null): Rec | null {
  return (
    candidates.find((c) => {
      const vendor = c.VendorRef as Rec | undefined;
      const sameVendor = !vendorListId || str(vendor?.ListID) === vendorListId;
      if (!sameVendor) return false;
      return (
        (!!memo && str(c.Memo) === memo) || (!!ref && str(c.RefNumber) === ref)
      );
    }) ?? null
  );
}

/**
 * ¿Existe REALMENTE en QuickBooks el Bill de este TxnID?
 *
 * Nuestra columna `qb_txn_id` es evidencia, no prueba: si el contador borro el
 * Bill del regular en QB Desktop, la columna sigue poblada y nosotros creeriamos
 * que el documento que absorbe a los hermanos esta alla cuando no esta. Es la
 * misma clase de duda que motiva el chequeo de los hermanos, aplicada al padre.
 */
async function billExistsByTxnId(txnId: string): Promise<boolean> {
  const op = await bridgeFetch("POST", "/api/bills/query", {
    txn_id: txnId,
    max_returned: 1,
  });
  const opId = (op as Rec | null)?.operationId;
  if (!opId) throw new Error(`BillQuery no devolvio operationId para ${txnId}`);
  const raw = await pollRawOperationResult(String(opId), () => {});
  const found = extractBillRets((raw as Rec | null)?.result ?? raw);
  return found.some((b) => str(b.TxnID) === txnId);
}

async function billsOnDate(date: string): Promise<Rec[]> {
  const op = await bridgeFetch("POST", "/api/bills/query", {
    from_date: date,
    to_date: date,
    max_returned: 200,
  });
  const opId = (op as Rec | null)?.operationId;
  if (!opId) throw new Error(`BillQuery no devolvio operationId para ${date}`);
  const raw = await pollRawOperationResult(String(opId), () => {});
  return extractBillRets((raw as Rec | null)?.result ?? raw);
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL es obligatoria");
  console.log(`\n=== post-orphan-sibling-bills-to-qb — ${APPLY ? "APPLY" : "DRY-RUN"} ===\n`);

  // ── Control positivo. Si esto falla, nada de lo de abajo significa nada. ────
  process.stdout.write(`Control positivo: buscando ${CONTROL.number} (${CONTROL.ref}) en QuickBooks... `);
  const controlHits = await billsOnDate(CONTROL.date);
  const controlMatch = matchBill(controlHits, CONTROL.vendorListId, CONTROL.ref, null);
  if (!controlMatch) {
    console.log("NO ENCONTRADO");
    console.error(
      `\n❌ ABORTADO: la query no encuentra un bill que SI existe en QuickBooks.\n` +
      `   Un "no existe" de esta query no es confiable, y sobre eso se crearia un duplicado.\n`
    );
    process.exit(2);
  }
  console.log(`OK (TxnID ${str(controlMatch.TxnID)}, ${controlHits.length} bills esa fecha)\n`);

  const knex = Knex({ client: "pg", connection: url, pool: { min: 0, max: 3 } });
  try {
    // Set re-resuelto EN VIVO, nunca una lista congelada: entre el preview y la
    // ejecucion el estado se mueve (esta misma tarde 6 regulares cambiaron).
    const rows = await knex.raw(
      `SELECT sib.id, sib.number, sib.bill_type, sib.reference_id,
              to_char(sib.document_date, 'YYYY-MM-DD') AS doc_date,
              sib.vendor_qb_list_id_snapshot AS vendor_list_id,
              reg.number AS regular_number, reg.status AS regular_status,
              reg.qb_txn_id AS regular_txn_id,
              COALESCE((SELECT SUM(l.qty * l.unit_cost_cents)::bigint
                          FROM vendor_bill_line l
                         WHERE l.vendor_bill_id = sib.id AND l.deleted_at IS NULL), 0) AS cents,
              (SELECT COUNT(*) FROM qb_vendor_bill_pipeline p
                WHERE p.vendor_bill_id = sib.id AND p.deleted_at IS NULL) AS pipe_rows
         FROM vendor_bill sib
         -- LEFT, no INNER: un bill secundario SIN purchase order no tiene ningun
         -- regular que lo apunte, y con INNER quedaba excluido por construccion.
         -- Son las comisiones de venta sueltas (VB-1132/1133) — su propio confirm
         -- es la luz verde, no hay par que esperar.
         LEFT JOIN vendor_bill reg
           ON reg.deleted_at IS NULL AND reg.bill_type = 'regular'
          AND sib.id IN (reg.service_vendor_bill_id, reg.freight_vendor_bill_id,
                         reg.tariff_vendor_bill_id)
        WHERE sib.deleted_at IS NULL
          AND sib.status = 'confirmed'
          AND sib.qb_txn_id IS NULL
          AND (
            -- (a) tiene regular: exige que este CONFIRMADO Y CREADO en QuickBooks
            (reg.id IS NOT NULL AND reg.status = 'synced' AND reg.qb_txn_id IS NOT NULL)
            -- (b) standalone: sin purchase order y sin regular que lo apunte.
            --     Nada lo va a disparar nunca, asi que va solo.
            OR (reg.id IS NULL AND sib.purchase_order_id IS NULL)
          )
        ORDER BY sib.document_date, sib.number`,
      []
    );

    type Row = {
      id: string; number: string; bill_type: string; reference_id: string | null;
      doc_date: string; vendor_list_id: string | null; regular_number: string | null;
      regular_status: string | null; cents: string | number; pipe_rows: string | number;
      regular_txn_id: string | null;
    };
    const all = (rows.rows as Row[]).filter(
      (r) => ONLY.length === 0 || ONLY.includes(r.number)
    );
    console.log(`Candidatos: ${all.length}${ONLY.length ? ` (filtrado por ONLY)` : ""}\n`);

    const byDate = new Map<string, Rec[]>();
    const regularAlive = new Map<string, boolean>();
    let queued = 0, already = 0, skipped = 0, queuedCents = 0;

    for (const r of all) {
      const usd = (Number(r.cents) / 100).toFixed(2);
      const label = `${r.number} ${r.bill_type} $${usd} (reg ${r.regular_number ?? 'standalone'})`;

      if (Number(r.pipe_rows) > 0) {
        console.log(`  SKIP  ${label} — ya tiene fila de pipeline`);
        skipped += 1;
        continue;
      }

      // PREMISA: el regular tiene que estar VIVO en QuickBooks, preguntado a QB.
      // Standalone (sin regular): no hay padre que verificar. Su confirm ES la
      // luz verde — la misma regla que aplica el confirm en produccion.
      if (r.regular_number && !r.regular_txn_id) {
        console.log(`  SKIP  ${label} — su regular no tiene TxnID`);
        skipped += 1;
        continue;
      }
      if (r.regular_txn_id && !regularAlive.has(r.regular_txn_id)) {
        regularAlive.set(r.regular_txn_id, await billExistsByTxnId(r.regular_txn_id));
      }
      if (r.regular_txn_id && !regularAlive.get(r.regular_txn_id)) {
        console.log(
          `  SKIP  ${label} — el regular ${r.regular_number} NO esta en QuickBooks` +
          ` (TxnID ${r.regular_txn_id} no resuelve). Postear el hermano lo dejaria huerfano alla.`
        );
        skipped += 1;
        continue;
      }

      if (!byDate.has(r.doc_date)) byDate.set(r.doc_date, await billsOnDate(r.doc_date));
      const hit = matchBill(byDate.get(r.doc_date)!, r.vendor_list_id, r.reference_id, null);
      if (hit) {
        console.log(
          `  YA EN QB  ${label} — TxnID ${str(hit.TxnID)} RefNumber ${str(hit.RefNumber)}\n` +
          `            NO se encola. Necesita reparacion de ENLACE, no un create.`
        );
        already += 1;
        continue;
      }

      if (!APPLY) {
        console.log(`  encolaria  ${label} — ausente en QB (${byDate.get(r.doc_date)!.length} bills esa fecha)`);
        queued += 1; queuedCents += Number(r.cents);
        continue;
      }

      const res = await enqueueQbVendorBillAdd(knex as never, r.id);
      if (res.queued) {
        console.log(`  ENCOLADO  ${label} — fila ${res.pipelineRowId}`);
        queued += 1; queuedCents += Number(r.cents);
      } else {
        console.log(`  FALLO     ${label} — ${res.reason}`);
        skipped += 1;
      }
    }

    console.log(
      `\n${APPLY ? "Encolados" : "Se encolarian"}: ${queued} ($${(queuedCents / 100).toFixed(2)})` +
      ` · ya en QB: ${already} · salteados: ${skipped}\n`
    );
    if (!APPLY) console.log("DRY-RUN — no se escribio nada. APPLY=true para ejecutar.\n");
  } finally {
    await knex.destroy();
  }
}

main().catch((err) => {
  console.error("post-orphan-sibling-bills-to-qb crashed:", err);
  process.exit(2);
});

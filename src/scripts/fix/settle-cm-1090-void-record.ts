/**
 * Registra el void de CM-1090, que ocurrió en QuickBooks por fuera del pipeline.
 *
 * QUE PASA
 * El credit memo CM-1090 ($164,63, 10-jul) figura `voided` en Medusa y su
 * documento QB 18984 TAMBIEN esta voideado: `TotalAmount 0.00`, memo
 * `VOID: POS Return CM-1090`. Los dos lados coinciden — no hay plata mal, no
 * hay nada que arreglar en QuickBooks.
 *
 * Lo unico que falta es la FILA DE PIPELINE que registre ese void. Alguien lo
 * voideo a mano en QuickBooks, asi que el pipeline nunca se entero.
 *
 * POR QUE IMPORTA
 * `jobs/qb-void-reconciler.ts` busca exactamente este patron —documento
 * voideado en Medusa + create confirmado + sin fila de void— y lo reporta cada
 * 15 minutos. Sin esta fila, CM-1090 aparece en el log para siempre.
 *
 * Y es el caso que PROBO que el reconciliador no puede auto-encolar: si lo
 * hubiera hecho, habria mandado un void contra un documento ya voideado. La
 * base de datos sola no distingue "nunca se voideo en QB" de "se voideo por
 * fuera". Por eso esta fila se escribe a mano, con la verificacion en vivo
 * contra QuickBooks como precondicion.
 *
 * QUE HACE
 * Inserta UNA fila `void_credit_memo` en estado `fixed` — el estado que este
 * pipeline usa para "esto ya esta resuelto, no lo despaches". NO toca
 * QuickBooks. NO toca el credit memo. Ninguna fila existente cambia.
 *
 * PRECONDICIONES — todas verificadas en runtime, ninguna asumida. Incluye una
 * lectura VIVA de QuickBooks: si el documento NO estuviera voideado alla, este
 * script aborta, porque entonces el diagnostico seria otro y la fila `fixed`
 * estaria tapando un problema real.
 *
 * Dry-run:
 *   env DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) \
 *     npx medusa exec ./src/scripts/fix/settle-cm-1090-void-record.ts
 * Apply:
 *   APPLY=1 env DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) \
 *     npx medusa exec ./src/scripts/fix/settle-cm-1090-void-record.ts
 */
import fs from "node:fs";
import path from "node:path";

import type { ExecArgs } from "@medusajs/framework/types";

import { getDbPool } from "../../api/utils/db-pool";

const APPLY = process.argv.includes("apply") || process.env.APPLY === "1";

const CM_ID = "01KX68RDW1D1WR3JQY7C8BCN32";
const CM_NUMBER = "CM-1090";
const QB_TXN_ID = "1C997D-1783695741";
const QB_REF_NUMBER = "18984";

const AUDIT = path.join(
  process.cwd(),
  "src/scripts/fix/settle-cm-1090-void-record.audit.jsonl"
);

class PreconditionError extends Error {}

function expect(condition: boolean, message: string): void {
  if (!condition) throw new PreconditionError(message);
}

/**
 * Lee el credit memo VIVO de QuickBooks. Es la precondicion que la DB no puede
 * contestar y la unica razon por la que este script es seguro: si el documento
 * NO estuviera voideado alla, escribir `fixed` seria esconder el problema.
 */
async function readCreditMemoFromQb(
  log: (m: string) => void
): Promise<{ refNumber: string | null; total: string | null; memo: string | null } | null> {
  const base = process.env.QB_BRIDGE_URL;
  const key = process.env.QB_API_KEY;
  if (!base || !key) {
    log("   QB_BRIDGE_URL / QB_API_KEY ausentes — no se puede verificar QB");
    return null;
  }
  const headers = { "x-api-key": key, "bypass-tunnel-reminder": "true" };
  const enqueue = await fetch(`${base}/api/credit-memos/${QB_TXN_ID}`, {
    headers,
  });
  const enqueued = (await enqueue.json()) as { operationId?: string };
  if (!enqueued.operationId) {
    throw new PreconditionError("el bridge no devolvio operationId");
  }
  for (let attempt = 0; attempt < 12; attempt++) {
    await new Promise((r) => setTimeout(r, 10_000));
    const res = await fetch(`${base}/api/sync/status/${enqueued.operationId}`, {
      headers,
    });
    const body = (await res.json()) as {
      operation?: { status?: string; result?: Record<string, any> };
    };
    const status = body.operation?.status;
    if (status === "failed") {
      throw new PreconditionError("la query del credit memo fallo en el bridge");
    }
    if (status !== "completed") continue;
    const qs =
      body.operation?.result?.QBXML?.QBXMLMsgsRs?.CreditMemoQueryRs ?? {};
    const ret = Array.isArray(qs.CreditMemoRet)
      ? qs.CreditMemoRet[0]
      : qs.CreditMemoRet;
    if (!ret) return null;
    return {
      refNumber: ret.RefNumber ?? null,
      total: ret.TotalAmount ?? null,
      memo: ret.Memo ?? null,
    };
  }
  throw new PreconditionError(
    "timeout esperando la query (QBWC no ciclo) — reintentar, NO asumir"
  );
}

export default async function settleCm1090({ container }: ExecArgs) {
  const logger = container.resolve("logger");
  const log = (m: string) => logger.info(m);
  const pool = getDbPool();

  log("");
  log(`=== Registrar el void de ${CM_NUMBER} (ocurrido fuera del pipeline) ===`);
  log(`Modo: ${APPLY ? "APPLY (escribe)" : "DRY-RUN (no escribe)"}`);
  log("");

  // ── Precondicion 1 · el credit memo en Medusa ───────────────────────────
  const { rows: cmRows } = await pool.query(
    `SELECT id, credit_memo_number, status, voided_at, qb_txn_id, total
       FROM pos_credit_memo WHERE id = $1`,
    [CM_ID]
  );
  const cm = cmRows[0];
  expect(!!cm, `no existe el pos_credit_memo ${CM_ID}`);
  expect(
    cm.credit_memo_number === CM_NUMBER,
    `numero esperado ${CM_NUMBER}, encontrado ${cm.credit_memo_number}`
  );
  expect(
    cm.status === "voided",
    `el credit memo debe estar 'voided', esta '${cm.status}'`
  );
  expect(
    cm.qb_txn_id === QB_TXN_ID,
    `qb_txn_id esperado ${QB_TXN_ID}, encontrado ${cm.qb_txn_id}`
  );
  log(`✓ ${CM_NUMBER} voided en Medusa · $${(Number(cm.total) / 100).toFixed(2)}`);

  // ── Precondicion 2 · el create confirmo ─────────────────────────────────
  const { rows: addRows } = await pool.query(
    `SELECT id, status, qb_txn_id FROM qb_order_pipeline
      WHERE reference_id = $1 AND step = 'credit_memo'`,
    [CM_ID]
  );
  expect(
    addRows.length === 1 && addRows[0].status === "confirmed",
    `se esperaba 1 fila 'credit_memo' confirmada, hay ${addRows.length} (${addRows[0]?.status})`
  );
  log(`✓ el create confirmo (fila ${addRows[0].id})`);

  // ── Precondicion 3 · no existe ya una fila de void ──────────────────────
  const { rows: voidRows } = await pool.query(
    `SELECT id, status FROM qb_order_pipeline
      WHERE reference_id = $1 AND step = 'void_credit_memo'`,
    [CM_ID]
  );
  expect(
    voidRows.length === 0,
    `ya existe una fila de void (${voidRows.map((r) => r.status).join(", ")})`
  );
  log("✓ no hay ninguna fila de void para esta referencia");

  // ── Precondicion 4 · el estado REAL en QuickBooks ───────────────────────
  log("… leyendo el credit memo vivo de QuickBooks (puede tardar ~1 min)");
  const qb = await readCreditMemoFromQb(log);
  expect(
    qb !== null,
    "QuickBooks no devolvio el credit memo — no se puede confirmar que este voideado"
  );
  expect(
    qb!.refNumber === QB_REF_NUMBER,
    `QB devolvio RefNumber ${qb!.refNumber}, se esperaba ${QB_REF_NUMBER}`
  );
  // LA precondicion. Si el total NO es 0, el documento sigue vivo en QB y esto
  // no es un registro faltante sino un void que nunca ocurrio: abortar.
  expect(
    Number(qb!.total) === 0,
    `el credit memo NO esta voideado en QB (TotalAmount ${qb!.total}) — ` +
      `esto no es un registro faltante, es un void pendiente: NO escribir 'fixed'`
  );
  log(
    `✓ QB ${qb!.refNumber}: TotalAmount ${qb!.total} · Memo "${qb!.memo}" → voideado`
  );

  // ── El plan ─────────────────────────────────────────────────────────────
  log("");
  log("PLAN — 1 fila nueva en qb_order_pipeline:");
  log(`   step              void_credit_memo`);
  log(`   status            fixed        (resuelto — el consolidator NO lo despacha)`);
  log(`   reference_id      ${CM_ID}   (credit_memo)`);
  log(`   qb_txn_id         ${QB_TXN_ID}`);
  log(`   qb_ref_number     ${QB_REF_NUMBER}`);
  log(`   medusa_ref_number ${CM_NUMBER}`);
  log("");
  log("Efecto: el reconciliador deja de reportar CM-1090. NADA se manda a QuickBooks.");
  log("");

  if (!APPLY) {
    log("DRY-RUN — no se escribio nada. Correr con APPLY=1 para aplicar.");
    return;
  }

  const { rows: inserted } = await pool.query(
    `INSERT INTO qb_order_pipeline
       (id, order_id, reference_id, reference_type, step, status,
        qb_txn_id, qb_ref_number, medusa_ref_number, error,
        created_at, updated_at)
     VALUES (gen_random_uuid(), NULL, $1, 'credit_memo', 'void_credit_memo',
             'fixed', $2, $3, $4,
             'Voideado directamente en QuickBooks, fuera del pipeline (verificado en vivo: TotalAmount 0.00, memo VOID:). Fila de registro — nunca se despacho ni se debe despachar.',
             NOW(), NOW())
     RETURNING id`,
    [CM_ID, QB_TXN_ID, QB_REF_NUMBER, CM_NUMBER]
  );

  fs.appendFileSync(
    AUDIT,
    JSON.stringify({
      at: new Date().toISOString(),
      action: "settle_out_of_band_void",
      rowId: inserted[0].id,
      creditMemoId: CM_ID,
      creditMemoNumber: CM_NUMBER,
      qbTxnId: QB_TXN_ID,
      qbSnapshot: qb,
    }) + "\n"
  );

  log(`✅ Fila de registro creada — id ${inserted[0].id} (status 'fixed')`);
}

/**
 * scan-reverse-void-prod.ts — corrida de validación READ-ONLY del reverse
 * void audit contra producción, con ventana ancha.
 *
 * Lee la DB de prod (candidatos) y QuickBooks vía bridge (queries), compara
 * con las MISMAS funciones exportadas que usa el job, y REPORTA. No persiste
 * hallazgos, no escribe en ninguna tabla, no manda nada a QB.
 *
 * Ventanas: TxnDeleted una sola op ancha (default 90 días); los scans de
 * voideados van en chunks de SCAN_CHUNK_DAYS (default 10) para no pisar el
 * MaxReturned=500 — un chunk truncado se reporta, nunca se ignora.
 *
 * Uso (desde backend/, con el DATABASE_URL de prod del .env):
 *   env DATABASE_URL="$(grep ^DATABASE_URL= .env|cut -d= -f2-)" \
 *     ./node_modules/.bin/tsx src/scripts/checks/scan-reverse-void-prod.ts
 * Knobs: DELETED_LOOKBACK_DAYS=90 ZERO_LOOKBACK_DAYS=30 SCAN_CHUNK_DAYS=10
 */
import { Pool } from "pg";

import {
  buildTxnDeletedQueryQbxml,
  buildZeroScanQbxml,
  compareScanToCandidates,
  loadAliveCandidates,
  parseTxnDeleted,
  parseZeroScan,
  type QbScanType,
  type ZeroDoc,
} from "../../lib/quickbooks/reverse-void-sweep";
import { bridgeFetch, pollBridgeStatus } from "../../lib/quickbooks/bridge-fetch";

const DELETED_LOOKBACK = Number(process.env.DELETED_LOOKBACK_DAYS || "90");
const ZERO_LOOKBACK = Number(process.env.ZERO_LOOKBACK_DAYS || "30");
const CHUNK = Number(process.env.SCAN_CHUNK_DAYS || "10");

const day = (offset: number) =>
  new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runQuery(qbxml: string): Promise<unknown> {
  const submit = await bridgeFetch<{ operationId?: string }>(
    "/api/sync/direct-query",
    { method: "POST", body: { qbxml }, timeoutMs: 30_000 }
  );
  if (!submit?.operationId) throw new Error("no operationId");
  for (let i = 0; i < 40; i++) {
    await sleep(6_000);
    const polled = await pollBridgeStatus(submit.operationId);
    if (polled.status === "completed") return polled.data;
    if (polled.status === "expired") throw new Error(`op ${submit.operationId} expired`);
    if (polled.status === "failed") {
      const err = (polled.data as any)?.operation?.error;
      if (err) throw new Error(`op failed: ${String(err).slice(0, 200)}`);
    }
  }
  throw new Error("op did not complete");
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const candidates = await loadAliveCandidates(pool);
  console.log(`candidatos vivos con TxnID: ${candidates.size}`);

  console.log(`\nTxnDeletedQuery ${day(DELETED_LOOKBACK)} → ${day(0)} …`);
  const deleted = parseTxnDeleted(
    await runQuery(buildTxnDeletedQueryQbxml(day(DELETED_LOOKBACK), day(0)))
  );
  console.log(`  borrados en QB en la ventana: ${deleted.length}`);
  for (const d of deleted) {
    const hit = candidates.get(d.qb_txn_id);
    console.log(
      `    ${d.qb_del_type} ${d.qb_txn_id} borrado ${d.time_deleted ?? "?"}` +
        (hit ? `  ⟵ REFERENCIADO por ${hit.entity} ${hit.medusa_ref}` : "  (no referenciado)")
    );
  }

  const zeroDocs: ZeroDoc[] = [];
  for (const scanType of ["Invoice", "SalesReceipt", "CreditMemo"] as QbScanType[]) {
    for (let hi = ZERO_LOOKBACK; hi > 0; hi -= CHUNK) {
      const lo = Math.max(hi - CHUNK, 0);
      const from = day(hi);
      const to = day(lo);
      const scan = parseZeroScan(
        await runQuery(buildZeroScanQbxml(scanType, from, to)),
        scanType
      );
      console.log(
        `  ${scanType} ${from}→${to}: ${scan.scanned} docs, ${scan.zeroDocs.length} en cero` +
          (scan.truncated ? "  ⚠ TRUNCADO — achicar SCAN_CHUNK_DAYS" : "")
      );
      zeroDocs.push(...scan.zeroDocs);
    }
  }

  const findings = compareScanToCandidates({ candidates, deleted, zeroDocs });

  console.log(`\n══ HALLAZGOS: ${findings.length} ══`);
  for (const f of findings) {
    console.log(
      `  ${f.kind.toUpperCase()} — ${f.doc_type} ${f.medusa_ref} ` +
        `($${(f.pos_total_cents / 100).toFixed(2)}) txn ${f.qb_txn_id} ` +
        `evento QB: ${f.qb_time_event ?? "?"}`
    );
  }

  // Controles esperados de esta corrida (documentados en el plan):
  const c19659 = findings.some((f) => f.qb_txn_id === "1CBDFD-1785515477");
  console.log(
    `\ncontrol: 19659 (doc viejo de la 21281, voideado, ya no referenciado) ` +
      `${c19659 ? "❌ FLAGGEÓ — revisar comparator" : "✅ no flaggea"}`
  );

  await pool.end();
  console.log("\nread-only scan terminado — nada fue escrito en ningún lado.");
}

main().catch((e) => {
  console.error("scan crashed:", e);
  process.exit(1);
});

/**
 * e2e-reverse-void-audit-sandbox.ts
 *
 * Prueba el camino compare → persist → render del reverse void audit contra un
 * Postgres REAL (sandbox). El SQL de candidatos, el upsert por constraint y el
 * render de la sección son los sujetos del test — un pool falso no prueba nada
 * de eso. El fetch al bridge queda FUERA a propósito: QB está apagado en el
 * sandbox por diseño, y la forma de la respuesta ya se sondeó en vivo contra
 * prod (2026-08-07) — acá el scan entra sintético.
 *
 * Llama a las funciones EXPORTADAS por la lib, nunca a una copia.
 *
 * Controles:
 *  - positivo: un invoice VIVO real del sandbox flaggea al aparecer borrado y
 *    voideado en el scan sintético, y persiste con upsert idempotente.
 *  - negativo: un TxnID no referenciado y un doc POS-voided NO flaggean.
 *  - resolución: stampear resolved_at lo saca de la sección del digest.
 *
 * Uso (NUNCA contra producción — aborta si la URL no es la del sandbox):
 *   env DATABASE_URL="postgres://postgres:sandbox@127.0.0.1:5499/medusa" \
 *     ./node_modules/.bin/tsx src/scripts/tests/e2e-reverse-void-audit-sandbox.ts
 */
import { readFileSync } from "fs";
import { resolve } from "path";

import { Pool } from "pg";

import {
  compareScanToCandidates,
  loadAliveCandidates,
  persistFindings,
} from "../../lib/quickbooks/reverse-void-sweep";
import { collectReverseVoidSection } from "../../jobs/_lib/_qb-reverse-void-section";

const url = process.env.DATABASE_URL ?? "";
if (!/127\.0\.0\.1:5499|localhost:5499/.test(url)) {
  console.error("ABORT: DATABASE_URL no es el sandbox (5499). No se corre.");
  process.exit(1);
}

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

async function main() {
  const pool = new Pool({ connectionString: url });
  const knexShim = { raw: (sql: string) => pool.query(sql) };
  const logger = { info: () => {}, warn: (m: string) => console.log(`  [warn] ${m}`) };

  // La migración real, aplicada al sandbox (idempotente por IF NOT EXISTS).
  const migrationSrc = readFileSync(
    resolve(__dirname, "../../migrations/1782300000000-CreateQbReverseVoidFinding.ts"),
    "utf8"
  );
  for (const m of migrationSrc.matchAll(/queryRunner\.query\(`([\s\S]*?)`\)/g)) {
    if (!/DROP TABLE/i.test(m[1])) await pool.query(m[1]);
  }

  await pool.query(`DELETE FROM qb_reverse_void_finding WHERE medusa_ref LIKE 'E2E-%' OR TRUE`);

  // ── candidatos reales del sandbox ─────────────────────────────────────────
  const candidates = await loadAliveCandidates(pool);
  check("loadAliveCandidates devuelve candidatos del sandbox", candidates.size > 100, `${candidates.size} docs vivos con TxnID`);

  const alive = [...candidates.values()].find(
    (c) => c.entity === "pos_invoice" && c.pos_total_cents > 0
  );
  if (!alive) throw new Error("no hay invoice viva con total > 0 en el sandbox");

  // Un doc POS-voided NO debe estar entre los candidatos.
  const voided = await pool.query(
    `SELECT COALESCE(NULLIF(metadata->>'qb_txn_id',''), '') AS txn
       FROM pos_invoice WHERE status = 'voided' AND metadata->>'qb_txn_id' IS NOT NULL LIMIT 1`
  );
  if (voided.rows[0]?.txn) {
    check(
      "un invoice POS-voided no es candidato (no puede flaggear)",
      !candidates.has(voided.rows[0].txn)
    );
  }

  // ── compare: controles positivo y negativo ────────────────────────────────
  const findings = compareScanToCandidates({
    candidates,
    deleted: [
      { qb_txn_id: alive.qb_txn_id, qb_del_type: "Invoice", time_deleted: "2026-08-06T15:38:08-05:00" },
      { qb_txn_id: "E2E-UNREFERENCED-TXN", qb_del_type: "Invoice", time_deleted: null },
    ],
    zeroDocs: [
      {
        qb_txn_id: alive.qb_txn_id,
        qb_ref_number: alive.qb_ref_number,
        memo: `VOID: POS Invoice ${alive.medusa_ref}`,
        time_modified: "2026-08-05T13:23:10-05:00",
        scan_type: "Invoice",
      },
    ],
  });
  check("control positivo: el invoice vivo flaggea deleted Y voided", findings.length === 2);
  check(
    "control negativo: el TxnID no referenciado no flaggea",
    !findings.some((f) => f.qb_txn_id === "E2E-UNREFERENCED-TXN")
  );

  // ── persist: upsert real contra el constraint real ────────────────────────
  const first = await persistFindings(pool, findings);
  check("persist inserta las filas nuevas", first.inserted === 2 && first.refreshed === 0);
  const second = await persistFindings(pool, findings);
  check("re-persist es idempotente (refresca, no duplica)", second.inserted === 0 && second.refreshed === 2);
  const count = await pool.query(
    `SELECT count(*)::int AS n FROM qb_reverse_void_finding WHERE qb_txn_id = $1`,
    [alive.qb_txn_id]
  );
  check("una fila por (txn, kind)", count.rows[0].n === 2);

  // ── render de la sección del digest ───────────────────────────────────────
  const section = await collectReverseVoidSection(knexShim, logger);
  check("la sección del digest renderiza los hallazgos", (section?.rows.length ?? 0) === 2);
  check(
    "la fila nombra el documento y el monto",
    section?.rows.every((r) => r.medusa_ref === alive.medusa_ref && /\$\d/.test(r.error)) ?? false
  );

  // ── resolución humana lo saca del digest ──────────────────────────────────
  await pool.query(
    `UPDATE qb_reverse_void_finding SET resolved_at = now(), resolved_note = 'E2E' WHERE qb_txn_id = $1 AND kind = 'deleted'`,
    [alive.qb_txn_id]
  );
  const after = await collectReverseVoidSection(knexShim, logger);
  check("resolved_at saca la fila de la sección", (after?.rows.length ?? 0) === 1);

  // limpieza
  await pool.query(`DELETE FROM qb_reverse_void_finding`);
  await pool.end();

  console.log(`\n${failed === 0 ? "OK" : "FAILED"} — ${passed} pass / ${failed} fail`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("E2E crashed:", e);
  process.exit(1);
});

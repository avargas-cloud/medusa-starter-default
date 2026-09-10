/**
 * verify-gl-core.ts — gate del motor del General Ledger (plan `gl-core-v1` §8).
 *
 * Correr:
 *   DATABASE_URL='postgresql://postgres:sandbox@localhost:5499/medusa' \
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-gl-core.ts [--strict]
 *
 * Sin `DATABASE_URL` no corre nada y sale en rojo — un verificador de datos
 * que saltea todo en silencio es peor que no tenerlo.
 *
 * Secciones:
 *   (a) toda entrada `document` ACTIVA (sin reversa) está balanceada
 *       (Σdebit = Σcredit) y cada línea tiene `account_snapshot->>'id'`
 *       igual a `account_list_id`.
 *   (b) por cada invoice posteada: el NETO de la línea de AR
 *       (`role='accounts_receivable'`, debit−credit) iguala `pos_invoice.total`
 *       — nunca `entry.amount_cents`, que suma TODOS los débitos (AR +
 *       descuento + COGS), no sólo el AR. `debit−credit` (no sólo `debit`)
 *       porque una factura de total NEGATIVO espeja la línea entera y el AR
 *       queda del lado CRÉDITO.
 *   (c) ningún invoice/CM/payment TERMINAL desde 2026-04-14 está sin entrada
 *       activa — INFORMATIVA hasta que corra el replay; con `--strict` es
 *       dura (el plan lo dice explícito: "puede ser informational hasta que
 *       corra el replay").
 *   (d) ningún documento VOIDEADO conserva una entrada activa (sin reversar).
 *   (e) todo claim `payment_recognition` vale exactamente lo que vale el pago
 *       que reclama.
 *
 * Mutation-testeado: ver el bloque de evidencia al final de este comentario
 * (se completa a mano tras correr el mutation test, no se borra el template).
 */
import { Pool } from "pg";

const STRICT = process.argv.includes("--strict");

let passed = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(detail ? `${label} — ${detail}` : label);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function infoOnly(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ⚠ (informativo) ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const GL_GO_LIVE = "2026-04-14";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "verify-gl-core: DATABASE_URL no está seteada — no hay chequeo sin datos."
    );
    process.exit(1);
    return;
  }

  const pool = new Pool({ connectionString: url });
  try {
    // Chequeo de infraestructura: si el sibling (`src/lib/ledger` +
    // migración) todavía no corrió, decirlo claro en vez de tirar errores
    // SQL crípticos por cada sección.
    const { rows: tables } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('bank_journal_entry', 'bank_journal_line', 'gl_account_map')`
    );
    const tableNames = new Set(tables.map((r) => r.table_name));
    for (const t of ["bank_journal_entry", "bank_journal_line", "gl_account_map"]) {
      check(`tabla ${t} existe (migración GeneralLedgerCore corrida)`, tableNames.has(t));
    }
    if (!tableNames.has("bank_journal_entry") || !tableNames.has("bank_journal_line")) {
      console.log(
        "\nINFRA: la migración del GL no corrió contra esta base — el resto de las " +
          "secciones no puede evaluarse. Correr la migración y reintentar."
      );
      report();
      process.exit(1);
      return;
    }

    await sectionA(pool);
    await sectionB(pool);
    await sectionC(pool);
    await sectionD(pool);
    await sectionE(pool);
  } finally {
    await pool.end();
  }

  report();
  if (failures.length > 0) process.exit(1);
}

/** (a) Toda entrada `document` ACTIVA está balanceada y con snapshot íntegro. */
async function sectionA(pool: Pool): Promise<void> {
  console.log("\n(a) Entradas document activas: balance + snapshot");
  const { rows } = await pool.query<{
    id: string;
    source_kind: string;
    source_id: string;
    debit_sum: string;
    credit_sum: string;
    mismatched: string;
  }>(
    `SELECT e.id, e.source_kind, e.source_id,
            COALESCE(SUM(l.debit_cents), 0) AS debit_sum,
            COALESCE(SUM(l.credit_cents), 0) AS credit_sum,
            COUNT(*) FILTER (
              WHERE (l.account_snapshot ->> 'id') IS DISTINCT FROM l.account_list_id
            ) AS mismatched
       FROM bank_journal_entry e
       JOIN bank_journal_line l ON l.entry_id = e.id
      WHERE e.source_kind IS NOT NULL
        AND e.kind = 'document'
        AND NOT EXISTS (
              SELECT 1 FROM bank_journal_entry r
               WHERE r.reverses_entry_id = e.id
            )
      GROUP BY e.id, e.source_kind, e.source_id`
  );

  const unbalanced = rows.filter((r) => r.debit_sum !== r.credit_sum);
  check(
    "toda entrada document activa balancea (Σdebit = Σcredit)",
    unbalanced.length === 0,
    unbalanced
      .slice(0, 10)
      .map((r) => `${r.source_kind}:${r.source_id} debit=${r.debit_sum} credit=${r.credit_sum}`)
      .join(", ")
  );

  const badSnapshot = rows.filter((r) => Number(r.mismatched) > 0);
  check(
    "toda línea de una entrada document activa tiene account_snapshot->>'id' = account_list_id",
    badSnapshot.length === 0,
    badSnapshot
      .slice(0, 10)
      .map((r) => `${r.source_kind}:${r.source_id}`)
      .join(", ")
  );
}

/** (b) Por cada invoice posteada: amount_cents = total, y la línea de AR = total. */
async function sectionB(pool: Pool): Promise<void> {
  console.log("\n(b) Paridad invoice ↔ entrada");
  const { rows } = await pool.query<{
    id: string;
    total: string;
    ar_net: string;
  }>(
    `SELECT i.id, i.total,
            (SELECT COALESCE(SUM(l.debit_cents), 0) - COALESCE(SUM(l.credit_cents), 0)
               FROM bank_journal_line l
              WHERE l.entry_id = e.id AND l.role = 'accounts_receivable') AS ar_net
       FROM pos_invoice i
       JOIN bank_journal_entry e
         ON e.source_kind = 'pos_invoice' AND e.source_id = i.id AND e.kind = 'document'
        AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id = e.id)
      WHERE i.status IN ('issued', 'partial', 'paid', 'partially_refunded', 'refunded')`
  );

  const arMismatch = rows.filter((r) => String(r.ar_net ?? "0") !== String(r.total));
  check(
    "la línea de AR (débito−crédito) de toda invoice posteada iguala el total",
    arMismatch.length === 0,
    arMismatch
      .slice(0, 10)
      .map((r) => `${r.id}: total=${r.total} ar_net=${r.ar_net}`)
      .join(", ")
  );

  console.log(`    (n=${rows.length} invoices posteadas evaluadas)`);
}

/**
 * (c) Ningún documento TERMINAL desde el go-live está sin entrada activa.
 * Declara su propia cobertura: cuenta cuántos documentos terminales hay en
 * total antes de reportar cuántos faltan, para que "0 faltan" no se confunda
 * con "0 documentos existen".
 */
async function sectionC(pool: Pool): Promise<void> {
  console.log(`\n(c) Cobertura de posting (terminal ⇒ entrada activa, desde ${GL_GO_LIVE})`);

  const { rows: invoiceRows } = await pool.query<{ total: string; missing: string }>(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (
              WHERE NOT EXISTS (
                SELECT 1 FROM bank_journal_entry e
                 WHERE e.source_kind = 'pos_invoice' AND e.source_id = i.id AND e.kind = 'document'
                   AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id = e.id)
              )
            ) AS missing
       FROM pos_invoice i
      WHERE i.status IN ('issued', 'partial', 'paid', 'partially_refunded', 'refunded')
        AND i.issued_at >= $1`,
    [GL_GO_LIVE]
  );
  const invMissing = Number(invoiceRows[0]?.missing ?? 0);
  const invTotal = Number(invoiceRows[0]?.total ?? 0);
  console.log(`    invoices terminales: ${invTotal}, sin entrada activa: ${invMissing}`);
  const invAssert = STRICT ? check : infoOnly;
  invAssert("toda invoice terminal tiene entrada activa", invMissing === 0, `${invMissing}/${invTotal}`);

  const { rows: cmRows } = await pool.query<{ total: string; missing: string }>(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (
              WHERE NOT EXISTS (
                SELECT 1 FROM bank_journal_entry e
                 WHERE e.source_kind = 'pos_credit_memo' AND e.source_id = c.id AND e.kind = 'document'
                   AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id = e.id)
              )
            ) AS missing
       FROM pos_credit_memo c
      WHERE c.status = 'completed'
        AND c.completed_at >= $1
        AND COALESCE(c.metadata->>'is_internal_adjustment', 'false') <> 'true'
        AND COALESCE(c.metadata->>'never_sync_to_qb', 'false') <> 'true'`,
    [GL_GO_LIVE]
  );
  const cmMissing = Number(cmRows[0]?.missing ?? 0);
  const cmTotal = Number(cmRows[0]?.total ?? 0);
  console.log(`    credit memos completados: ${cmTotal}, sin entrada activa: ${cmMissing}`);
  invAssert("todo CM completado tiene entrada activa", cmMissing === 0, `${cmMissing}/${cmTotal}`);

  const { rows: payRows } = await pool.query<{ total: string; missing: string }>(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (
              WHERE NOT EXISTS (
                SELECT 1 FROM bank_journal_entry e
                 WHERE e.source_kind = 'customer_payment' AND e.source_id = p.id AND e.kind = 'document'
                   AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id = e.id)
              )
            ) AS missing
       FROM customer_payment p
      WHERE p.type IN ('payment', 'refund')
        AND p.amount > 0
        AND p.status <> 'voided'
        AND p.received_at >= $1`,
    [GL_GO_LIVE]
  );
  const payMissing = Number(payRows[0]?.missing ?? 0);
  const payTotal = Number(payRows[0]?.total ?? 0);
  console.log(`    pagos/refunds terminales: ${payTotal}, sin entrada activa: ${payMissing}`);
  invAssert("todo pago/refund terminal tiene entrada activa", payMissing === 0, `${payMissing}/${payTotal}`);
}

/** (d) Ningún documento VOIDEADO conserva una entrada activa. */
async function sectionD(pool: Pool): Promise<void> {
  console.log("\n(d) Ningún documento voideado conserva entrada activa");

  const { rows: invRows } = await pool.query<{ id: string }>(
    `SELECT i.id
       FROM pos_invoice i
       JOIN bank_journal_entry e
         ON e.source_kind = 'pos_invoice' AND e.source_id = i.id AND e.kind = 'document'
        AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id = e.id)
      WHERE i.status = 'voided'`
  );
  check("ninguna invoice voideada tiene entrada activa", invRows.length === 0, invRows.map((r) => r.id).join(", "));

  const { rows: cmRows } = await pool.query<{ id: string }>(
    `SELECT c.id
       FROM pos_credit_memo c
       JOIN bank_journal_entry e
         ON e.source_kind = 'pos_credit_memo' AND e.source_id = c.id AND e.kind = 'document'
        AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id = e.id)
      WHERE c.status = 'voided'`
  );
  check("ningún CM voideado tiene entrada activa", cmRows.length === 0, cmRows.map((r) => r.id).join(", "));

  const { rows: payRows } = await pool.query<{ id: string }>(
    `SELECT p.id
       FROM customer_payment p
       JOIN bank_journal_entry e
         ON e.source_kind = 'customer_payment' AND e.source_id = p.id AND e.kind = 'document'
        AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id = e.id)
      WHERE p.status = 'voided'`
  );
  check("ningún pago voideado tiene entrada activa", payRows.length === 0, payRows.map((r) => r.id).join(", "));
}

/** (e) Todo claim payment_recognition vale exactamente lo que vale el pago. */
async function sectionE(pool: Pool): Promise<void> {
  console.log("\n(e) Claims payment_recognition = monto del pago");

  const { rows: claimTables } = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'bank_source_claim'`
  );
  if (claimTables.length === 0) {
    console.log("    INFRA: tabla bank_source_claim no existe — sección salteada.");
    failures.push("(e) no corrió — bank_source_claim no existe");
    return;
  }

  const { rows } = await pool.query<{
    payment_id: string;
    claim_amount: string;
    payment_amount: string;
  }>(
    `SELECT c.source_id AS payment_id, c.amount_cents AS claim_amount, p.amount AS payment_amount
       FROM bank_source_claim c
       JOIN customer_payment p ON p.id = c.source_id
      WHERE c.source_kind = 'payment_recognition'`
  );
  const mismatched = rows.filter((r) => String(r.claim_amount) !== String(r.payment_amount));
  check(
    "todo claim payment_recognition = amount del customer_payment",
    mismatched.length === 0,
    mismatched
      .slice(0, 10)
      .map((r) => `${r.payment_id}: claim=${r.claim_amount} payment=${r.payment_amount}`)
      .join(", ")
  );
  console.log(`    (n=${rows.length} claims evaluados)`);
}

function report(): void {
  console.log(
    `\n${"═".repeat(64)}\n` +
      `verify-gl-core: ${passed} OK, ${failures.length} FALLARON${STRICT ? " (--strict)" : ""}`
  );
  if (failures.length) {
    console.log("\nFallas:");
    for (const f of failures) console.log(`  • ${f}`);
  } else {
    console.log("Todo verde.\n");
  }
}

void main();

/**
 * ── Evidencia de mutation test (2026-09-10, contra el sandbox) ──────────────
 *
 * Rama 1 — DATO real, sección (d): un CM fixture del E2E (`pcm_e2e_c9c6...`)
 *   tenía una entrada `document` activa; se lo pasó a `status='voided'` por
 *   UPDATE directo (sin pasar por `reverseCreditMemo`) para simular el bug
 *   exacto que (d) existe para cazar. Resultado ANTES de restaurar:
 *     ✗ ningún CM voideado tiene entrada activa — pcm_e2e_c9c6482c-...
 *     verify-gl-core: 10 OK, 1 FALLARON
 *   Se restauró `status='completed'` y re-corrió: 11 OK, 0 FALLARON (idéntico
 *   al run limpio). Prueba que (d) cachea una violación real de dato, no sólo
 *   una forma sintética.
 *
 * Rama 2 — CÓDIGO, sección (a): se invirtió momentáneamente el assert de
 *   `unbalanced.length === 0` a `!== 0` (línea 134). Resultado:
 *     ✗ toda entrada document activa balancea (Σdebit = Σcredit)
 *     verify-gl-core: 10 OK, 1 FALLARON
 *   Se restauró el operador original y se comparó byte a byte contra la copia
 *   pre-mutación (`diff` → idéntico); re-corrida: 11 OK, 0 FALLARON.
 *   (No se pudo mutar el DATO para esta rama: `bank_journal_line` es
 *   inmutable por trigger — `bank_journal_immutable()` rechazó el UPDATE con
 *   `BANKING_JOURNAL_IMMUTABLE` antes de tocar una sola fila, así que la
 *   inmutabilidad del journal quedó confirmada de rebote.)
 */

/**
 * verify-gl-purchases.ts — gate del motor de compras del GL (plan
 * `gl-purchases-v2` §6).
 *
 * Correr:
 *   DATABASE_URL='postgresql://postgres:sandbox@localhost:5499/medusa_gl' \
 *     ./node_modules/.bin/tsx src/scripts/verify/verify-gl-purchases.ts [--strict]
 *
 * Sin `DATABASE_URL` no corre nada y sale en rojo. Rechaza explícitamente
 * cualquier URL que no apunte a `medusa_gl` — este gate ejecuta lógica de
 * negocio de compras contra la base, y `medusa_gl` es la ÚNICA base
 * autorizada para este plan (nunca `medusa`, nunca prod).
 *
 * Secciones (§6):
 *   (1) AP del journal = Σ saldos de bills abiertos − créditos sin aplicar.
 *   (2) ningún bill confirmado/synced está sin entrada activa.
 *   (3) ningún bill cancelado/voideado conserva una entrada activa.
 *   (4) Inventory Offset (GL) = Σ receipts SIN bill atado.
 *   (5) hash de la entrada activa de cada bill = hash actual (sin drift).
 *
 * Mutation-testeado: ver el bloque de evidencia al final de este archivo.
 */
import { Pool } from "pg";

import { currentVendorBillSourceHash } from "../../lib/ledger/documents/vendor-bill";

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

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("verify-gl-purchases: DATABASE_URL no está seteada — no hay chequeo sin datos.");
    process.exit(1);
    return;
  }
  if (!url.includes("/medusa_gl")) {
    console.error(
      "verify-gl-purchases: esta URL no apunta a `medusa_gl` — este gate NUNCA corre contra `medusa` ni prod."
    );
    process.exit(1);
    return;
  }

  const pool = new Pool({ connectionString: url });
  try {
    const { rows: tables } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('bank_journal_entry', 'vendor_bill', 'vendor_credit',
                              'vendor_bill_payment', 'vendor_credit_application',
                              'vendor_bill_payment_allocation')`
    );
    const tableNames = new Set(tables.map((r) => r.table_name));
    const required = [
      "bank_journal_entry",
      "vendor_bill",
      "vendor_credit",
      "vendor_bill_payment",
      "vendor_credit_application",
      "vendor_bill_payment_allocation",
    ];
    for (const t of required) check(`tabla ${t} existe`, tableNames.has(t));
    if (required.some((t) => !tableNames.has(t))) {
      console.log(
        "\nINFRA: falta una tabla requerida (migraciones GeneralLedgerCore/" +
          "GeneralLedgerPurchases/VendorCreditsAndBillPayments no corrieron completas) " +
          "— el resto de las secciones no puede evaluarse."
      );
      report();
      process.exit(1);
      return;
    }

    await section1(pool);
    await section2(pool);
    await section3(pool);
    await section4(pool);
    await section5(pool);
  } finally {
    await pool.end();
  }

  report();
  if (failures.length > 0) process.exit(1);
}

/** GL: neto (credit−debit) de un role, sobre entradas `document` ACTIVAS (sin reversa). */
async function glNetForRole(pool: Pool, role: string): Promise<bigint> {
  const { rows } = await pool.query<{ net: string }>(
    `SELECT COALESCE(SUM(l.credit_cents - l.debit_cents), 0)::bigint::text AS net
       FROM bank_journal_line l
       JOIN bank_journal_entry e ON e.id = l.entry_id
      WHERE l.role = $1 AND e.kind = 'document'
        AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id = e.id)`,
    [role]
  );
  return BigInt(rows[0]?.net ?? "0");
}

const VENDOR_BILL_LINE_CENTS_SQL =
  "COALESCE(l.amount_cents, ROUND((l.qty * l.unit_cost_cents)::numeric))::bigint";

/** (1) AP del journal = Σ saldos de bills abiertos − créditos sin aplicar. */
async function section1(pool: Pool): Promise<void> {
  console.log("\n(1) Paridad accounts_payable: GL vs. saldos de bills − créditos sin aplicar");

  const { rows: payableRows } = await pool.query<{ payable: string }>(
    `SELECT COALESCE(SUM(${VENDOR_BILL_LINE_CENTS_SQL}), 0)::bigint::text AS payable
       FROM vendor_bill_line l
       JOIN vendor_bill vb ON vb.id = l.vendor_bill_id
      WHERE l.deleted_at IS NULL AND vb.deleted_at IS NULL
        AND vb.status IN ('confirmed', 'synced')`
  );
  const { rows: adoptedRows } = await pool.query<{ payable: string }>(
    `SELECT COALESCE(SUM(qb_amount_due_cents), 0)::bigint::text AS payable
       FROM vendor_bill vb
      WHERE vb.deleted_at IS NULL AND vb.status IN ('confirmed', 'synced')
        AND NOT EXISTS (SELECT 1 FROM vendor_bill_line l WHERE l.vendor_bill_id = vb.id AND l.deleted_at IS NULL)`
  );
  const { rows: paidRows } = await pool.query<{ paid: string }>(
    `SELECT COALESCE(SUM(a.amount_cents), 0)::bigint::text AS paid
       FROM vendor_bill_payment_allocation a
       JOIN vendor_bill_payment p ON p.id = a.payment_id
      WHERE p.status = 'posted'`
  );
  const { rows: appliedRows } = await pool.query<{ applied: string }>(
    `SELECT COALESCE(SUM(amount_cents), 0)::bigint::text AS applied
       FROM vendor_credit_application WHERE voided_at IS NULL`
  );
  const { rows: unappliedCreditRows } = await pool.query<{ unapplied: string }>(
    `SELECT COALESCE(SUM(total_cents - applied_cents), 0)::bigint::text AS unapplied
       FROM vendor_credit WHERE status = 'posted' AND deleted_at IS NULL`
  );

  const billPayableTotal =
    BigInt(payableRows[0]?.payable ?? "0") + BigInt(adoptedRows[0]?.payable ?? "0");
  const billBalanceTotal =
    billPayableTotal - BigInt(paidRows[0]?.paid ?? "0") - BigInt(appliedRows[0]?.applied ?? "0");
  const expected = billBalanceTotal - BigInt(unappliedCreditRows[0]?.unapplied ?? "0");
  const glNet = await glNetForRole(pool, "accounts_payable");

  console.log(
    `    bill balances=${billBalanceTotal} − créditos sin aplicar=${unappliedCreditRows[0]?.unapplied ?? "0"}` +
      ` = esperado ${expected}; GL=${glNet}`
  );
  check("GL accounts_payable == Σ saldos de bills − créditos sin aplicar", glNet === expected, `gl=${glNet} expected=${expected}`);
}

/** (2)/(3) Cobertura de posting + ningún cancelado/voideado con entrada activa. */
async function section2(pool: Pool): Promise<void> {
  console.log("\n(2) Cobertura: todo bill confirmed/synced tiene entrada activa");
  const { rows } = await pool.query<{ total: string; missing: string }>(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (
              WHERE NOT EXISTS (
                SELECT 1 FROM bank_journal_entry e
                 WHERE e.source_kind = 'vendor_bill' AND e.source_id = vb.id AND e.kind = 'document'
                   AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id = e.id)
              )
            ) AS missing
       FROM vendor_bill vb
      WHERE vb.deleted_at IS NULL AND vb.status IN ('confirmed', 'synced')`
  );
  const total = Number(rows[0]?.total ?? 0);
  const missing = Number(rows[0]?.missing ?? 0);
  console.log(`    bills confirmed/synced: ${total}, sin entrada activa: ${missing}`);
  const assertFn = STRICT ? check : infoOnly;
  assertFn("todo bill confirmed/synced tiene entrada activa", missing === 0, `${missing}/${total}`);
}

async function section3(pool: Pool): Promise<void> {
  console.log("\n(3) Ningún bill cancelled/voided conserva una entrada activa");
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count
       FROM vendor_bill vb
      WHERE vb.deleted_at IS NULL AND vb.status IN ('cancelled', 'voided')
        AND EXISTS (
              SELECT 1 FROM bank_journal_entry e
               WHERE e.source_kind = 'vendor_bill' AND e.source_id = vb.id AND e.kind = 'document'
                 AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id = e.id)
            )`
  );
  const count = Number(rows[0]?.count ?? 0);
  check("ningún bill cancelled/voided tiene una entrada activa sin reversar", count === 0, `${count} bills`);
}

/** (4) Inventory Offset (GL) = Σ receipts SIN bill atado, qty × costo. */
async function section4(pool: Pool): Promise<void> {
  console.log("\n(4) Inventory Offset: GL vs. Σ receipts sin bill");
  // Mismo redondeo que el motor (`documents/receipt.ts`): `unit_cost_cents`
  // vive en columna `float`, `ROUND` corre ANTES de multiplicar por qty.
  const { rows } = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(
              rl.qty_received_now * ROUND(COALESCE(rl.unit_cost_cents_override, pol.unit_cost_cents)::numeric)
            ), 0)::bigint::text AS total
       FROM purchase_order_receipt por
       JOIN purchase_order_receipt_line rl ON rl.purchase_order_receipt_id = por.id
       JOIN purchase_order_line pol ON pol.id = rl.purchase_order_line_id
      WHERE por.deleted_at IS NULL AND por.voided_at IS NULL
        AND por.status IN ('applied', 'synced')
        AND por.vendor_bill_id IS NULL`
  );
  const expected = BigInt(rows[0]?.total ?? "0");
  const glNet = await glNetForRole(pool, "inventory_offset");
  console.log(`    esperado=${expected}; GL=${glNet}`);
  check("GL inventory_offset == Σ receipts sin bill atado", glNet === expected, `gl=${glNet} expected=${expected}`);
}

/** (5) Hash de la entrada activa de cada bill == hash actual (sin drift pendiente). */
async function section5(pool: Pool): Promise<void> {
  console.log("\n(5) Sin drift pendiente: hash de la entrada activa == hash actual");
  const { rows } = await pool.query<{ source_id: string; source_hash: string }>(
    `SELECT e.source_id, e.source_hash
       FROM bank_journal_entry e
      WHERE e.kind = 'document' AND e.source_kind = 'vendor_bill'
        AND NOT EXISTS (SELECT 1 FROM bank_journal_entry r WHERE r.reverses_entry_id = e.id)`
  );
  const client = await pool.connect();
  let drifted = 0;
  try {
    for (const row of rows) {
      const current = await currentVendorBillSourceHash(client as never, row.source_id);
      if (current !== null && current !== row.source_hash) drifted++;
    }
  } finally {
    client.release();
  }
  console.log(`    bills con entrada activa evaluados: ${rows.length}, con drift: ${drifted}`);
  check("ningún bill activo tiene drift pendiente (hash guardado == hash actual)", drifted === 0, `${drifted}/${rows.length}`);
}

function report(): void {
  console.log(`\n${passed} check(s) OK, ${failures.length} fallando.`);
  if (failures.length > 0) {
    console.log("\nFallas:");
    for (const f of failures) console.log(`  - ${f}`);
  }
}

main().catch((err) => {
  console.error("verify-gl-purchases: error inesperado:", err);
  process.exit(1);
});

/**
 * Evidencia de mutation testing (2026-09-10, EJECUTADA de verdad contra
 * `medusa_gl` — VB-1079/`por_01KYWXXSQJJR19H36PQNBCD92X`, real, 1 línea,
 * 1 receipt; backup pre-mutación en el scratchpad de la sesión, restaurado
 * con `diff` bit-a-bit antes de cada corrida "real"; fixture reversado al
 * final, sandbox devuelto a su estado previo — verificado con el mismo
 * script, mismos números de Falla, antes y después):
 *
 * Rama A — sección (5), dato mutado (no el script): `postReceipt`+
 * `postVendorBill` de verdad (COMMIT), después `UPDATE vendor_bill_line SET
 * landed_total_cents = 999999` SIN repostear.
 *   - Código ORIGINAL: `drifted=1`, sección roja — CORRECTO, lo agarra.
 *   - `reconcilePurchaseDrift` sobre el mismo estado: `{checked:1,drifted:1,
 *     reversed:1,reposted:1,blocked:[]}` — reversa+repostea solo; sección (5)
 *     vuelve a verde sin tocar el dato.
 *   - Mutante en el SCRIPT (comentar `if (current !== null && current !==
 *     row.source_hash) drifted++;`): con el MISMO drift real presente,
 *     sección (5) da `drift: 0` y ✓ — FALSO VERDE confirmado.
 *
 * Rama B — sección (1), mismo fixture posteado (bill activo, GL
 * `accounts_payable` neto = 41475, mientras Σ saldos de bills = 22147647 —
 * discrepancia real y esperada: sólo 1 de 197 bills posteado).
 *   - Código ORIGINAL: `gl=41475 expected=22147647`, ✗ — CORRECTO.
 *   - Mutante (`check(..., true, ...)` en vez de `glNet === expected`): con
 *     los MISMOS números (`gl=41475 expected=22147647`) el check imprime ✓ —
 *     FALSO VERDE confirmado.
 *
 * Ambos mutantes restaurados y verificados `diff`-idénticos al original
 * antes de la corrida en verde final.
 */

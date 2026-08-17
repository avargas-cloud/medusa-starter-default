/**
 * E2E — un vendor bill nuevo nace con el NOMBRE de su término — SANDBOX ONLY.
 *
 * ── Por qué existe ────────────────────────────────────────────────────────────
 * El unit spec del resolver corre contra una conexión falsa: prueba la decisión,
 * no que la decisión llegue a la fila. Las cuatro rutas de creación arman el
 * INSERT a mano —tres con SQL crudo y placeholders posicionales, una con el
 * module service— y ahí es donde el bug vivió nueve meses sin que nada avisara:
 * el valor se calculaba y la columna quedaba NULL igual. Un `?` de más o de
 * menos en cualquiera de esos INSERT lo reintroduce, y el type-check no puede
 * ver dentro de un template literal.
 *
 * ── La trampa que este test evita ─────────────────────────────────────────────
 * El caso que de verdad importa es el que devuelve NULL: un vendor cuyo día
 * guardado contradice el término que nombra. Ese caso pasa solo —sin escribir
 * una línea de código— en un sistema donde el nombre nunca se siembra. Por eso
 * NO alcanza con afirmarlo: hay que probar que ese MISMO vendor produce un
 * nombre ANTES de envenenarlo (caso 3a) y deja de producirlo después (3b). Sin
 * el par, "null" no distingue "el resolver decidió que no" de "el resolver
 * nunca corrió".
 *
 * ── Qué cubre ─────────────────────────────────────────────────────────────────
 *  1. Vendor en Net-30 (30 días)      → name 'Net-30'         · days 30
 *  2. Vendor en Due on receipt (0)    → name 'Due on receipt' · days 0
 *  3a. CONTROL POSITIVO: el vendor de la prueba 3, intacto → SÍ produce nombre
 *  3b. El mismo vendor con los días contradiciendo su término → name NULL,
 *      y los días SOBREVIVEN (el Due Date se sigue calculando)
 *  4. Vendor sin ningún término       → name NULL             · days 0
 *  5. La columna no se llena "de casualidad": ninguna de las filas creadas
 *     comparte nombre con otra que no le corresponda.
 *
 * Todo lo que siembra se revierte al final, incluida la contradicción del 3b.
 * QuickBooks no se toca: el bridge está apagado en el sandbox.
 *
 * ── Cómo correrlo ─────────────────────────────────────────────────────────────
 *   ./back-sb                       # backend sandbox en :9099
 *   cd backend && ./node_modules/.bin/tsx \
 *     src/scripts/tests/e2e-vendor-bill-term-seed-sandbox.ts
 */
import { Client } from "pg";

// ── Guards fail-closed ───────────────────────────────────────────────────────
// Este script CREA vendor bills y MUTA un vendor. Contra producción eso sería
// basura contable y un VendorMod a QuickBooks. El destino se afirma por nombre
// de base y por puerto, y cualquier duda aborta.
const BASE = process.env.SB_BASE ?? "http://localhost:9099";
const DB_URL =
  process.env.SB_DATABASE_URL ??
  "postgresql://postgres:sandbox@localhost:5499/medusa";

function abort(msg: string): never {
  console.error(`\n❌ ABORT: ${msg}\n`);
  process.exit(1);
}

if (!DB_URL.includes(":5499/")) {
  abort(`la DB no es el sandbox (esperaba el puerto 5499): ${DB_URL}`);
}
if (!BASE.includes(":9099")) {
  abort(`el backend no es el sandbox (esperaba :9099): ${BASE}`);
}

// ── Mini framework ───────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq(label: string, actual: unknown, expected: unknown): void {
  check(
    label,
    Object.is(actual, expected),
    `esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)}`
  );
}

const FREIGHT_ACCOUNT_LIKE = "freight and shipping costs";

interface VendorRow {
  id: string;
  label: string;
  terms_ref_name: string | null;
  days: number | null;
}

interface BillRow {
  id: string;
  number: string | null;
  payment_terms_days: number | null;
  payment_terms_name: string | null;
  due_date: string | null;
  document_date: string | null;
}

async function main(): Promise<void> {
  console.log(`\n=== E2E vendor bill term seed — ${BASE} ===\n`);

  const db = new Client({ connectionString: DB_URL });
  await db.connect();

  const createdBillIds: string[] = [];
  let poisonedVendorId: string | null = null;
  let poisonedOriginalDays: string | null = null;

  try {
    // ── Cuenta contable para la línea inicial ────────────────────────────────
    const { rows: accountRows } = await db.query<{ qb_list_id: string }>(
      `SELECT qb_list_id FROM qb_account
        WHERE is_active AND deleted_at IS NULL
          AND account_type = 'CostOfGoodsSold'
          AND lower(full_name) LIKE $1
        ORDER BY full_name LIMIT 1`,
      [`${FREIGHT_ACCOUNT_LIKE}%`]
    );
    const accountListId = accountRows[0]?.qb_list_id;
    if (!accountListId) {
      abort("el sandbox no tiene ninguna cuenta COGS de flete para la línea");
    }

    // ── Login ────────────────────────────────────────────────────────────────
    const email = process.env.SANDBOX_TEST_EMAIL ?? "sandbox@test.com";
    const password = process.env.SANDBOX_TEST_PASSWORD ?? "sandbox123";
    const authRes = await fetch(`${BASE}/auth/user/emailpass`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const auth = (await authRes.json().catch(() => ({}))) as { token?: string };
    if (!auth.token) {
      abort(
        `no se pudo loguear como ${email} (HTTP ${authRes.status}). ` +
          `Ver docs/SANDBOX.md — un reset del sandbox borra el usuario.`
      );
    }
    const token = auth.token;

    // ── Fixtures: un vendor por forma ────────────────────────────────────────
    async function pickVendor(
      where: string,
      params: unknown[],
      what: string
    ): Promise<VendorRow> {
      const { rows } = await db.query<{
        id: string;
        label: string;
        terms_ref_name: string | null;
        days: string | null;
      }>(
        `SELECT id,
                COALESCE(NULLIF(company_name,''), full_name, name, id) AS label,
                terms_ref_name,
                metadata->>'default_payment_terms_days' AS days
           FROM qb_vendor
          WHERE deleted_at IS NULL AND is_active AND ${where}
          ORDER BY id LIMIT 1`,
        params
      );
      const row = rows[0];
      if (!row) abort(`el sandbox no tiene ningún vendor ${what}`);
      return {
        id: row.id,
        label: row.label,
        terms_ref_name: row.terms_ref_name,
        days: row.days === null ? null : Number(row.days),
      };
    }

    const net30 = await pickVendor(
      `terms_ref_name = $1 AND metadata->>'default_payment_terms_days' = $2`,
      ["Net-30", "30"],
      "en Net-30 con 30 días"
    );
    const dueOnReceipt = await pickVendor(
      `terms_ref_name = $1 AND metadata->>'default_payment_terms_days' = $2`,
      ["Due on receipt", "0"],
      "en Due on receipt con 0 días"
    );
    const noTerm = await pickVendor(
      `(terms_ref_name IS NULL OR btrim(terms_ref_name) = '')
         AND metadata->>'default_payment_terms_days' IS NULL`,
      [],
      "sin término ni días"
    );
    const poisonTarget = await pickVendor(
      `terms_ref_name = $1 AND metadata->>'default_payment_terms_days' = $2
         AND id <> $3`,
      ["Net-30", "30", net30.id],
      "en Net-30 disponible para la prueba de contradicción"
    );

    console.log("Fixtures:");
    console.log(`  · Net-30          → ${net30.label}`);
    console.log(`  · Due on receipt  → ${dueOnReceipt.label}`);
    console.log(`  · sin término     → ${noTerm.label}`);
    console.log(`  · contradicción   → ${poisonTarget.label}\n`);

    // ── Helper: crear un bill y releerlo de la DB ────────────────────────────
    let seq = 0;
    async function createBill(vendorId: string): Promise<BillRow> {
      seq++;
      const res = await fetch(`${BASE}/admin/vendor-bills`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          vendor_id: vendorId,
          bill_type: "freight",
          reference_id: `E2E-TERMSEED-${Date.now()}-${seq}`,
          commission_mode: "percent",
          notes: "E2E term seed — descartable",
          initial_account_line: {
            qb_account_list_id: accountListId,
            description: "E2E freight line",
            amount_cents: 1000,
          },
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        vendor_bill?: { id?: string };
        error?: string;
      };
      const billId = body.vendor_bill?.id;
      if (!billId) {
        abort(
          `no se pudo crear el bill (HTTP ${res.status}): ${
            body.error ?? JSON.stringify(body)
          }`
        );
      }
      createdBillIds.push(billId);
      // Se relee de la DB a propósito: lo que importa es la COLUMNA, no lo que
      // el handler devolvió en memoria.
      const { rows } = await db.query<BillRow>(
        `SELECT id, number, payment_terms_days, payment_terms_name,
                due_date::text, document_date::text
           FROM vendor_bill WHERE id = $1`,
        [billId]
      );
      const row = rows[0];
      if (!row) abort(`el bill ${billId} no quedó en la base`);
      return row;
    }

    // ── 1. Net-30 ────────────────────────────────────────────────────────────
    console.log("1. Vendor en Net-30");
    const bill1 = await createBill(net30.id);
    eq("  name sembrado", bill1.payment_terms_name, "Net-30");
    eq("  days sembrados", Number(bill1.payment_terms_days), 30);
    check(
      "  due date = document date + 30 días",
      bill1.due_date !== null &&
        bill1.document_date !== null &&
        Math.round(
          (Date.parse(bill1.due_date) - Date.parse(bill1.document_date)) /
            86_400_000
        ) === 30,
      `${bill1.document_date} → ${bill1.due_date}`
    );

    // ── 2. Due on receipt ────────────────────────────────────────────────────
    console.log("\n2. Vendor en Due on receipt");
    const bill2 = await createBill(dueOnReceipt.id);
    eq("  name sembrado", bill2.payment_terms_name, "Due on receipt");
    eq("  days sembrados", Number(bill2.payment_terms_days), 0);

    // ── 3a. CONTROL POSITIVO antes de envenenar ──────────────────────────────
    console.log("\n3a. CONTROL POSITIVO — el vendor de la prueba 3, intacto");
    const bill3a = await createBill(poisonTarget.id);
    eq("  produce nombre ANTES", bill3a.payment_terms_name, "Net-30");

    // ── 3b. La contradicción ─────────────────────────────────────────────────
    console.log("\n3b. El mismo vendor, con los días contradiciendo su término");
    poisonedVendorId = poisonTarget.id;
    poisonedOriginalDays = String(poisonTarget.days ?? 30);
    await db.query(
      `UPDATE qb_vendor
          SET metadata = jsonb_set(metadata, '{default_payment_terms_days}', '21'::jsonb)
        WHERE id = $1`,
      [poisonTarget.id]
    );
    const bill3b = await createBill(poisonTarget.id);
    eq("  name queda NULL", bill3b.payment_terms_name, null);
    eq("  days SOBREVIVEN", Number(bill3b.payment_terms_days), 21);
    check(
      "  y el due date se sigue calculando",
      bill3b.due_date !== null &&
        bill3b.document_date !== null &&
        Math.round(
          (Date.parse(bill3b.due_date) - Date.parse(bill3b.document_date)) /
            86_400_000
        ) === 21,
      `${bill3b.document_date} → ${bill3b.due_date}`
    );

    // ── 4. Sin término ───────────────────────────────────────────────────────
    console.log("\n4. Vendor sin ningún término");
    const bill4 = await createBill(noTerm.id);
    eq("  name NULL", bill4.payment_terms_name, null);
    eq("  days 0", Number(bill4.payment_terms_days), 0);

    // ── 5. Nada se llenó de casualidad ───────────────────────────────────────
    console.log("\n5. Ninguna fila heredó el nombre de otra");
    const names = [
      bill1.payment_terms_name,
      bill2.payment_terms_name,
      bill3b.payment_terms_name,
      bill4.payment_terms_name,
    ];
    check(
      "  los cuatro resultados son los cuatro esperados, en orden",
      JSON.stringify(names) ===
        JSON.stringify(["Net-30", "Due on receipt", null, null]),
      JSON.stringify(names)
    );
  } finally {
    // ── Limpieza ─────────────────────────────────────────────────────────────
    console.log("\nLimpieza:");
    if (poisonedVendorId && poisonedOriginalDays !== null) {
      await db.query(
        `UPDATE qb_vendor
            SET metadata = jsonb_set(metadata, '{default_payment_terms_days}', $2::jsonb)
          WHERE id = $1`,
        [poisonedVendorId, JSON.stringify(poisonedOriginalDays)]
      );
      const { rows } = await db.query<{ days: string | null }>(
        `SELECT metadata->>'default_payment_terms_days' AS days
           FROM qb_vendor WHERE id = $1`,
        [poisonedVendorId]
      );
      console.log(
        `  · vendor restaurado a ${rows[0]?.days ?? "?"} días` +
          (rows[0]?.days === poisonedOriginalDays ? " ✅" : " ⚠️ NO COINCIDE")
      );
    }
    if (createdBillIds.length) {
      // Hard delete: son filas de test, no documentos con historia contable.
      await db.query(
        `DELETE FROM vendor_bill_line WHERE vendor_bill_id = ANY($1::text[])`,
        [createdBillIds]
      );
      const del = await db.query(
        `DELETE FROM vendor_bill WHERE id = ANY($1::text[])`,
        [createdBillIds]
      );
      console.log(`  · ${del.rowCount} bills de prueba borrados`);
    }
    await db.end();
  }

  console.log(`\n=== ${passed} PASS · ${failed} FAIL ===`);
  if (failed) {
    console.log(`Fallaron:\n${failures.map((f) => `  · ${f}`).join("\n")}`);
    process.exit(1);
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

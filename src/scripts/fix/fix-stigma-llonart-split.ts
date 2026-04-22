/**
 * fix-stigma-llonart-split.ts
 *
 * Separates the two QB accounts that share stigmawood@yahoo.com:
 *
 *  1. Llonart Homes LLC (cus_01KG0R9EF8M8VW51K83CHC9RK7)
 *     - main email → dup_stigmawood@yahoo.com  (frees the real email)
 *     - alt_email  → stigmawood@yahoo.com       (kept as reference)
 *
 *  2. STIGMA WOOD CORP. (QB 80000786-1454020008)
 *     - Created as new Medusa customer with stigmawood@yahoo.com
 *     - Address: 1160 WEST 33RD PL, HIALEAH FL 33012
 *
 * Usage:
 *   cd backend
 *   yarn ts-node src/scripts/fix/fix-stigma-llonart-split.ts          # dry-run
 *   yarn ts-node src/scripts/fix/fix-stigma-llonart-split.ts --execute
 */

import "dotenv/config";
import postgres from "postgres";
import { randomUUID } from "crypto";

const DRY_RUN = !process.argv.includes("--execute");

const LLONART_ID   = "cus_01KG0R9EF8M8VW51K83CHC9RK7";
const STIGMA_QB_ID = "80000786-1454020008";
const REAL_EMAIL   = "stigmawood@yahoo.com";
const DUP_EMAIL    = "dup_stigmawood@yahoo.com";

async function main() {
  const DB_URL = process.env.DATABASE_URL;
  if (!DB_URL) { console.error("❌ DATABASE_URL not set"); process.exit(1); }

  const sql = postgres(DB_URL, { ssl: "require" });

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  Stigma / Llonart split — ${DRY_RUN ? "DRY RUN" : "⚡ EXECUTE"}`);
  console.log("=".repeat(60) + "\n");

  // ── 1. Verify Llonart current state ──────────────────────────────
  const [llonart] = await sql`
    SELECT id, email, metadata FROM customer
    WHERE id = ${LLONART_ID} AND deleted_at IS NULL
  `;
  if (!llonart) {
    console.error(`❌ Llonart Homes customer not found: ${LLONART_ID}`);
    await sql.end(); process.exit(1);
  }
  console.log("📋 Llonart Homes LLC (current):");
  console.log(`   id:       ${llonart.id}`);
  console.log(`   email:    ${llonart.email}`);
  console.log(`   alt_email: ${(llonart.metadata as any)?.alt_email ?? "(none)"}\n`);

  // ── 2. Check STIGMA doesn't already exist ────────────────────────
  const [existingStigma] = await sql`
    SELECT id FROM customer
    WHERE LOWER(email) = ${REAL_EMAIL.toLowerCase()} AND deleted_at IS NULL AND id != ${LLONART_ID}
  `;
  if (existingStigma) {
    console.error(`❌ A customer with ${REAL_EMAIL} already exists: ${existingStigma.id}`);
    await sql.end(); process.exit(1);
  }

  const [dupCheck] = await sql`
    SELECT id FROM customer
    WHERE LOWER(email) = ${DUP_EMAIL.toLowerCase()} AND deleted_at IS NULL
  `;
  if (dupCheck) {
    console.error(`❌ ${DUP_EMAIL} already in use by: ${dupCheck.id}`);
    await sql.end(); process.exit(1);
  }

  console.log("✅ Pre-checks passed\n");

  if (DRY_RUN) {
    console.log("─── WOULD DO (dry-run) ──────────────────────────────────────");
    console.log(`\n1. UPDATE customer SET`);
    console.log(`      email    = '${DUP_EMAIL}'`);
    console.log(`      metadata.alt_email = '${REAL_EMAIL}'`);
    console.log(`   WHERE id = '${LLONART_ID}'\n`);
    console.log(`2. INSERT customer:`);
    console.log(`      email        = '${REAL_EMAIL}'`);
    console.log(`      first_name   = 'Osmani'`);
    console.log(`      last_name    = 'Carvajal'`);
    console.log(`      company_name = 'STIGMA WOOD CORP.'`);
    console.log(`      phone        = '7862852538'`);
    console.log(`      qb_list_id   = '${STIGMA_QB_ID}'\n`);
    console.log(`3. INSERT customer_address:`);
    console.log(`      address_1  = '1160 WEST 33RD PL'`);
    console.log(`      city       = 'HIALEAH'`);
    console.log(`      province   = 'FL'`);
    console.log(`      postal_code= '33012'\n`);
    console.log("─────────────────────────────────────────────────────────────");
    console.log(`\nRun with --execute to apply.\n`);
    await sql.end();
    return;
  }

  // ── 3. Update Llonart email + alt_email ──────────────────────────
  console.log("1️⃣  Updating Llonart Homes LLC...");
  await sql`
    UPDATE customer
    SET
      email    = ${DUP_EMAIL},
      metadata = jsonb_set(
                   COALESCE(metadata, '{}'::jsonb),
                   '{alt_email}',
                   ${JSON.stringify(REAL_EMAIL)}::jsonb
                 ),
      updated_at = NOW()
    WHERE id = ${LLONART_ID}
  `;
  console.log(`   ✅ email → ${DUP_EMAIL}`);
  console.log(`   ✅ metadata.alt_email → ${REAL_EMAIL}\n`);

  // ── 4. Create STIGMA WOOD CORP. ──────────────────────────────────
  console.log("2️⃣  Creating STIGMA WOOD CORP. customer...");

  const stigmaMetadata = {
    legacy_customer: true,
    qb_list_id: STIGMA_QB_ID,
    qb_display_name: "STIGMA WOOD CORP.",
    qb_customer_type: "Carpenter / General Assembler",
    qb_price_level: "Retail",
    qb_original_email: REAL_EMAIL,
    email_is_placeholder: false,
  };

  const stigmaId = `cus_${randomUUID().replace(/-/g, "").substring(0, 26)}`;

  await sql`
    INSERT INTO customer (
      id, email, first_name, last_name, company_name, phone,
      has_account, metadata, created_at, updated_at
    ) VALUES (
      ${stigmaId},
      ${REAL_EMAIL},
      'Osmani',
      'Carvajal',
      'STIGMA WOOD CORP.',
      '7862852538',
      false,
      ${JSON.stringify(stigmaMetadata)}::jsonb,
      NOW(),
      NOW()
    )
  `;
  console.log(`   ✅ Created customer id: ${stigmaId}`);
  console.log(`   ✅ email: ${REAL_EMAIL}`);
  console.log(`   ✅ qb_list_id: ${STIGMA_QB_ID}\n`);

  // ── 5. Add billing address ────────────────────────────────────────
  console.log("3️⃣  Adding billing address...");
  const addrId = `addr_${randomUUID().replace(/-/g, "").substring(0, 26)}`;
  await sql`
    INSERT INTO customer_address (
      id, customer_id, company, address_1, city, province, postal_code,
      country_code, created_at, updated_at
    ) VALUES (
      ${addrId},
      ${stigmaId},
      'STIGMA WOOD CORP.',
      '1160 WEST 33RD PL',
      'HIALEAH',
      'FL',
      '33012',
      'us',
      NOW(),
      NOW()
    )
  `;
  console.log(`   ✅ 1160 WEST 33RD PL, HIALEAH FL 33012\n`);

  // ── 6. Verify ─────────────────────────────────────────────────────
  console.log("4️⃣  Verification...");
  const [updatedLlonart] = await sql`
    SELECT id, email, metadata->>'alt_email' as alt_email FROM customer WHERE id = ${LLONART_ID}
  `;
  const [createdStigma] = await sql`
    SELECT id, email, company_name, metadata->>'qb_list_id' as qb_list_id FROM customer WHERE id = ${stigmaId}
  `;

  console.log(`   Llonart: email=${updatedLlonart.email} | alt_email=${updatedLlonart.alt_email}`);
  console.log(`   Stigma:  email=${createdStigma.email} | company=${createdStigma.company_name} | qb=${createdStigma.qb_list_id}\n`);

  console.log("=".repeat(60));
  console.log("  ✅ Done!");
  console.log("=".repeat(60) + "\n");

  await sql.end();
}

main().catch((err) => {
  console.error("❌ Fatal:", err.message);
  process.exit(1);
});

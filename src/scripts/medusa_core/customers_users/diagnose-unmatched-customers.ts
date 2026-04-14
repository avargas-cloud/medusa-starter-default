#!/usr/bin/env tsx
/**
 * diagnose-unmatched-customers.ts
 *
 * Diagnostica:
 * 1. Clientes en Medusa SIN qb_list_id y cuántos tienen email real vs placeholder
 * 2. El caso de Alejandro Vargas — por qué no matcheó
 * 3. Breakdown de los "unmatched": ¿son cuentas de prueba o clientes reales?
 */
import { Client } from "pg";
import dotenv from "dotenv";
dotenv.config();

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log("✅ Connected to database\n");

  // 1. ¿Cuántos tienen qb_list_id vs no?
  const totals = await client.query(`
        SELECT
            COUNT(*) as total,
            COUNT(CASE WHEN metadata->>'qb_list_id' IS NOT NULL THEN 1 END) as with_qb_id,
            COUNT(CASE WHEN metadata->>'qb_list_id' IS NULL THEN 1 END) as without_qb_id,
            COUNT(CASE WHEN metadata->>'email_is_placeholder' = 'true' THEN 1 END) as placeholder_emails,
            COUNT(CASE WHEN metadata->>'email_is_placeholder' IS NULL OR metadata->>'email_is_placeholder' = 'false' THEN 1 END) as real_emails
        FROM customer
    `);
  console.log("📊 TOTALES GLOBALES:");
  console.table(totals.rows);

  // 2. Clientes SIN qb_list_id — breakdown detallado
  const unmatched = await client.query(`
        SELECT 
            id,
            email,
            first_name,
            last_name,
            metadata->>'email_is_placeholder' as is_placeholder,
            metadata->>'qb_list_id' as qb_list_id,
            created_at
        FROM customer
        WHERE metadata->>'qb_list_id' IS NULL
        ORDER BY created_at DESC
        LIMIT 50
    `);
  console.log(`\n❌ CLIENTES SIN QB_LIST_ID (${unmatched.rowCount} total):`);
  for (const c of unmatched.rows) {
    const tag = c.is_placeholder === "true" ? "[DUMMY EMAIL]" : "[REAL EMAIL]";
    console.log(
      `  ${tag} ${c.first_name} ${c.last_name} | ${c.email} | created: ${new Date(c.created_at).toLocaleDateString()}`
    );
  }

  // 3. Caso específico: Alejandro Vargas / a.vargas@ecopowertech.com
  const vargas = await client.query(`
        SELECT 
            id, email, first_name, last_name,
            metadata->>'qb_list_id' as qb_list_id,
            metadata->>'email_is_placeholder' as is_placeholder,
            metadata
        FROM customer
        WHERE email ILIKE '%a.vargas%' OR email ILIKE '%alejandro%vargas%'
           OR (first_name ILIKE '%alejandro%' AND last_name ILIKE '%vargas%')
        LIMIT 5
    `);
  console.log("\n🔍 ALEJANDRO VARGAS (en Medusa):");
  if (vargas.rows.length === 0) {
    console.log("  ⚠️ No encontrado en Medusa");
  } else {
    for (const c of vargas.rows) {
      console.log(`  ID: ${c.id}`);
      console.log(`  Email: ${c.email}`);
      console.log(`  QB List ID: ${c.qb_list_id || "NONE"}`);
      console.log(`  Is Placeholder: ${c.is_placeholder}`);
      console.log(`  Metadata: ${JSON.stringify(c.metadata, null, 4)}`);
    }
  }

  // 4. Todos los @ecopowertech.com que NO son dummy (formato customer-XXXX@)
  const ecoEmails = await client.query(`
        SELECT 
            id, email, first_name, last_name,
            metadata->>'qb_list_id' as qb_list_id,
            metadata->>'email_is_placeholder' as is_placeholder
        FROM customer
        WHERE email ILIKE '%@ecopowertech.com'
          AND email NOT ILIKE 'customer-%@ecopowertech.com'
        ORDER BY created_at
    `);
  console.log(
    `\n📧 CUENTAS @ecopowertech.com (NO dummy) — ${ecoEmails.rowCount} total:`
  );
  for (const c of ecoEmails.rows) {
    const hasId = c.qb_list_id ? `✅ ${c.qb_list_id}` : "❌ SIN QB ID";
    console.log(`  ${c.first_name} ${c.last_name} | ${c.email} | ${hasId}`);
  }

  // 5. ¿Hay clientes con qb_list_id que apuntan a IDs de QB no válidos?
  console.log("\n✅ Script completado.");
  await client.end();
}

main().catch((e) => {
  console.error("❌ Error:", e.message);
  process.exit(1);
});

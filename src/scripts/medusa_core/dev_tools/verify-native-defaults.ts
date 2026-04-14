import "dotenv/config";
import postgres from "postgres";

/**
 * Verificar que is_default_billing e is_default_shipping funcionan
 */

async function verifyNativeDefaults() {
  const sql = postgres(process.env.DATABASE_URL!);

  console.log(
    "\n✅ VERIFICACIÓN: Campos Nativos is_default_billing/shipping\n"
  );

  try {
    // 1. Confirmar schema
    console.log("1️⃣  Confirmando schema de customer_address...\n");
    const cols = await sql`
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_name = 'customer_address'
            AND column_name IN ('is_default_billing', 'is_default_shipping', 'address_name')
            ORDER BY column_name
        `;

    cols.forEach((c) => {
      console.log(`   ✅ ${c.column_name} (${c.data_type}) - NATIVO`);
    });

    // 2. Ver data real
    console.log("\n2️⃣  Data actual del customer...\n");
    const addresses = await sql`
            SELECT id, address_1, city, address_name, is_default_billing, is_default_shipping
            FROM customer_address
            WHERE customer_id = (SELECT id FROM customer WHERE email = 'a.vargas@ecopowertech.com' LIMIT 1)
            AND deleted_at IS NULL
        `;

    console.log(`   Total addresses: ${addresses.length}\n`);
    addresses.forEach((addr, i) => {
      console.log(`   ${i + 1}. ${addr.address_1}, ${addr.city}`);
      console.log(`      address_name: ${addr.address_name || "NULL"}`);
      console.log(
        `      is_default_billing: ${addr.is_default_billing ? "✅ TRUE" : "❌ false"}`
      );
      console.log(
        `      is_default_shipping: ${addr.is_default_shipping ? "✅ TRUE" : "❌ false"}`
      );
      console.log();
    });

    // 3. Verificar solo hay 1 default de cada tipo
    const billingDefaults = addresses.filter(
      (a) => a.is_default_billing === true
    );
    const shippingDefaults = addresses.filter(
      (a) => a.is_default_shipping === true
    );

    console.log("3️⃣  Validación de unicidad:\n");
    console.log(
      `   Default billing addresses: ${billingDefaults.length} ${billingDefaults.length === 1 ? "✅" : billingDefaults.length === 0 ? "⚠️  (ninguno)" : "❌ (más de 1!)"}`
    );
    console.log(
      `   Default shipping addresses: ${shippingDefaults.length} ${shippingDefaults.length === 1 ? "✅" : shippingDefaults.length === 0 ? "⚠️  (ninguno)" : "❌ (más de 1!)"}`
    );

    console.log("\n✅ Verificación completa!\n");
  } catch (error) {
    console.error("\n❌ Error:", error);
  } finally {
    await sql.end();
    process.exit(0);
  }
}

verifyNativeDefaults();

import * as dotenv from "dotenv";
import { Client } from "pg";

dotenv.config();

async function checkOrphans() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  const email = "alejosvp@gmail.com";

  try {
    await db.connect();

    console.log(`🔍 Buscando registros huérfanos para: ${email}\n`);

    // 1. Mostrar todos los Customers con este email
    const customers = await db.query(
      `
      SELECT id, email, has_account, created_at, deleted_at
      FROM customer 
      WHERE email = $1;
    `,
      [email]
    );

    console.log("📌 CUSTOMERS ENCONTRADOS:");
    if (customers.rows.length === 1) {
      console.log(
        `✅ Todo perfecto. Solo hay 1 cliente con este correo en la DB:\n`,
        customers.rows[0]
      );
    } else {
      console.log(
        `⚠️ ALERTA: Hay ${customers.rows.length} clientes con este correo:\n`,
        customers.rows
      );
    }
    console.log("--------------------------------------------------\n");

    // 2. Mostrar todos los Auth Identities con este email
    const auths = await db.query(
      `
      SELECT id, app_metadata, created_at
      FROM auth_identity
      WHERE app_metadata::text LIKE $1;
    `,
      [`%${email}%`]
    );

    console.log("📌 IDENTIDADES AUTH ENCONTRADAS (auth_identity):");
    if (auths.rows.length === 0) {
      // It might not contain the email in app_metadata, check by customer_id
      if (customers.rows.length > 0) {
        const authsById = await db.query(
          `
          SELECT id, app_metadata, created_at
          FROM auth_identity
          WHERE app_metadata::text LIKE $1;
        `,
          [`%${customers.rows[0].id}%`]
        );
        console.log(
          `Se encontró 1 identidad vinculada al customer_id:\n`,
          authsById.rows
        );
      } else {
        console.log("Ninguna identidad de Auth encontrada.");
      }
    } else if (auths.rows.length === 1) {
      console.log(
        `✅ Todo en orden. Solo hay 1 identidad OAuth:\n`,
        auths.rows[0]
      );
    } else {
      console.log(
        `⚠️ ALERTA: Hay ${auths.rows.length} identidades Auth (posibles duplicados/huérfanos):\n`,
        auths.rows
      );
    }
  } catch (error) {
    console.error("❌ Error en el chequeo:", error);
  } finally {
    await db.end();
  }
}

checkOrphans();

import * as dotenv from 'dotenv';
import { Client } from 'pg';

dotenv.config();

/**
 * Este script busca cualquier cuenta huérfana (auth_identity validada por OAuth pero sin un customer_id atado a app_metadata).
 * Si encuentra una huérfana, busca si existe el usuario correspondiente en la tabla `customer` a través de su email.
 * Si el usuario existe, amarra ambas tablas vinculándolas retroactivamente, reparando el problema de raíz para cuentas viejas!
 */
async function fixOrphanedIdentities() {
    const db = new Client({ connectionString: process.env.DATABASE_URL });

    try {
        await db.connect();

        console.log(`🛠️ Buscando identidades OAuth (Google) huérfanas o sin vincular...\n`);

        // 1. Encontrar identities que NO tengan un customer_id en su app_metadata.
        // OAuth siempre inyecta el correo del usuario en la tabla provider_identity -> provider_metadata
        // Así que cruzamos provider_identity con auth_identity para extraer el email.
        const orphans = await db.query(`
      SELECT 
        ai.id AS auth_identity_id, 
        ai.app_metadata,
        pi.provider_metadata->>'email' AS email
      FROM auth_identity ai
      JOIN provider_identity pi ON ai.id = pi.auth_identity_id
      WHERE (ai.app_metadata->>'customer_id' IS NULL)
        AND pi.provider_metadata->>'email' IS NOT NULL;
    `);

        if (orphans.rows.length === 0) {
            console.log('✅ No se encontraron identidades OAuth huérfanas. ¡Todas tus cuentas anteriores están sanas!');
            return;
        }

        console.log(`⚠️ Se encontraron ${orphans.rows.length} identidades huérfanas. Intentando repararlas...`);

        let fixedCount = 0;

        for (const orphan of orphans.rows) {
            console.log(`\n🔍 Evaluando identidad huérfana para el correo: ${orphan.email}`);

            // Buscar el customer en la base de datos para recuperar su ID
            const customerResult = await db.query(`
          SELECT id, has_account 
          FROM customer 
          WHERE email = $1;
        `, [orphan.email]);

            if (customerResult.rows.length === 1) {
                const customerId = customerResult.rows[0].id;
                console.log(`   🔸 ¡Encontrado! El verdadero dueño es: ${customerId}`);

                // Actualizar el app_metadata de la tabla auth_identity
                await db.query(`
              UPDATE auth_identity
              SET app_metadata = jsonb_set(COALESCE(app_metadata, '{}'::jsonb), '{customer_id}', $1::jsonb)
              WHERE id = $2;
            `, [`"${customerId}"`, orphan.auth_identity_id]);

                // Aprovechar para asegurarnos que la cuenta del customer quedó marcada como activada
                if (!customerResult.rows[0].has_account) {
                    await db.query(`
                    UPDATE customer
                    SET has_account = true
                    WHERE id = $1;
                `, [customerId]);
                    console.log(`   🔸 Cuenta activada (has_account = true) retroactivamente.`);
                }

                console.log(`   ✅ Identidad ${orphan.auth_identity_id} enlazada exitosamente a ${customerId}. Reparada.`);
                fixedCount++;
            } else if (customerResult.rows.length > 1) {
                console.log(`   ❌ ERROR: Se encontraron ${customerResult.rows.length} customers con el email ${orphan.email}. Requiere unificación manual antes de enlazar el login de Google.`);
            } else {
                console.log(`   ❌ ERROR: No se encontró ningún customer con el email ${orphan.email}. La identidad de Google ${orphan.auth_identity_id} está completamente aislada en Medusa.`);
            }
        }

        console.log(`\n🎉 PROCESO COMPLETADO. Se repararon permanentemente ${fixedCount} identidades perdidas.\n`);

    } catch (error) {
        console.error('❌ Error en el chequeo:', error);
    } finally {
        await db.end();
    }
}

fixOrphanedIdentities();

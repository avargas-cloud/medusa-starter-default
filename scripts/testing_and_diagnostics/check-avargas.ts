import * as dotenv from 'dotenv';
import { Client } from 'pg';

dotenv.config();

async function checkAccount() {
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    const email = 'a.vargas@ecopowertech.com';

    try {
        await db.connect();

        console.log(`🔍 Revisando el estado de: ${email}\n`);

        // 1. Mostrar el Customer
        const customers = await db.query(`
      SELECT id, email, has_account, created_at
      FROM customer 
      WHERE email = $1;
    `, [email]);

        if (customers.rows.length === 0) {
            console.log(`❌ ALERTA: No existe ningún usuario (Customer) con el correo ${email} en la base de datos.`);
            return;
        }

        const customer = customers.rows[0];
        console.log('📌 STATUS DEL CUSTOMER:');
        console.log(JSON.stringify(customer, null, 2));

        if (!customer.has_account) {
            console.log(`⚠️ ALERTA: La cuenta existe pero NO está activada (has_account=false). Si este usuario inicia sesión con Google, activará su cuenta normalmente usando nuestro nuevo código.`);
        }

        console.log('\n--------------------------------------------------\n');

        // 2. Buscar si ya se ha logueado con Google y si su identidad está atada
        const auths = await db.query(`
      SELECT ai.id, ai.app_metadata, ai.created_at
      FROM auth_identity ai
      JOIN provider_identity pi ON ai.id = pi.auth_identity_id
      WHERE pi.provider_metadata->>'email' = $1;
    `, [email]);

        console.log('📌 STATUS DE LA IDENTIDAD DE GOOGLE (auth_identity):');

        if (auths.rows.length === 0) {
            console.log(`⚪ INFO: El usuario ${email} NUNCA ha iniciado sesión con Google (o si lo hizo en el pasado, se borró su sesión).`);
            console.log(`   Cuando lo haga por primera vez, el sistema creará su identidad y la atará perfecta y automáticamente a su customer_id: ${customer.id}`);
        } else {
            console.log(JSON.stringify(auths.rows, null, 2));

            const appMetadata = auths.rows[0].app_metadata;
            if (appMetadata && appMetadata.customer_id === customer.id) {
                console.log(`\n✅ ¡PERFECTO! La identidad de Google existe y está perfectamente enlazada al customer_id correcto.`);
            } else {
                console.log(`\n⚠️ ALERTA: La identidad de Google existe pero NO está atada a su customer_id. (app_metadata=${JSON.stringify(appMetadata)})`);
            }
        }

    } catch (error) {
        console.error('❌ Error en el chequeo:', error);
    } finally {
        await db.end();
    }
}

checkAccount();

import * as dotenv from 'dotenv';
import { Client } from 'pg';

dotenv.config();

async function resetLegacyCustomer() {
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    const email = 'alejosvp@gmail.com';

    try {
        await db.connect();

        // 1. Delete ALL auth identities for this email (just in case any exist)
        await db.query(`
      DELETE FROM provider_identity WHERE entity_id = $1 OR provider_metadata::text LIKE $2;
    `, [email, `%${email}%`]);

        // 2. We can't easily query the JSONB for the exact customer ID right now, 
        // so let's just make sure the customer account is reset.
        // Set has_account to false and put the legacy metadata back.
        const res = await db.query(`
      UPDATE customer
      SET 
        has_account = false,
        metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{legacy_customer}', 'true'::jsonb)
      WHERE email = $1
      RETURNING id, email, has_account;
    `, [email]);

        if (res.rowCount > 0) {
            console.log('✅ Cliente Legacy Reiniciado con Éxito:');
            console.log(JSON.stringify(res.rows[0], null, 2));
            console.log('\n✅ Puedes probar el Login de Google ahora!');
        } else {
            console.log(`❌ No se encontró ningún cliente con el email ${email}`);
        }

    } catch (error) {
        console.error('Error:', error);
    } finally {
        await db.end();
    }
}

resetLegacyCustomer();

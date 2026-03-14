
import { Client } from 'pg';
import * as dotenv from 'dotenv';
import path from 'path';

// Load env vars
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

async function resetSequence() {
    console.log('🔌 Connecting to database...');
    console.log(`📡 URL: ${process.env.DATABASE_URL?.replace(/:[^:]*@/, ':****@')}`);

    const client = new Client({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });

    try {
        await client.connect();
        console.log('✅ Connected!');

        // 1. Identify valid sequences for 'order' table
        // Medusa v2 might name it 'order_display_id_seq' or similar
        const resStats = await client.query(`
            SELECT c.relname FROM pg_class c 
            WHERE c.relkind = 'S' AND c.relname LIKE '%order%seq%';
        `);

        console.log('🔍 Found sequences:', resStats.rows.map(r => r.relname));

        const targetSequence = 'order_display_id_seq';

        // Check if it exists in the list
        const exists = resStats.rows.some(r => r.relname === targetSequence);

        if (!exists) {
            console.error(`❌ Sequence '${targetSequence}' not found. Please verify the name from the list above.`);
            // Try to find one that looks like it
            const guess = resStats.rows.find(r => r.relname.includes('display_id'));
            if (guess) {
                console.log(`⚠️ Attempting to use '${guess.relname}' instead...`);
                await client.query(`ALTER SEQUENCE "${guess.relname}" RESTART WITH 1001;`);
                console.log(`✅ Sequence '${guess.relname}' restarted with 1001.`);
            }
        } else {
            await client.query(`ALTER SEQUENCE ${targetSequence} RESTART WITH 1001;`);
            console.log(`✅ Sequence '${targetSequence}' restarted with 1001.`);
        }

    } catch (err) {
        console.error('❌ Error:', err);
    } finally {
        await client.end();
        console.log('👋 Disconnected.');
    }
}

resetSequence();

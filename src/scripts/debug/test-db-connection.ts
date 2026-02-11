#!/usr/bin/env tsx
import { Client } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

async function testConnection() {
    console.log('🔍 Testing PostgreSQL Connection...\n');

    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
        console.error('❌ DATABASE_URL not found in .env');
        process.exit(1);
    }

    console.log('📊 Connection details:');
    const url = new URL(dbUrl);
    console.log(`  Host: ${url.hostname}`);
    console.log(`  Port: ${url.port}`);
    console.log(`  Database: ${url.pathname.slice(1)}`);
    console.log(`  User: ${url.username}\n`);

    const client = new Client({
        connectionString: dbUrl,
        connectionTimeoutMillis: 10000,
        ssl: {
            rejectUnauthorized: false  // Railway uses self-signed certs
        }
    });

    try {
        console.log('🔌 Attempting to connect...');
        const startTime = Date.now();

        await client.connect();
        const connectTime = Date.now() - startTime;
        console.log(`✅ Connected successfully in ${connectTime}ms\n`);

        console.log('📝 Running test query...');
        const queryStart = Date.now();
        const result = await client.query('SELECT 1 as test');
        const queryTime = Date.now() - queryStart;

        console.log(`✅ Query successful in ${queryTime}ms`);
        console.log(`   Result: ${JSON.stringify(result.rows)}\n`);

        console.log('🎉 Database connection is healthy!');

    } catch (error: any) {
        console.error('\n❌ Connection FAILED:');
        console.error(`   Name: ${error.name}`);
        console.error(`   Message: ${error.message}`);
        console.error(`   Code: ${error.code || 'N/A'}`);

        if (error.message.includes('timeout')) {
            console.error('\n💡 Timeout Error - Possible causes:');
            console.error('   • Railway database is hibernated (needs to wake up)');
            console.error('   • Network connectivity issues');
            console.error('   • Firewall blocking connection');
            console.error('   • Database credentials changed');
        }

        process.exit(1);
    } finally {
        await client.end();
    }
}

testConnection();

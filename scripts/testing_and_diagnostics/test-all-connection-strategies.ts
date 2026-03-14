#!/usr/bin/env tsx
import { Client } from 'pg';

// Test multiple connection strategies
const baseUrl = 'postgresql://postgres:hUMSVtteMnqSBZSuSGUBivBooMdRoKtj@interchange.proxy.rlwy.net:34919/railway';

const strategies = [
    { name: 'No SSL', config: { connectionString: baseUrl } },
    { name: 'SSL Disabled', config: { connectionString: baseUrl, ssl: false } },
    { name: 'SSL Reject Unauthorized False', config: { connectionString: baseUrl, ssl: { rejectUnauthorized: false } } },
    { name: 'SSL with sslmode=require in URL', config: { connectionString: `${baseUrl}?sslmode=require` } },
    { name: 'SSL with sslmode=disable in URL', config: { connectionString: `${baseUrl}?sslmode=disable`, ssl: false } },
];

async function testStrategy(name: string, config: any) {
    console.log(`\n🔍 Testing: ${name}`);
    console.log(`   Config:`, JSON.stringify(config, null, 2).substring(0, 100) + '...');

    const client = new Client({
        ...config,
        connectionTimeoutMillis: 5000,
    });

    try {
        await client.connect();
        const result = await client.query('SELECT 1 as test');
        console.log(`   ✅ SUCCESS! Result:`, result.rows[0]);
        await client.end();
        return true;
    } catch (error: any) {
        console.log(`   ❌ FAILED: ${error.message} (${error.code || 'N/A'})`);
        await client.end().catch(() => { });
        return false;
    }
}

async function run() {
    console.log('🚀 Testing Railway PostgreSQL Connection Strategies\n');
    console.log('='.repeat(60));

    for (const strategy of strategies) {
        const success = await testStrategy(strategy.name, strategy.config);
        if (success) {
            console.log('\n\n🎉 FOUND WORKING CONFIGURATION!');
            console.log(`Strategy: ${strategy.name}`);
            console.log(`Config:`, JSON.stringify(strategy.config, null, 2));
            process.exit(0);
        }
    }

    console.log('\n\n❌ All strategies failed');
    console.log('\n💡 Possible causes:');
    console.log('   • Railway database is offline/hibernated');
    console.log('   • Credentials have been rotated');
    console.log('   • Network firewall blocking connection');
    console.log('   • Railway service experiencing issues');
    process.exit(1);
}

run();

#!/usr/bin/env node
const Redis = require('ioredis');
const dns = require('dns');

const REDIS_URL = 'redis://default:DhyISQjzoCERZLHafFBUwZYJYSPqbrHG@centerbeam.proxy.rlwy.net:56695';

console.log('🔍 Testing ioredis connection with detailed logging...\n');

// Test 1: DNS resolution
console.log('Step 1: DNS Resolution Test');
const startDNS = Date.now();
dns.lookup('centerbeam.proxy.rlwy.net', { all: true }, (err, addresses) => {
    if (err) {
        console.error('❌ DNS lookup failed:', err);
        process.exit(1);
    }
    console.log(`✅ DNS resolved in ${Date.now() - startDNS}ms:`, addresses);

    // Test 2: ioredis connection with IPv4 forcing
    console.log('\nStep 2: ioredis Connection Test (forcing IPv4)');
    const start = Date.now();

    const redis = new Redis(REDIS_URL, {
        lazyConnect: false,
        connectTimeout: 15000,
        family: 4, // Force IPv4
        enableReadyCheck: true,
        retryStrategy: null // times => (times > 3 ? null : Math.min(times * 50, 2000))
    });

    redis.on('connecting', () => console.log(`⏳ Connecting... (${Date.now() - start}ms)`));
    redis.on('connect', () => console.log(`✅ TCP Connected in ${Date.now() - start}ms`));
    redis.on('ready', () => {
        console.log(`✅ Redis READY in ${Date.now() - start}ms`);
        redis.disconnect();
        process.exit(0);
    });
    redis.on('error', (err) => {
        console.error(`❌ Error at ${Date.now() - start}ms:`, err.message);
    });
    redis.on('close', () => console.log(`🔌 Connection closed at ${Date.now() - start}ms`));

    setTimeout(() => {
        console.log(`\n⏱️  TIMEOUT after 20 seconds - ioredis failed to connect`);
        console.log('This confirms the issue is with ioredis, not network infrastructure');
        redis.disconnect();
        process.exit(1);
    }, 20000);
});

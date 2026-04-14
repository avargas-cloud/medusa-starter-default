#!/usr/bin/env tsx
/**
 * Script: debug-redis-quick.ts
 * Versión minimalista - solo SCAN rápido buscando keys de órdenes recientes
 */
import Redis from "ioredis";
import dotenv from "dotenv";
dotenv.config();

const REDIS_URL = process.env.REDIS_URL!;

async function main() {
  const redis = new Redis(REDIS_URL, {
    connectTimeout: 8000,
    commandTimeout: 15000,
    lazyConnect: true,
  });

  try {
    await redis.connect();
    console.log("✅ Conectado a Redis\n");

    // DBSIZE primero
    const dbSize = await redis.dbsize();
    console.log(`📊 Total keys en Redis: ${dbSize}\n`);

    // Un solo SCAN rápido con COUNT=100, buscando "order"
    console.log("🔍 SCAN rápido (1 iteración, count=100)...");
    const [cursor, keys] = await redis.scan(
      "0",
      "MATCH",
      "*order*",
      "COUNT",
      100
    );
    console.log(`   Cursor siguiente: ${cursor}`);
    console.log(`   Keys encontradas en esta iteración: ${keys.length}`);
    if (keys.length > 0) {
      console.log("\n📋 Keys:");
      keys.forEach((k) => console.log(`   - ${k}`));

      // Leer la primera key
      const key = keys[0];
      const type = await redis.type(key);
      console.log(`\n🔑 Inspeccionando: ${key} [tipo: ${type}]`);
      if (type === "string") {
        const val = await redis.get(key);
        console.log(val ? val.substring(0, 800) : "(vacío)");
      } else if (type === "hash") {
        const h = await redis.hgetall(key);
        console.log(JSON.stringify(h, null, 2).substring(0, 800));
      }
    } else {
      console.log("   Sin resultados en esta iteración.");
    }

    // Buscar keys del event bus (bull)
    console.log('\n\n🔍 SCAN keys "bull"...');
    const [, bullKeys] = await redis.scan("0", "MATCH", "bull:*", "COUNT", 100);
    console.log(`   Keys bull encontradas: ${bullKeys.length}`);
    bullKeys.slice(0, 10).forEach((k) => console.log(`   - ${k}`));

    // Buscar keys de caché de Medusa
    console.log('\n🔍 SCAN keys "medusa" / "cache"...');
    const [, medusaKeys] = await redis.scan(
      "0",
      "MATCH",
      "medusa:*",
      "COUNT",
      100
    );
    console.log(`   Keys medusa: ${medusaKeys.length}`);
    medusaKeys.slice(0, 10).forEach((k) => console.log(`   - ${k}`));

    const [, cacheKeys] = await redis.scan(
      "0",
      "MATCH",
      "cache:*",
      "COUNT",
      100
    );
    console.log(`   Keys cache: ${cacheKeys.length}`);
    cacheKeys.slice(0, 10).forEach((k) => console.log(`   - ${k}`));
  } catch (err) {
    console.error("❌ Error:", err);
  } finally {
    await redis.quit();
  }
}

main();

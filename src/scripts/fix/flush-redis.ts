import Redis from 'ioredis';
import dotenv from 'dotenv';
import path from 'path';

// Load .env
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });

async function flushRedis() {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
        console.error("REDIS_URL environment variable is missing.");
        process.exit(1);
    }

    // Obscure password in log
    const safeUrl = redisUrl.replace(/:([^:@]+)@/, ':***@');
    console.log(`Connecting to Redis at ${safeUrl}...`);

    const redis = new Redis(redisUrl);

    try {
        console.log("Flushing all databases...");
        const result = await redis.flushall();
        console.log(`Redis FLUSHALL result: ${result}`);
    } catch (err) {
        console.error("Error flushing Redis:", err);
    } finally {
        redis.quit();
        console.log("Disconnected.");
    }
}

flushRedis();

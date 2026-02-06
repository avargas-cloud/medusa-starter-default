/**
 * CacheManager - Type-safe caching utility for Medusa
 * 
 * Works with Medusa's cache service (Redis-backed)
 * 
 * Features:
 * - Automatic JSON serialization/deserialization
 * - TTL management
 * - Type safety with generics
 */
export class CacheManager {
    constructor(private cacheService: any) { }

    /**
     * Get value from cache
     * @returns Parsed value or null if not found/expired
     */
    async get<T>(key: string): Promise<T | null> {
        try {
            const value = await this.cacheService.get(key);
            if (!value) return null;

            return JSON.parse(value) as T;
        } catch (error) {
            console.error(`[Cache] Error getting key ${key}:`, error);
            return null;
        }
    }

    /**
     * Set value in cache with TTL
     * @param key Cache key
     * @param value Value to cache (will be JSON stringified)
     * @param ttl Time to live in seconds
     */
    async set<T>(key: string, value: T, ttl: number): Promise<void> {
        try {
            const serialized = JSON.stringify(value);
            await this.cacheService.set(key, serialized, ttl);
        } catch (error) {
            console.error(`[Cache] Error setting key ${key}:`, error);
        }
    }

    /**
     * Delete a specific key
     */
    async del(key: string): Promise<void> {
        try {
            await this.cacheService.del(key);
        } catch (error) {
            console.error(`[Cache] Error deleting key ${key}:`, error);
        }
    }
}

/**
 * Singleton instance - will be initialized in the route handler
 */
let cacheManagerInstance: CacheManager | null = null;

export function getCacheManager(cacheService: any): CacheManager {
    if (!cacheManagerInstance) {
        cacheManagerInstance = new CacheManager(cacheService);
    }
    return cacheManagerInstance;
}

import crypto from "crypto"
import { promisify } from "util"

const scrypt = promisify(crypto.scrypt)

/**
 * Hash a password using scrypt - compatible with Medusa v2 emailpass provider
 * Format: "salt:hash"
 */
export async function hashPassword(password: string): Promise<string> {
    const salt = crypto.randomBytes(16).toString("hex")
    const derivedKey = (await scrypt(password, salt, 64)) as Buffer
    return `${salt}:${derivedKey.toString("hex")}`
}

/**
 * Verify a password against a hash
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
    const [salt, key] = hash.split(":")
    const keyBuffer = Buffer.from(key, "hex")
    const derivedKey = (await scrypt(password, salt, 64)) as Buffer
    return crypto.timingSafeEqual(keyBuffer, derivedKey)
}

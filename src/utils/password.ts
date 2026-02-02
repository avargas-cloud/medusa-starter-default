import scryptKdf from "scrypt-kdf"

/**
 * Hash a password using scrypt-kdf - EXACTLY compatible with Medusa v2 emailpass provider
 * Format: base64 encoded scrypt-kdf output
 * 
 * This MUST match @medusajs/auth-emailpass implementation:
 * const passwordHash = await scrypt_kdf_1.default.kdf(password, hashConfig);
 * return passwordHash.toString("base64");
 */
export async function hashPassword(password: string): Promise<string> {
    // Use same config as emailpass provider default
    const hashConfig = { logN: 15, r: 8, p: 1 }
    const passwordHash = await scryptKdf.kdf(password, hashConfig)
    return passwordHash.toString("base64")
}

/**
 * Verify a password against a scrypt-kdf hash
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
    const buf = Buffer.from(hash, "base64")
    return await scryptKdf.verify(buf, password)
}

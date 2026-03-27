import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules, ContainerRegistrationKeys, generateJwtToken } from "@medusajs/utils"
import { getSql } from "../../../../../lib/db"
import { scrypt, randomBytes, createHash, createHmac } from "crypto"

// Hash password using the exact 96-byte format that scrypt-kdf produces and verifies:
// [0-5]   "scrypt"  (6 bytes)
// [6]     version   (1 byte,  = 0)
// [7]     logN      (1 byte,  = 15 for N=32768)
// [8-11]  r         (4 bytes, big-endian uint32)
// [12-15] p         (4 bytes, big-endian uint32)
// [16-47] salt      (32 bytes, random)
// [48-63] checksum  (16 bytes, SHA256 of first 48 bytes)
// [64-95] hmachash  (32 bytes, HMAC-SHA256 using scrypt-derived key)
async function hashPassword(password: string): Promise<string> {
    const logN = 15  // N = 2^15 = 32768
    const r = 8
    const p = 1

    const buf = Buffer.alloc(96)

    buf.write("scrypt", 0, "ascii")
    buf[6] = 0          // version
    buf[7] = logN
    buf.writeUInt32BE(r, 8)
    buf.writeUInt32BE(p, 12)

    const salt = randomBytes(32)
    salt.copy(buf, 16)

    // checksum = SHA256(buf[0..47])[0..15]
    const checksum = createHash("sha256").update(buf.slice(0, 48)).digest().slice(0, 16)
    checksum.copy(buf, 48)

    // hmacKey = scrypt(password, salt, 64)
    const hmacKey = await new Promise<Buffer>((resolve, reject) => {
        scrypt(password, salt, 64, { N: 2 ** logN, r, p, maxmem: 2 ** 31 - 1 }, (err, key) => {
            if (err) reject(err)
            else resolve(key)
        })
    })

    // hmachash = HMAC-SHA256(buf[0..63], hmacKey[32..63])
    const hmacHash = createHmac("sha256", hmacKey.slice(32)).update(buf.slice(0, 64)).digest()
    hmacHash.copy(buf, 64)

    return buf.toString("base64")
}

export const POST = async (
    req: MedusaRequest,
    res: MedusaResponse
) => {
    const { token, password } = req.body as {
        token: string
        password: string
    }

    if (!token || !password) {
        return res.status(400).json({
            error: "Missing required fields",
            required: ["token", "password"]
        })
    }

    // Password validation
    if (password.length < 8) {
        return res.status(400).json({
            error: "Password must be at least 8 characters"
        })
    }

    try {
        const sql = getSql()
        const authModule = req.scope.resolve(Modules.AUTH)
        const customerModule = req.scope.resolve(Modules.CUSTOMER)
        const config = req.scope.resolve(ContainerRegistrationKeys.CONFIG_MODULE)

        // ── Step 1: Find customer by reset token (SQL — avoids pagination limits) ──
        const [customer] = await sql`
            SELECT id, email, first_name, last_name, has_account, metadata
            FROM customer
            WHERE metadata->>'reset_token' = ${token}
              AND deleted_at IS NULL
            LIMIT 1
        `

        if (!customer) {
            return res.status(400).json({
                error: "Invalid or expired reset token"
            })
        }

        // ── Step 2: Check token expiry (reset_expires stored as ISO string) ───
        const resetExpiresRaw = customer.metadata?.reset_expires as string | undefined
        const resetExpiresMs = resetExpiresRaw ? new Date(resetExpiresRaw as string).getTime() : 0
        if (!resetExpiresMs || Date.now() > resetExpiresMs) {
            const cleanMetadata = { ...customer.metadata }
            delete cleanMetadata.reset_token
            delete cleanMetadata.reset_expires
            await customerModule.updateCustomers(customer.id, {
                metadata: cleanMetadata
            })
            return res.status(400).json({
                error: "Reset token has expired",
                message: "Please request a new password reset link."
            })
        }

        // ── Step 3: Find auth_identity for this customer (SQL — avoids pagination limits) ──
        const [identityRow] = await sql`
            SELECT id, app_metadata
            FROM auth_identity
            WHERE app_metadata->>'customer_id' = ${customer.id}
              AND deleted_at IS NULL
            LIMIT 1
        `

        if (!identityRow) {
            return res.status(404).json({
                error: "Authentication identity not found"
            })
        }

        const matchingIdentity = identityRow

        // ── Step 4: Find emailpass provider_identity by email (ignores which auth_identity it's linked to)
        // Handles split-identity case: Google auth_identity + orphaned emailpass auth_identity
        const [emailpassProvider] = await sql`
            SELECT id, entity_id, provider, auth_identity_id, provider_metadata
            FROM provider_identity
            WHERE entity_id = ${customer.email}
              AND provider = 'emailpass'
            LIMIT 1
        `

        if (!emailpassProvider) {
            // Case: Google OAuth user with no emailpass provider → create one (dual auth)
            console.log(`ℹ️  No emailpass provider found for ${customer.email} — creating one (dual auth)`)
            const created = await (authModule as any).createProviderIdentities([{
                entity_id: customer.email,
                provider: "emailpass",
                auth_identity_id: matchingIdentity.id,
                provider_metadata: {}
            }])
            const newProvider = Array.isArray(created) ? created[0] : created

            // Hash and set password on the newly created provider
            const passwordHash = await hashPassword(password)

            await authModule.updateProviderIdentities([{
                id: newProvider.id,
                provider_metadata: { password: passwordHash }
            }])

            await customerModule.updateCustomers(customer.id, {
                metadata: (() => {
                    const m = { ...customer.metadata }
                    delete m.reset_token
                    delete m.reset_expires
                    m.password_reset_at = new Date().toISOString()
                    return m
                })()
            })

            console.log(`✅ Password set for Google OAuth user ${customer.email}`)

            const { http } = config.projectConfig
            const jwtToken = generateJwtToken({
                actor_id: customer.id,
                actor_type: "customer",
                auth_identity_id: matchingIdentity.id,
                app_metadata: { customer_id: customer.id }
            }, {
                secret: http.jwtSecret,
                expiresIn: http.jwtExpiresIn,
                jwtOptions: http.jwtOptions
            })

            return res.status(200).json({
                success: true,
                customer: { id: customer.id, email: customer.email, first_name: customer.first_name, last_name: customer.last_name },
                token: jwtToken,
                message: "Password set successfully! You are now logged in."
            })
        }


        // ── Step 5: Hash password (Medusa-compatible scrypt format) ──────────
        const passwordHash = await hashPassword(password)

        // ── Step 6: Update provider_metadata.password in place ────────────────
        // No SQL surgery. No deletion. No register(). Just update in place.
        await authModule.updateProviderIdentities([{
            id: emailpassProvider.id,
            provider_metadata: {
                password: passwordHash  // Field MUST be "password", NOT "password_hash"
            }
        }])

        // ── Step 7: Invalidate reset token ────────────────────────────────────
        const cleanMetadata = { ...customer.metadata }
        delete cleanMetadata.reset_token
        delete cleanMetadata.reset_expires
        cleanMetadata.password_reset_at = new Date().toISOString()

        await customerModule.updateCustomers(customer.id, {
            metadata: cleanMetadata
        })

        console.log(`✅ Password reset successful for ${customer.email}`)

        // ── Step 8: Generate JWT for auto-login ───────────────────────────────
        const { http } = config.projectConfig
        const jwtToken = generateJwtToken({
            actor_id: customer.id,
            actor_type: "customer",
            auth_identity_id: matchingIdentity.id,
            app_metadata: {
                customer_id: customer.id
            }
        }, {
            secret: http.jwtSecret,
            expiresIn: http.jwtExpiresIn,
            jwtOptions: http.jwtOptions
        })

        return res.status(200).json({
            success: true,
            customer: {
                id: customer.id,
                email: customer.email,
                first_name: customer.first_name,
                last_name: customer.last_name
            },
            token: jwtToken,
            message: "Password reset successfully! You are now logged in."
        })

    } catch (error: any) {
        console.error('Reset password confirm error:', error)
        return res.status(500).json({
            error: "Password reset failed",
            details: error instanceof Error ? (error as Error).message : 'Unknown error'
        })
    }
}

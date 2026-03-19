import postgres from 'postgres'
import { loadEnv } from "@medusajs/utils"
import { scrypt, randomBytes } from 'crypto'
import { promisify } from 'util'

const scryptAsync = promisify(scrypt)

loadEnv('development', process.cwd())
const sql = postgres(process.env.DATABASE_URL!)

async function hashPassword(password: string): Promise<string> {
    // Use scrypt parameters compatible with Node.js memory limits
    const salt = randomBytes(16)

    // Lower N to avoid memory limit (still very secure)
    const N = 16384  // 2^14 instead of 2^15
    const r = 8
    const p = 1
    const keylen = 64

    const derivedKey = await scryptAsync(password, salt, keylen, { N, r, p }) as Buffer

    // Format: $scrypt$N$r$p$salt$hash
    const hashString = `$scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${derivedKey.toString('base64')}`

    return hashString
}

async function fixCustomerPassword() {
    const email = 'customtest_1740685200@test.com'
    const password = 'Success123!'

    console.log('🔐 Hashing password for:', email)

    try {
        // Generate proper password hash
        const passwordHash = await hashPassword(password)

        console.log('✅ Password hashed successfully')
        console.log('📝 Hash preview:', passwordHash.substring(0, 60) + '...')

        // Update provider_identity with proper hash
        const result = await sql`
            UPDATE provider_identity
            SET provider_metadata = ${{ password_hash: passwordHash }}::jsonb
            WHERE entity_id = ${email}
            RETURNING id
        `

        if (result.length > 0) {
            console.log('✅ Provider identity updated successfully')
            console.log('🎯 Customer can now login with:')
            console.log('   Email:', email)
            console.log('   Password:', password)
        } else {
            console.log('❌ No provider identity found to update')
        }

    } catch (error) {
        console.error('❌ Error:', error)
    } finally {
        await sql.end()
    }
}

fixCustomerPassword()

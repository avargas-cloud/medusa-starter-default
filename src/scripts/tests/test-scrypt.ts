import { scrypt, randomBytes } from 'crypto'
import { promisify } from 'util'

const scryptAsync = promisify(scrypt)

async function testScrypt() {
    const password = "FinalFinalTest123!"
    const salt = randomBytes(16)

    console.log('Testing Scrypt hash generation...')
    console.log('Password:', password)
    console.log('Salt:', salt.toString('hex'))

    try {
        const hashedPassword = await scryptAsync(password, salt, 64) as Buffer
        console.log('✅ Hash generated:', hashedPassword.toString('hex'))

        // Medusa v2 format
        const passwordHash = Buffer.concat([
            Buffer.from('scrypt'),
            Buffer.from([0, 15, 0, 0, 0, 8, 0, 0, 0, 1]), // scrypt params header
            salt,
            hashedPassword
        ]).toString('base64')

        console.log('✅ Final password hash (base64):', passwordHash)
        console.log('Hash length:', passwordHash.length)
    } catch (err) {
        console.error('❌ Error:', err)
    }
}

testScrypt()

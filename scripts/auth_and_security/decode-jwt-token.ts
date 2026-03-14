import jwt from 'jsonwebtoken'

// Get token from command line argument
const token = process.argv[2]

if (!token) {
    console.error('❌ Please provide a JWT token as argument')
    console.log('\nUsage:')
    console.log('  npx tsx src/scripts/decode-jwt-token.ts <token>')
    process.exit(1)
}

try {
    // Decode without verification (just to inspect payload)
    const decoded = jwt.decode(token)

    console.log('\n🔍 JWT Token Payload:\n')
    console.log(JSON.stringify(decoded, null, 2))

    if (decoded && typeof decoded === 'object') {
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')

        if ('actor_id' in decoded) {
            if (decoded.actor_id) {
                console.log('✅ actor_id:', decoded.actor_id)
            } else {
                console.log('❌ actor_id is EMPTY')
            }
        }

        if ('actor_type' in decoded) {
            console.log('✅ actor_type:', decoded.actor_type)
        }

        if ('auth_identity_id' in decoded) {
            console.log('✅ auth_identity_id:', decoded.auth_identity_id)
        }

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
    }

} catch (error) {
    console.error('❌ Error decoding token:', error)
    process.exit(1)
}

import { Modules } from "@medusajs/utils"
import { initialize } from '@medusajs/framework'
import { loadEnv } from "@medusajs/utils"

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

async function findAdminUsers() {
    console.log('🔍 Searching for admin users...\n')

    const { container } = await initialize()

    try {
        const userModule = container.resolve(Modules.USER)

        const users = await userModule.listUsers()

        if (users.length === 0) {
            console.log('⚠️  No users found in database')
        } else {
            console.log(`✅ Found ${users.length} user(s):\n`)
            users.forEach((user, index) => {
                console.log(`${index + 1}. Email: ${user.email}`)
                console.log(`   Name: ${user.first_name || 'N/A'} ${user.last_name || ''}`)
                console.log(`   ID: ${user.id}`)
                console.log(`   Created: ${user.created_at}`)
                console.log('')
            })

            console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
            console.log('📧 Use one of these emails to login to admin dashboard')
            console.log('🔑 If you forgot the password, use password reset or create a new user')
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
        }

    } catch (error) {
        console.error('❌ Error querying users:', error)
    } finally {
        process.exit(0)
    }
}

findAdminUsers()

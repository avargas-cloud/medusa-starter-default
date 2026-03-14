import 'dotenv/config'
import postgres from 'postgres'

async function investigateBillingAddress() {
    const sql = postgres(process.env.DATABASE_URL!)

    console.log('\n🔍 INVESTIGACIÓN: Dónde está billing_address_id?\n')

    try {
        // 1. Buscar todas las tablas que contengan "customer" o "address"
        console.log('1️⃣  Buscando tablas relacionadas...\n')
        const tables = await sql`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND (table_name LIKE '%customer%' OR table_name LIKE '%address%')
            ORDER BY table_name
        `

        console.log('Tablas encontradas:')
        tables.forEach(t => console.log(`   - ${t.table_name}`))

        // 2. Buscar columnas que contengan "billing" o "default" en CUALQUIER tabla
        console.log('\n2️⃣  Buscando columnas con "billing" o "default_address"...\n')
        const billingColumns = await sql`
            SELECT table_name, column_name, data_type
            FROM information_schema.columns 
            WHERE table_schema = 'public'
            AND (column_name LIKE '%billing%' OR column_name LIKE '%default%address%')
            ORDER BY table_name, column_name
        `

        if (billingColumns.length === 0) {
            console.log('   ❌ No se encontraron columnas con "billing" o "default_address"')
        } else {
            console.log('Columnas encontradas:')
            billingColumns.forEach(c => {
                console.log(`   ✅ ${c.table_name}.${c.column_name} (${c.data_type})`)
            })
        }

        // 3. Ver schema completo de la tabla "address"
        console.log('\n3️⃣  Schema de la tabla ADDRESS:\n')
        const addressColumns = await sql`
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns 
            WHERE table_name = 'address'
            ORDER BY ordinal_position
        `

        addressColumns.forEach((col, i) => {
            console.log(`${i + 1}. ${col.column_name} (${col.data_type}) ${col.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'}`)
        })

        // 4. Buscar tablas de link/relación
        console.log('\n4️⃣  Buscando tablas de relación (link tables)...\n')
        const linkTables = await sql`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name LIKE '%customer%address%'
            ORDER BY table_name
        `

        if (linkTables.length === 0) {
            console.log('   ❌ No se encontraron tablas de link')
        } else {
            console.log('Tablas de link encontradas:')
            for (const t of linkTables) {
                console.log(`\n   📋 ${t.table_name}:`)
                const cols = await sql`
                    SELECT column_name, data_type
                    FROM information_schema.columns 
                    WHERE table_name = ${t.table_name}
                `
                cols.forEach(c => console.log(`      - ${c.column_name} (${c.data_type})`))
            }
        }

        // 5. Query real de customer con addresses
        console.log('\n5️⃣  Probando query con GraphQL/RemoteQuery pattern...\n')
        const [testCustomer] = await sql`
            SELECT c.*, 
                   (SELECT json_agg(a.*) FROM address a WHERE a.customer_id = c.id) as addresses_json
            FROM customer c
            WHERE c.email = 'a.vargas@ecopowertech.com'
            LIMIT 1
        `

        if (testCustomer) {
            console.log(`Customer: ${testCustomer.email}`)
            console.log(`Direct columns:`, Object.keys(testCustomer).filter(k => k !== 'addresses_json'))
            console.log(`Has addresses_json: ${!!testCustomer.addresses_json}`)
        }

    } catch (error) {
        console.error('\n❌ Error:', error)
    } finally {
        await sql.end()
        process.exit(0)
    }
}

investigateBillingAddress()

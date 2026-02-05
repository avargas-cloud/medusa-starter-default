import postgres from 'postgres'
async function getToken() {
    const sql = postgres(process.env.DATABASE_URL!)
    const result = await sql`SELECT metadata->>'reset_token' as token FROM customer WHERE email = 'a.vargas@ecopowertech.com' LIMIT 1`
    console.log(result[0]?.token || 'NO_TOKEN')
    await sql.end()
}
getToken()

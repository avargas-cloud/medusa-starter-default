import postgres from 'postgres'
const sql = postgres(process.env.DATABASE_URL)
const r = await sql`SELECT metadata->>'reset_token' as token FROM customer WHERE email = 'a.vargas@ecopowertech.com'`
console.log(r[0]?.token || "NO_TOKEN")
await sql.end()

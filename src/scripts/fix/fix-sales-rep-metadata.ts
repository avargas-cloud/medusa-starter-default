/**
 * fix-sales-rep-metadata.ts
 *
 * Normalizes sales_rep metadata on ALL orders and credit memos to the canonical format:
 *   { initials: "AVP", name: "Alejandro Vargas" }
 *
 * Fixes these broken shapes:
 *   "AVP"                          → plain string (initials only)
 *   { initials: "AVP", name: "" }  → object with blank name
 *   { initials: "AVP", name: null } → object with null name
 *
 * Lookup source: system_defaults table (Global / Sales Rep User rows).
 *
 * Usage:
 *   cd backend
 *   yarn ts-node src/scripts/fix/fix-sales-rep-metadata.ts           # dry run (default)
 *   yarn ts-node src/scripts/fix/fix-sales-rep-metadata.ts --apply   # write to DB
 */

import { Client } from 'pg'
import * as dotenv from 'dotenv'
import { resolve } from 'path'

dotenv.config({ path: resolve(__dirname, '../../../.env') })

const DRY_RUN = !process.argv.includes('--apply')

// ── DB ────────────────────────────────────────────────────────────────────────

const db = () => new Client({ connectionString: process.env.DATABASE_URL })

// ── Helpers ───────────────────────────────────────────────────────────────────

interface SalesRepEntry { initials: string; name: string }

function isBroken(raw: unknown): boolean {
    if (!raw) return false
    if (typeof raw === 'string') return raw.trim().length > 0  // plain string = broken
    if (typeof raw === 'object' && raw !== null && 'initials' in raw) {
        const obj = raw as { initials?: string; name?: string }
        // Has initials but name is missing/empty
        return !!(obj.initials?.trim()) && !obj.name?.trim()
    }
    return false
}

function getInitials(raw: unknown): string | null {
    if (typeof raw === 'string') return raw.trim() || null
    if (typeof raw === 'object' && raw !== null && 'initials' in raw) {
        const obj = raw as { initials?: string }
        return obj.initials?.trim() || null
    }
    return null
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    console.log(`\n🔧 fix-sales-rep-metadata — ${DRY_RUN ? 'DRY RUN (no writes)' : 'APPLY MODE'}\n`)

    const client = db()
    await client.connect()

    try {
        // 1. Build initials → name lookup from system_defaults
        const { rows: repRows } = await client.query<{ value: string }>(
            `SELECT value FROM system_defaults WHERE context = 'Global' AND field_name = 'Sales Rep User'`
        )
        const repMap = new Map<string, string>()  // initials → full name
        for (const row of repRows) {
            try {
                const parsed = JSON.parse(row.value) as { initials?: string; name?: string }
                if (parsed.initials?.trim() && parsed.name?.trim()) {
                    repMap.set(parsed.initials.trim(), parsed.name.trim())
                }
            } catch { /* malformed row — skip */ }
        }

        // Also build a reverse name → initials map for corrupted entries
        // where the full name was accidentally stored as the initials field
        const nameToInitials = new Map<string, string>()
        for (const [initials, name] of repMap) nameToInitials.set(name.toLowerCase(), initials)

        console.log(`📋 Sales rep lookup built: ${repMap.size} entries`)
        for (const [k, v] of repMap) console.log(`   ${k} → ${v}`)
        console.log()

        // 2. Fix order table (covers both estimates/draft-orders and confirmed orders)
        await fixTable(client, repMap, nameToInitials, '"order"', 'id', 'metadata')

        // 3. Fix credit memo table (uses sales_rep column — only after migration runs)
        try {
            await fixTable(client, repMap, nameToInitials, 'pos_credit_memo', 'id', 'sales_rep', true)
        } catch (e: any) {
            if (e.code === '42703') {
                console.log('⏭  pos_credit_memo.sales_rep column not yet created — run migration first, then re-run this script.\n')
            } else throw e
        }

        console.log(`\n${DRY_RUN ? '✅ Dry run complete — run with --apply to write changes.' : '✅ Done — all records normalized.'}`)

    } finally {
        await client.end()
    }
}

/**
 * @param directColumn  When true, `metaCol` is a standalone jsonb column (pos_credit_memo.sales_rep).
 *                      When false, `metaCol` is a jsonb metadata bag and we patch the 'sales_rep' key inside it.
 */
async function fixTable(
    client: Client,
    repMap: Map<string, string>,
    nameToInitials: Map<string, string>,
    table: string,
    idCol: string,
    metaCol: string,
    directColumn = false,
) {
    const salesRepExpr = directColumn ? metaCol : `${metaCol}->'sales_rep'`
    const whereNotNull = directColumn
        ? `${metaCol} IS NOT NULL AND ${metaCol} != 'null'::jsonb`
        : `${metaCol} IS NOT NULL AND ${metaCol}->'sales_rep' IS NOT NULL AND ${metaCol}->'sales_rep' != 'null'::jsonb`
    const brokenWhere = directColumn
        ? `(jsonb_typeof(${metaCol}) = 'string'
           OR (jsonb_typeof(${metaCol}) = 'object'
               AND (${metaCol}->>'name' IS NULL OR ${metaCol}->>'name' = '')))`
        : `(jsonb_typeof(${metaCol}->'sales_rep') = 'string'
           OR (jsonb_typeof(${metaCol}->'sales_rep') = 'object'
               AND (${metaCol}->'sales_rep'->>'name' IS NULL OR ${metaCol}->'sales_rep'->>'name' = '')))`

    const { rows } = await client.query<{ id: string; sales_rep: unknown }>(
        `SELECT ${idCol} AS id, ${salesRepExpr} AS sales_rep
         FROM ${table}
         WHERE ${whereNotNull} AND (${brokenWhere})`
    )

    console.log(`📄 ${table}: ${rows.length} broken record(s) found`)

    let fixed = 0
    let skipped = 0

    for (const row of rows) {
        if (!isBroken(row.sales_rep)) continue

        // Try initials lookup first, then reverse name lookup for corrupted entries
        let initials = getInitials(row.sales_rep)
        let name: string | undefined

        if (initials) {
            name = repMap.get(initials)
            if (!name) {
                // Initials field contains a full name (e.g. "Alejandro Vargas") — reverse lookup
                const reversed = nameToInitials.get(initials.toLowerCase())
                if (reversed) {
                    name = repMap.get(reversed)!
                    initials = reversed
                }
            }
        }

        if (!initials || !name) {
            console.log(`   ⚠️  ${row.id} — "${JSON.stringify(row.sales_rep)}" unresolvable, skipping`)
            skipped++
            continue
        }

        const canonical = JSON.stringify({ initials, name })
        console.log(`   ${DRY_RUN ? '[dry]' : '[fix]'} ${row.id}  "${JSON.stringify(row.sales_rep)}" → ${canonical}`)

        if (!DRY_RUN) {
            if (directColumn) {
                await client.query(
                    `UPDATE ${table} SET ${metaCol} = $1::jsonb WHERE ${idCol} = $2`,
                    [canonical, row.id]
                )
            } else {
                await client.query(
                    `UPDATE ${table} SET ${metaCol} = jsonb_set(${metaCol}, '{sales_rep}', $1::jsonb) WHERE ${idCol} = $2`,
                    [canonical, row.id]
                )
            }
        }
        fixed++
    }

    console.log(`   → ${fixed} would be fixed, ${skipped} skipped\n`)
}

main().catch(err => { console.error(err); process.exit(1) })

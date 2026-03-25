import { MedusaContainer } from "@medusajs/framework/types"

export default async function inspectCreditMemo({ container }: { container: MedusaContainer }) {
  const query = container.resolve("query") as any
  const args = process.argv.slice(2)
  const memoId = args.find(a => !a.startsWith("--"))

  if (!memoId) {
    console.error("❌ Please provide a Credit Memo ID.")
    console.error("Example: npx medusa exec ./src/scripts/diagnostics/inspect-credit-memo.ts cmemo_123")
    process.exit(1)
  }

  console.log(`\n🔍 Inspecting Credit Memo: ${memoId} ...\n`)

  try {
    const { data: [memo] } = await query.graph({
      entity: "credit_memo", // Match the actual data model name
      fields: ["*"],
      filters: { id: memoId }
    })

    if (!memo) {
      console.log(`❌ Credit Memo ${memoId} not found in 'credit_memo' entity.`)
      return
    }

    console.log("--- CREDIT MEMO RESULTS ---")
    console.log(JSON.stringify(memo, null, 2))

  } catch (error) {
    console.error("❌ Error fetching credit memo:", error)
  }
}

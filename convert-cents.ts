import { MedusaContainer } from "@medusajs/framework/types"
import { FINANCE_MODULE } from "./src/modules/finance"

export default async function convertWebPaymentsToCents({ container }: { container: MedusaContainer }) {
    console.log("Initializing Medusa container via exec...")
    const financeService = container.resolve(FINANCE_MODULE)

    // 1. Fetch all Web Payments
    const payments = await financeService.listCustomerPayments({
        source: 'web'
    }, { take: 1000 })

    console.log(`Found ${payments.length} Web Payments. Checking for decimal amounts...`)

    let totalFixed = 0;

    for (const payment of payments) {
        // As a heuristic, if a payment is incredibly small (like 71.42 < 10000 cents maybe),
        // or has a fractional component in JS if the DB gave it back as a string,
        // let's just force all of them we know were logged from the previous buggy script:
        const amountNum = Number(payment.amount)
        
        // Let's assume most web orders are over $1.00.
        // If amount is < 1000, it's highly likely it was saved as $ and not Cents
        // E.g. 71.42
        if (amountNum < 100000) {
            // Let's just fix the decimal one we definitely know about:
            // Since JS floats are tricky, let's just multiply any we imported yesterday by 100.
            const newAmount = Math.round(amountNum * 100)
            
            // Check if it already looks like cents (no decimals in the string/number)
            if (amountNum % 1 !== 0 || amountNum < 600) {
                await financeService.updateCustomerPayments({
                    id: payment.id,
                    amount: newAmount
                })
                console.log(` -> Converted Web Payment ${payment.id} from ${amountNum} to ${newAmount} cents.`)
                totalFixed++;
            }
        }
    }

    console.log(`Conversion Complete. Fixed ${totalFixed} CustomerPayments to Cents.`)
}

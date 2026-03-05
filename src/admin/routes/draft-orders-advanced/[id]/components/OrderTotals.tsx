import { Container, Heading, Text } from "@medusajs/ui"
import { fmt } from "../helpers"

interface Props {
    subtotal: number
    shippingTotal: number
    discountTotal: number
    taxTotal: number
    total: number
    itemCount: number
    curr: string
    /** Tax rate as a percentage (e.g. 7 for 7%). If provided shows "Tax (7%)" label. */
    taxRate?: number
}

export const OrderTotals = ({ subtotal, shippingTotal, discountTotal, taxTotal, total, itemCount, curr, taxRate }: Props) => (
    <Container className="p-0 overflow-hidden">
        <div className="px-6 py-4 border-b border-ui-border-base">
            <Heading level="h2">Order Total</Heading>
        </div>
        <div className="px-6 py-4 space-y-2">
            {([
                ["Subtotal", subtotal, `${itemCount} item${itemCount !== 1 ? "s" : ""}`],
                ["Shipping", shippingTotal, null],
                ["Discount", discountTotal, null],
                [taxRate != null ? `Tax (${taxRate}%)` : "Tax", taxTotal, null],
            ] as const).map(([lbl, val, note]) => (
                <div key={lbl as string} className="flex justify-between">
                    <Text size="small" className="text-ui-fg-subtle">
                        {lbl as string}
                        {note && <span className="text-ui-fg-muted ml-1 text-xs">{note}</span>}
                    </Text>
                    <Text size="small">{fmt(val as number, curr)}</Text>
                </div>
            ))}
            <div className="flex justify-between border-t border-ui-border-base pt-2 mt-2">
                <Text size="small" weight="plus">Total</Text>
                <Text size="small" weight="plus">{fmt(total, curr)} {curr.toUpperCase()}</Text>
            </div>
        </div>
    </Container>
)

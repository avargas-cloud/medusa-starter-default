import { Container, Heading, Badge, Text } from "@medusajs/ui"
import { InlinePromoInput } from "./InlinePromoInput"
import { fmt } from "../helpers"

interface Props {
    orderId: string
    promotions: any[]
    discountTotal: number
    curr: string
    onApplied: () => void
}

export const PromotionsBlock = ({ orderId, promotions, discountTotal, curr, onApplied }: Props) => (
    <Container className="p-0 overflow-hidden">
        <div className="px-6 py-4">
            <div className="flex items-center gap-2 mb-3">
                <Heading level="h2">Promotions</Heading>
                {promotions.length > 0 && <Badge color="blue" size="small">{promotions.length}</Badge>}
            </div>
            <InlinePromoInput orderId={orderId} onApplied={onApplied} />
            {promotions.length > 0 && (
                <div className="mt-3 space-y-1.5">
                    {promotions.map((p: any) => (
                        <div key={p.id} className="flex items-center justify-between bg-ui-bg-subtle rounded px-3 py-2">
                            <div className="flex items-center gap-2">
                                <Badge color="purple" size="small">{p.code ?? "PROMO"}</Badge>
                                <Text size="xsmall" className="text-ui-fg-subtle">
                                    {p.type === "percentage" ? `${p.value}% off` : p.type === "fixed" ? "Fixed discount" : p.type ?? ""}
                                </Text>
                            </div>
                            {discountTotal > 0 && (
                                <Text size="small" className="text-ui-fg-base font-medium">-{fmt(discountTotal, curr)}</Text>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    </Container>
)

import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps, AdminProduct } from "@medusajs/framework/types"
import { Container, Heading, Badge, Text, Copy } from "@medusajs/ui"

/**
 * QuickBooks ID Widget
 * 
 * Displays QuickBooks ListID stored in product and variant metadata
 * Location: Product Detail Page > After general section
 */

const QuickBooksIdWidget = ({ data }: DetailWidgetProps<AdminProduct>) => {
    const productQbId = data.metadata?.quickbooks_id as string | undefined

    // Check if ANY variant has QuickBooks ID
    const variantsWithQb = data.variants?.filter(v => v.metadata?.quickbooks_id) || []
    const hasVariantQbIds = variantsWithQb.length > 0

    // Don't show widget if no QuickBooks IDs exist
    if (!productQbId && !hasVariantQbIds) {
        return null
    }

    return (
        <Container className="p-6">
            <div className="flex items-center gap-2 mb-4">
                <Heading level="h2">QuickBooks Integration</Heading>
                <Badge color="blue" size="small">QB Desktop</Badge>
            </div>

            {/* Product-Level QuickBooks ID */}
            {productQbId && (
                <div className="mb-4 p-4 bg-ui-bg-subtle rounded-md">
                    <Text size="small" weight="plus" className="text-ui-fg-subtle mb-1">
                        Product ListID
                    </Text>
                    <div className="flex items-center gap-2">
                        <Text className="font-mono text-sm">{productQbId}</Text>
                        <Copy content={productQbId} className="text-ui-fg-muted" />
                    </div>
                </div>
            )}

            {/* Variant-Level QuickBooks IDs */}
            {hasVariantQbIds && (
                <div>
                    <Text size="small" weight="plus" className="text-ui-fg-subtle mb-2">
                        Variant ListIDs ({variantsWithQb.length})
                    </Text>
                    <div className="space-y-2">
                        {variantsWithQb.map(variant => (
                            <div key={variant.id} className="flex items-center justify-between p-3 bg-ui-bg-base border border-ui-border-base rounded-md">
                                <div className="flex-1">
                                    <Text size="small" weight="plus">
                                        {variant.title || variant.sku}
                                    </Text>
                                    <Text size="xsmall" className="text-ui-fg-muted font-mono">
                                        {variant.metadata?.quickbooks_id as string}
                                    </Text>
                                </div>
                                <Copy
                                    content={variant.metadata?.quickbooks_id as string}
                                    className="text-ui-fg-muted"
                                />
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Info Footer */}
            <div className="mt-4 p-3 bg-ui-bg-subtle-hover rounded-md">
                <Text size="xsmall" className="text-ui-fg-subtle">
                    💡 QuickBooks Desktop ListIDs are permanent identifiers used for synchronization
                </Text>
            </div>
        </Container>
    )
}

export const config = defineWidgetConfig({
    zone: "product.details.after",
})

export default QuickBooksIdWidget

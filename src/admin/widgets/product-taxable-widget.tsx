import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps, AdminProduct } from "@medusajs/framework/types"
import { Container, Heading, Switch, Text, toast } from "@medusajs/ui"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"

import { BASE_URL } from "../../lib/sdk"

/**
 * Product Detail widget: per-product Tax flag.
 *
 * Backed by the dedicated /admin/product-taxable/:id endpoint (raw column,
 * outside Medusa's entity model). When toggled, the value flows automatically
 * to every NEW order_line_item via the BEFORE-INSERT trigger
 * trg_order_line_item_taxable_default.
 */
const ProductTaxableWidget = ({ data: productData }: DetailWidgetProps<AdminProduct>) => {
    const queryClient = useQueryClient()

    const { data: taxableRes, isLoading } = useQuery({
        queryKey: ["product", productData.id, "taxable"],
        queryFn: async () => {
            const res = await fetch(
                `${BASE_URL}/admin/product-taxable/${productData.id}`,
                { credentials: "include" }
            )
            if (!res.ok) throw new Error("Failed to fetch taxable flag")
            return res.json() as Promise<{ product: { id: string; taxable: boolean } }>
        },
    })

    const taxable = taxableRes?.product?.taxable ?? true

    const updateMutation = useMutation({
        mutationFn: async (value: boolean) => {
            const res = await fetch(`${BASE_URL}/admin/product-taxable/${productData.id}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ taxable: value }),
            })
            if (!res.ok) throw new Error("Failed to update taxable flag")
            return res.json()
        },
        onSuccess: (_, value) => {
            toast.success(value ? "Product is now taxable" : "Product marked non-taxable")
            queryClient.invalidateQueries({ queryKey: ["product", productData.id, "taxable"] })
        },
        onError: (err) => {
            toast.error("Failed to update", { description: (err as Error).message })
        },
    })

    return (
        <Container className="divide-y p-0">
            <div className="flex items-center justify-between px-6 py-4">
                <Heading level="h2">Tax</Heading>
            </div>
            <div className="flex items-center justify-between px-6 py-4">
                <div className="flex flex-col gap-0.5">
                    <Text size="small" weight="plus">Charge sales tax</Text>
                    <Text size="small" className="text-ui-fg-subtle">
                        When off, this product&apos;s line items are exempt from FL 7% sales tax.
                        Use for services and labor (e.g. INSTALL).
                    </Text>
                </div>
                {isLoading ? (
                    <div className="w-9 h-5 rounded-full bg-ui-bg-switch-off animate-pulse" />
                ) : (
                    <Switch
                        checked={taxable}
                        onCheckedChange={(val) => updateMutation.mutate(val)}
                        disabled={updateMutation.isPending}
                    />
                )}
            </div>
        </Container>
    )
}

export const config = defineWidgetConfig({
    zone: "product.details.side.after",
})

export default ProductTaxableWidget

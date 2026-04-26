import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { DetailWidgetProps, AdminProduct } from "@medusajs/framework/types"
import { Container, Heading, Switch, Text, toast } from "@medusajs/ui"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"

import { BASE_URL } from "../../lib/sdk"

const SourcingAgentWidget = ({ data: productData }: DetailWidgetProps<AdminProduct>) => {
    const queryClient = useQueryClient()

    const { data: response, isLoading } = useQuery({
        queryKey: ["product", productData.id, "sourcing-agent"],
        queryFn: async () => {
            const res = await fetch(
                `${BASE_URL}/admin/products/${productData.id}?fields=+metadata`,
                { credentials: "include" }
            )
            if (!res.ok) throw new Error("Failed to fetch product")
            return res.json()
        },
    })

    const product = response?.product
    const isSourced = !!(product?.metadata?.is_sourced_via_agent)

    const updateMutation = useMutation({
        mutationFn: async (value: boolean) => {
            const res = await fetch(`${BASE_URL}/admin/products/${productData.id}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({
                    metadata: { ...product?.metadata, is_sourced_via_agent: value },
                }),
            })
            if (!res.ok) throw new Error("Failed to update product")
            return res.json()
        },
        onSuccess: (_, value) => {
            toast.success(value ? "Marked as sourced via agent" : "Sourcing agent flag removed")
            queryClient.invalidateQueries({ queryKey: ["product", productData.id] })
        },
        onError: (err) => {
            toast.error("Failed to update", { description: (err as Error).message })
        },
    })

    return (
        <Container className="divide-y p-0">
            <div className="flex items-center justify-between px-6 py-4">
                <Heading level="h2">Sourcing</Heading>
            </div>
            <div className="flex items-center justify-between px-6 py-4">
                <div className="flex flex-col gap-0.5">
                    <Text size="small" weight="plus">Source Via Agent</Text>
                    <Text size="small" className="text-ui-fg-subtle">
                        Product is purchased through a China sourcing agent (e.g. Veetech)
                    </Text>
                </div>
                {isLoading ? (
                    <div className="w-9 h-5 rounded-full bg-ui-bg-switch-off animate-pulse" />
                ) : (
                    <Switch
                        checked={isSourced}
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

export default SourcingAgentWidget

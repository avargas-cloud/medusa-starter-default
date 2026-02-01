import { defineRouteConfig } from "@medusajs/admin-sdk"
import { BuildingStorefront } from "@medusajs/icons"
import { Container, Heading, Button, Text } from "@medusajs/ui"
import { useState } from "react"

const QuickBooksPage = () => {
    const [syncing, setSyncing] = useState(false)

    return (
        <div className="flex flex-col gap-6 p-8 max-w-7xl">
            <div>
                <Heading level="h1">QuickBooks Desktop Integration</Heading>
                <Text className="text-ui-fg-subtle mt-2">
                    Manual synchronization controls for QuickBooks Desktop via Bridge API
                </Text>
            </div>

            <Container>
                <div className="p-6">
                    <Heading level="h2" className="mb-4">Inventory Sync</Heading>
                    <Text size="small" className="text-ui-fg-subtle mb-4">
                        Sync stock levels from QuickBooks to Medusa
                    </Text>
                    <Button
                        onClick={() => setSyncing(true)}
                        isLoading={syncing}
                        disabled={syncing}
                    >
                        Sync Inventory
                    </Button>
                </div>
            </Container>

            <Container>
                <div className="p-6">
                    <Heading level="h2" className="mb-4">Price Sync</Heading>
                    <Text size="small" className="text-ui-fg-subtle mb-4">
                        Sync product prices from QuickBooks to Medusa
                    </Text>
                    <Button
                        onClick={() => setSyncing(true)}
                        isLoading={syncing}
                        disabled={syncing}
                    >
                        Sync Prices
                    </Button>
                </div>
            </Container>
        </div>
    )
}

export const config = defineRouteConfig({
    label: "QuickBooks",
    icon: BuildingStorefront,
})

export default QuickBooksPage

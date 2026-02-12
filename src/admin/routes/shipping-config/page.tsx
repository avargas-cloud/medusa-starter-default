import { defineRouteConfig } from "@medusajs/admin-sdk"
import { TruckFast } from "@medusajs/icons"
import { Container, Heading, Button, Input, Label, Text, toast } from "@medusajs/ui"
import { useState, useEffect } from "react"

const ShippingConfigPage = () => {
    const [loading, setLoading] = useState(false)
    const [freeShippingMin, setFreeShippingMin] = useState("")
    const [regularGroundPrice, setRegularGroundPrice] = useState("")
    const [longItemPrice, setLongItemPrice] = useState("")

    useEffect(() => {
        const loadSettings = async () => {
            try {
                const res = await fetch('/admin/shipping-settings', {
                    method: 'GET',
                    credentials: 'include',
                })
                if (!res.ok) return

                const data = await res.json()
                const settings = data.settings

                setFreeShippingMin((settings.free_shipping_minimum / 100).toFixed(2))
                setRegularGroundPrice((settings.regular_ground_shipping_price / 100).toFixed(2))
                setLongItemPrice((settings.long_item_ground_shipping_price / 100).toFixed(2))
            } catch (error) {
                console.error('Failed to load settings:', error)
            }
        }
        loadSettings()
    }, [])

    const handleSave = async () => {
        const freeShipNum = parseFloat(freeShippingMin)
        const regularNum = parseFloat(regularGroundPrice)
        const longNum = parseFloat(longItemPrice)

        if (isNaN(freeShipNum) || freeShipNum < 0) {
            toast.error("Validation Error", {
                description: "Free shipping minimum must be a valid non-negative number",
            })
            return
        }

        if (isNaN(regularNum) || regularNum < 0) {
            toast.error("Validation Error", {
                description: "Regular ground shipping price must be a valid non-negative number",
            })
            return
        }

        if (isNaN(longNum) || longNum < 0) {
            toast.error("Validation Error", {
                description: "Long item ground shipping price must be a valid non-negative number",
            })
            return
        }

        setLoading(true)
        try {
            const res = await fetch('/admin/shipping-settings', {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    free_shipping_minimum: Math.round(freeShipNum * 100),
                    regular_ground_shipping_price: Math.round(regularNum * 100),
                    long_item_ground_shipping_price: Math.round(longNum * 100),
                })
            })

            if (!res.ok) {
                const errorData = await res.json()
                toast.error("Failed to save settings", {
                    description: errorData.error || "Unknown error occurred",
                })
                return
            }

            toast.success("Settings updated", {
                description: `Free shipping at $${freeShipNum.toFixed(2)} • Ground: $${regularNum.toFixed(2)} • Long items: $${longNum.toFixed(2)}`,
            })
        } catch (error) {
            toast.error("Failed to save settings", {
                description: error instanceof Error ? error.message : "Unknown error",
            })
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="flex flex-col gap-3 p-6 max-w-7xl">
            <div>
                <Heading level="h1">Shipping Settings</Heading>
            </div>

            <Container>
                <div className="p-4 space-y-3">
                    <Heading level="h3" className="text-sm font-medium">Free Shipping</Heading>

                    <div className="space-y-2">
                        <Label htmlFor="free-shipping-min" className="mb-1 block text-xs">
                            Minimum Order Amount ($)
                        </Label>
                        <Input
                            id="free-shipping-min"
                            type="number"
                            min="0"
                            step="0.01"
                            value={freeShippingMin}
                            onChange={(e) => setFreeShippingMin(e.target.value)}
                            placeholder="0.00"
                        />
                        <Text size="small" className="text-gray-600">
                            Orders above this amount qualify for free shipping
                        </Text>
                    </div>
                </div>
            </Container>

            <Container>
                <div className="p-4 space-y-3">
                    <Heading level="h3" className="text-sm font-medium">Regular Ground Shipping</Heading>

                    <div className="space-y-2">
                        <Label htmlFor="regular-ground-price" className="mb-1 block text-xs">
                            Price for Regular Items ($)
                        </Label>
                        <Input
                            id="regular-ground-price"
                            type="number"
                            min="0"
                            step="0.01"
                            value={regularGroundPrice}
                            onChange={(e) => setRegularGroundPrice(e.target.value)}
                            placeholder="0.00"
                        />
                        <Text size="small" className="text-gray-600">
                            Flat shipping rate for regular items
                        </Text>
                    </div>
                </div>
            </Container>

            <Container>
                <div className="p-4 space-y-3">
                    <Heading level="h3" className="text-sm font-medium">Long Item Ground Shipping</Heading>

                    <div className="space-y-2">
                        <Label htmlFor="long-item-price" className="mb-1 block text-xs">
                            Price for Long Items ($)
                        </Label>
                        <Input
                            id="long-item-price"
                            type="number"
                            min="0"
                            step="0.01"
                            value={longItemPrice}
                            onChange={(e) => setLongItemPrice(e.target.value)}
                            placeholder="0.00"
                        />
                        <Text size="small" className="text-gray-600">
                            Flat rate when order contains items with long shipping profile
                        </Text>
                    </div>
                </div>
            </Container>

            <div className="flex justify-end">
                <Button
                    onClick={handleSave}
                    isLoading={loading}
                    disabled={loading}
                >
                    Save Settings
                </Button>
            </div>
        </div>
    )
}

export const config = defineRouteConfig({
    label: "Shipping",
    icon: TruckFast,
})

export default ShippingConfigPage

import { defineRouteConfig } from "@medusajs/admin-sdk"
import { BuildingStorefront } from "@medusajs/icons"
import { Container, Heading, Button, Text, Select, Label } from "@medusajs/ui"
import { useState, useEffect } from "react"

const QuickBooksPage = () => {
    const [inventorySyncing, setInventorySyncing] = useState(false)
    const [priceSyncing, setPriceSyncing] = useState(false)
    const [customerSyncing, setCustomerSyncing] = useState(false)
    const [inventoryInterval, setInventoryInterval] = useState("disabled")
    const [priceInterval, setPriceInterval] = useState("disabled")
    const [customerInterval, setCustomerInterval] = useState("disabled")
    const [priceTimeOfDay, setPriceTimeOfDay] = useState("00:00")
    const [customerTimeOfDay, setCustomerTimeOfDay] = useState("00:00")
    const [showAuditModal, setShowAuditModal] = useState(false)
    const [auditData, setAuditData] = useState<any>(null)

    // Load saved config on mount
    useEffect(() => {
        const loadConfig = async () => {
            try {
                const res = await fetch('/admin/quickbooks/config', {
                    method: 'GET',
                    credentials: 'include',
                })
                if (!res.ok) return

                const data = await res.json()
                const config = data.config

                // Load intervals (convert from minutes to display format)
                if (config.inventory_interval_minutes !== null && config.inventory_interval_minutes !== undefined) {
                    setInventoryInterval(config.inventory_interval_minutes.toString())
                } else {
                    setInventoryInterval('disabled')
                }

                if (config.price_interval_minutes !== null && config.price_interval_minutes !== undefined) {
                    const hours = Math.floor(config.price_interval_minutes / 60)
                    setPriceInterval(hours.toString())
                } else {
                    setPriceInterval('disabled')
                }

                if (config.customer_interval_minutes !== null && config.customer_interval_minutes !== undefined) {
                    const hours = Math.floor(config.customer_interval_minutes / 60)
                    setCustomerInterval(hours.toString())
                } else {
                    setCustomerInterval('disabled')
                }
            } catch (error) {
                console.error('Failed to load config:', error)
            }
        }
        loadConfig()
    }, [])

    // Inventory intervals in minutes
    const inventoryIntervals = [
        { value: "disabled", label: "Disabled" },
        { value: "1", label: "1 minute" },
        { value: "2", label: "2 minutes" },
        { value: "3", label: "3 minutes" },
        { value: "5", label: "5 minutes" },
        { value: "10", label: "10 minutes" },
        { value: "20", label: "20 minutes" },
        { value: "25", label: "25 minutes" },
        { value: "30", label: "30 minutes" },
        { value: "45", label: "45 minutes" },
        { value: "60", label: "60 minutes" },
    ]

    // Price intervals in hours
    const priceIntervals = [
        { value: "disabled", label: "Disabled" },
        { value: "1", label: "1 hour" },
        { value: "2", label: "2 hours" },
        { value: "5", label: "5 hours" },
        { value: "10", label: "10 hours" },
        { value: "24", label: "24 hours" },
    ]

    // Time of day options (00:00 to 23:00)
    const timeOfDayOptions = Array.from({ length: 24 }, (_, i) => {
        const hour = i.toString().padStart(2, '0')
        return { value: `${hour}:00`, label: `${hour}:00` }
    })

    const calculateNextInventorySync = (intervalMinutes: string): string => {
        if (intervalMinutes === 'disabled') return 'Disabled'

        const now = new Date()
        const minutes = parseInt(intervalMinutes)
        const nextSync = new Date(now.getTime() + minutes * 60000)

        return nextSync.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        })
    }

    const calculateNextPriceSync = (intervalHours: string, timeOfDay: string): string => {
        if (intervalHours === 'disabled') return 'Disabled'

        const now = new Date()

        if (intervalHours === '24') {
            // For 24 hours, use the specific time of day
            const [targetHour, targetMinute] = timeOfDay.split(':').map(Number)
            const nextSync = new Date()
            nextSync.setHours(targetHour, targetMinute, 0, 0)

            // If the time has already passed today, schedule for tomorrow
            if (nextSync <= now) {
                nextSync.setDate(nextSync.getDate() + 1)
            }

            const isToday = nextSync.getDate() === now.getDate()
            const timeStr = nextSync.toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            })

            return isToday ? `Today at ${timeStr}` : `Tomorrow at ${timeStr}`
        } else {
            // For other intervals, calculate based on hours from now
            const hours = parseInt(intervalHours)
            const nextSync = new Date(now.getTime() + hours * 3600000)

            return nextSync.toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            })
        }
    }

    const handleSaveInventoryInterval = async () => {
        const nextSync = calculateNextInventorySync(inventoryInterval)

        try {
            const res = await fetch('/admin/quickbooks/config', {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    inventory_sync_interval_minutes: inventoryInterval === 'disabled' ? null : parseInt(inventoryInterval),
                })
            })

            if (!res.ok) {
                const errorData = await res.json()
                throw new Error(errorData.error || 'Failed to save')
            }

            if (inventoryInterval === 'disabled') {
                alert(`✅ Inventory sync disabled successfully`)
            } else {
                alert(`✅ Inventory interval saved: ${inventoryInterval} minutes\n\n⏰ Next sync at: ${nextSync}\n\nAutomatic syncs will run every ${inventoryInterval} minutes.`)
            }
        } catch (error) {
            alert(`❌ Failed to save: ${(error as Error).message}`)
        }
    }

    const handleSavePriceInterval = async () => {
        const nextSync = calculateNextPriceSync(priceInterval, priceTimeOfDay)

        // Convert hours to minutes for API
        const priceIntervalMinutes = priceInterval === 'disabled' ? null : (parseInt(priceInterval) * 60)

        try {
            const res = await fetch('/admin/quickbooks/config', {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    price_sync_interval_minutes: priceIntervalMinutes,
                })
            })

            if (!res.ok) {
                const errorData = await res.json()
                throw new Error(errorData.error || 'Failed to save')
            }

            const timeInfo = priceInterval === '24' ? ` at ${priceTimeOfDay}` : ''

            if (priceInterval === 'disabled') {
                alert(`✅ Price sync disabled successfully`)
            } else {
                const scheduleMsg = priceInterval === '24'
                    ? `Automatic syncs will run daily at ${priceTimeOfDay}.`
                    : `Automatic syncs will run every ${priceInterval} hours.`
                alert(`✅ Price interval saved: ${priceInterval} hours${timeInfo}\n\n⏰ Next sync: ${nextSync}\n\n${scheduleMsg}`)
            }
        } catch (error) {
            alert(`❌ Failed to save: ${(error as Error).message}`)
        }
    }

    const handleInventorySync = async () => {
        setInventorySyncing(true)
        try {
            const res = await fetch('/admin/quickbooks/sync/inventory', {
                method: 'POST',
                credentials: 'include',
            })

            if (!res.ok) throw new Error('Sync failed')

            alert(`✅ Inventory sync initiated successfully`)
        } catch (error) {
            alert(`❌ Sync failed: ${(error as Error).message}`)
        } finally {
            setInventorySyncing(false)
        }
    }

    const handlePriceSync = async () => {
        setPriceSyncing(true)
        try {
            const res = await fetch('/admin/quickbooks/sync/prices', {
                method: 'POST',
                credentials: 'include',
            })

            if (!res.ok) throw new Error('Sync failed')

            alert(`✅ Price sync initiated successfully`)
        } catch (error) {
            alert(`❌ Sync failed: ${(error as Error).message}`)
        } finally {
            setPriceSyncing(false)
        }
    }

    const handleSaveCustomerInterval = async () => {
        const nextSync = calculateNextPriceSync(customerInterval, customerTimeOfDay)
        const customerIntervalMinutes = customerInterval === 'disabled' ? null : (parseInt(customerInterval) * 60)

        try {
            const res = await fetch('/admin/quickbooks/config', {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    customer_sync_interval_minutes: customerIntervalMinutes,
                })
            })

            if (!res.ok) throw new Error('Failed to save configuration')

            const timeInfo = customerInterval === '24' ? ` at ${customerTimeOfDay}` : ''

            if (customerInterval === 'disabled') {
                alert(`✅ Customer sync disabled successfully`)
            } else {
                alert(`✅ Customer interval saved: ${customerInterval} hours${timeInfo}\n\n⏰ Next sync: ${nextSync}`)
            }
        } catch (error) {
            alert(`❌ Failed to save: ${(error as Error).message}`)
        }
    }

    const handleViewLastReport = async () => {
        try {
            const res = await fetch('/admin/quickbooks/check/customers', {
                method: 'GET',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                }
            })

            if (res.status === 404) {
                alert('❌ No audit results found. Run "Check Now" first.')
                return
            }

            if (!res.ok) throw new Error('Failed to fetch audit')

            const data = await res.json()
            setAuditData(data.audit)
            setShowAuditModal(true)
        } catch (error) {
            alert(`❌ Failed to load report: ${(error as Error).message}`)
        }
    }

    const handleCustomerSync = async () => {
        setCustomerSyncing(true)
        try {
            const res = await fetch('/admin/quickbooks/sync/customers', {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                }
            })

            if (!res.ok) throw new Error('Sync failed')

            const data = await res.json()
            alert(`✅ Customer sync completed!\n\nImported: ${data.stats.imported}\nAlready in Medusa: ${data.stats.alreadyInMedusa}`)
        } catch (error) {
            alert(`❌ Failed to sync: ${(error as Error).message}`)
        } finally {
            setCustomerSyncing(false)
        }
    }

    return (
        <div className="flex flex-col gap-3 p-6 max-w-7xl">
            <div>
                <Heading level="h1">QuickBooks Desktop Integration</Heading>
            </div>

            {/* Inventory Sync */}
            <Container>
                <div className="p-4 space-y-3">
                    <Heading level="h3" className="text-sm font-medium">📦 Inventory Sync</Heading>

                    <div className="space-y-2">
                        <div>
                            <Label htmlFor="inventory-interval" className="mb-1 block text-xs">
                                Interval
                            </Label>
                            <Select
                                value={inventoryInterval}
                                onValueChange={setInventoryInterval}
                            >
                                <Select.Trigger id="inventory-interval">
                                    <Select.Value />
                                </Select.Trigger>
                                <Select.Content>
                                    {inventoryIntervals.map((interval) => (
                                        <Select.Item key={interval.value} value={interval.value}>
                                            {interval.label}
                                        </Select.Item>
                                    ))}
                                </Select.Content>
                            </Select>
                        </div>

                        <div className="flex gap-2">
                            <Button
                                variant="secondary"
                                onClick={handleSaveInventoryInterval}
                                className="flex-1"
                            >
                                Save
                            </Button>
                            <Button
                                onClick={handleInventorySync}
                                isLoading={inventorySyncing}
                                disabled={inventorySyncing}
                                className="flex-1"
                            >
                                {inventorySyncing ? 'Syncing...' : 'Sync Now'}
                            </Button>
                        </div>
                    </div>
                </div>
            </Container>

            {/* Price Sync */}
            <Container>
                <div className="p-4 space-y-3">
                    <Heading level="h3" className="text-sm font-medium">💵 Price Sync</Heading>

                    <div className="space-y-2">
                        <div>
                            <Label htmlFor="price-interval" className="mb-1 block text-xs">
                                Interval
                            </Label>
                            <Select
                                value={priceInterval}
                                onValueChange={setPriceInterval}
                            >
                                <Select.Trigger id="price-interval">
                                    <Select.Value />
                                </Select.Trigger>
                                <Select.Content>
                                    {priceIntervals.map((interval) => (
                                        <Select.Item key={interval.value} value={interval.value}>
                                            {interval.label}
                                        </Select.Item>
                                    ))}
                                </Select.Content>
                            </Select>
                        </div>

                        {/* Show time picker only when 24 hours is selected */}
                        {priceInterval === '24' && (
                            <div>
                                <Label htmlFor="price-time" className="mb-1 block text-xs">
                                    Time
                                </Label>
                                <Select
                                    value={priceTimeOfDay}
                                    onValueChange={setPriceTimeOfDay}
                                >
                                    <Select.Trigger id="price-time">
                                        <Select.Value />
                                    </Select.Trigger>
                                    <Select.Content>
                                        {timeOfDayOptions.map((time) => (
                                            <Select.Item key={time.value} value={time.value}>
                                                {time.label}
                                            </Select.Item>
                                        ))}
                                    </Select.Content>
                                </Select>
                            </div>
                        )}

                        <div className="flex gap-2">
                            <Button
                                variant="secondary"
                                onClick={handleSavePriceInterval}
                                className="flex-1"
                            >
                                Save
                            </Button>
                            <Button
                                onClick={handlePriceSync}
                                isLoading={priceSyncing}
                                disabled={priceSyncing}
                                className="flex-1"
                            >
                                {priceSyncing ? 'Syncing...' : 'Sync Now'}
                            </Button>
                        </div>
                    </div>
                </div>
            </Container>

            {/* Customer Sync */}
            <Container>
                <div className="p-4 space-y-3">
                    <Heading level="h3" className="text-sm font-medium">👥 Customer Sync</Heading>

                    <div className="space-y-2">
                        <div>
                            <Label htmlFor="customer-interval" className="mb-1 block text-xs">
                                Interval
                            </Label>
                            <Select
                                value={customerInterval}
                                onValueChange={setCustomerInterval}
                            >
                                <Select.Trigger id="customer-interval">
                                    <Select.Value />
                                </Select.Trigger>
                                <Select.Content>
                                    {priceIntervals.map((interval) => (
                                        <Select.Item key={interval.value} value={interval.value}>
                                            {interval.label}
                                        </Select.Item>
                                    ))}
                                </Select.Content>
                            </Select>
                        </div>

                        {/* Show time picker only when 24 hours is selected */}
                        {customerInterval === '24' && (
                            <div>
                                <Label htmlFor="customer-time" className="mb-1 block text-xs">
                                    Time
                                </Label>
                                <Select
                                    value={customerTimeOfDay}
                                    onValueChange={setCustomerTimeOfDay}
                                >
                                    <Select.Trigger id="customer-time">
                                        <Select.Value />
                                    </Select.Trigger>
                                    <Select.Content>
                                        {timeOfDayOptions.map((time) => (
                                            <Select.Item key={time.value} value={time.value}>
                                                {time.label}
                                            </Select.Item>
                                        ))}
                                    </Select.Content>
                                </Select>
                            </div>
                        )}

                        <div className="flex gap-2">
                            <Button
                                variant="secondary"
                                onClick={handleSaveCustomerInterval}
                                className="flex-1"
                            >
                                Save
                            </Button>
                            <Button
                                variant="secondary"
                                onClick={handleViewLastReport}
                                className="flex-1"
                            >
                                View Last Report
                            </Button>
                            <Button
                                onClick={handleCustomerSync}
                                isLoading={customerSyncing}
                                disabled={customerSyncing}
                                className="flex-1"
                            >
                                {customerSyncing ? 'Syncing...' : 'Sync Now'}
                            </Button>
                        </div>
                    </div>
                </div>
            </Container>

            {/* Customer Audit Modal */}
            {showAuditModal && auditData && (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowAuditModal(false)}>
                    <div className="bg-white rounded-lg p-6 max-w-4xl max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                        <div className="flex justify-between items-center mb-4">
                            <Heading level="h2">Customer Audit Report</Heading>
                            <Button variant="secondary" onClick={() => setShowAuditModal(false)}>Close</Button>
                        </div>

                        <div className="space-y-6">
                            {/* Stats */}
                            <div className="grid grid-cols-3 gap-4">
                                <div className="p-4 bg-gray-50 rounded">
                                    <Text className="text-sm text-gray-600">Total in QB</Text>
                                    <Text className="text-2xl font-bold">{auditData.stats.totalInQb}</Text>
                                </div>
                                <div className="p-4 bg-gray-50 rounded">
                                    <Text className="text-sm text-gray-600">Total in Medusa</Text>
                                    <Text className="text-2xl font-bold">{auditData.stats.totalInMedusa}</Text>
                                </div>
                                <div className="p-4 bg-gray-50 rounded">
                                    <Text className="text-sm text-gray-600">In Both</Text>
                                    <Text className="text-2xl font-bold">{auditData.stats.inBoth}</Text>
                                </div>
                            </div>

                            {/* Only in QB */}
                            <div>
                                <Heading level="h3" className="mb-2">Only in QuickBooks ({auditData.stats.onlyInQb})</Heading>
                                {auditData.customersOnlyInQb.length > 0 ? (
                                    <div className="overflow-x-auto max-h-60 overflow-y-auto border rounded">
                                        <table className="min-w-full">
                                            <thead className="bg-gray-50">
                                                <tr>
                                                    <th className="p-2 text-left text-xs">Name</th>
                                                    <th className="p-2 text-left text-xs">Email</th>
                                                    <th className="p-2 text-left text-xs">Company</th>
                                                    <th className="p-2 text-left text-xs">Price Level</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {auditData.customersOnlyInQb.slice(0, 50).map((c: any, i: number) => (
                                                    <tr key={i} className="border-t">
                                                        <td className="p-2 text-sm">{c.Name}</td>
                                                        <td className="p-2 text-sm">{c.Email || '-'}</td>
                                                        <td className="p-2 text-sm">{c.CompanyName || '-'}</td>
                                                        <td className="p-2 text-sm">{c.PriceLevel}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                        {auditData.customersOnlyInQb.length > 50 && (
                                            <Text className="p-2 text-xs text-gray-500">Showing first 50 of {auditData.customersOnlyInQb.length}</Text>
                                        )}
                                    </div>
                                ) : (
                                    <Text className="text-gray-500">No customers found only in QuickBooks</Text>
                                )}
                            </div>

                            {/* Only in Medusa */}
                            <div>
                                <Heading level="h3" className="mb-2">Only in Medusa ({auditData.stats.onlyInMedusa})</Heading>
                                {auditData.customersOnlyInMedusa.length > 0 ? (
                                    <div className="overflow-x-auto max-h-60 overflow-y-auto border rounded">
                                        <table className="min-w-full">
                                            <thead className="bg-gray-50">
                                                <tr>
                                                    <th className="p-2 text-left text-xs">Email</th>
                                                    <th className="p-2 text-left text-xs">Name</th>
                                                    <th className="p-2 text-left text-xs">QB List ID</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {auditData.customersOnlyInMedusa.slice(0, 50).map((c: any, i: number) => (
                                                    <tr key={i} className="border-t">
                                                        <td className="p-2 text-sm">{c.email}</td>
                                                        <td className="p-2 text-sm">{c.first_name || ''} {c.last_name || ''}</td>
                                                        <td className="p-2 text-sm font-mono text-xs">{c.qb_list_id}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                        {auditData.customersOnlyInMedusa.length > 50 && (
                                            <Text className="p-2 text-xs text-gray-500">Showing first 50 of {auditData.customersOnlyInMedusa.length}</Text>
                                        )}
                                    </div>
                                ) : (
                                    <Text className="text-gray-500">No customers found only in Medusa</Text>
                                )}
                            </div>

                            <Text className="text-xs text-gray-500">
                                Last checked: {new Date(auditData.lastCheckAt).toLocaleString()}
                            </Text>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}

export const config = defineRouteConfig({
    label: "QuickBooks",
    icon: BuildingStorefront,
})

export default QuickBooksPage

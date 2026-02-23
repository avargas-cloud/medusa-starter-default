import { defineRouteConfig } from "@medusajs/admin-sdk"
import { BuildingStorefront } from "@medusajs/icons"
import { Container, Heading, Button, Text, Select, Label } from "@medusajs/ui"
import { useState, useEffect } from "react"
import { SyncReportModal } from "./components/SyncReportModal"

const QuickBooksPage = () => {
    const [inventorySyncing, setInventorySyncing] = useState(false)
    const [priceSyncing, setPriceSyncing] = useState(false)
    const [customerSyncing, setCustomerSyncing] = useState(false)
    const [reconciling, setReconciling] = useState(false)
    const [reconcilingDry, setReconcilingDry] = useState(false)
    const [inventoryInterval, setInventoryInterval] = useState("disabled")
    const [priceInterval, setPriceInterval] = useState("disabled")
    const [customerInterval, setCustomerInterval] = useState("disabled")
    const [priceTimeOfDay, setPriceTimeOfDay] = useState("00:00")
    const [customerTimeOfDay, setCustomerTimeOfDay] = useState("00:00")
    const [showAuditModal, setShowAuditModal] = useState(false)
    const [auditData] = useState<any>(null)
    const [qbEnabled, setQbEnabled] = useState<boolean | null>(null)  // null = loading
    const [qbToggling, setQbToggling] = useState(false)
    // Last sync timestamps
    const [lastInventorySync, setLastInventorySync] = useState<string | null>(null)
    const [lastPriceSync, setLastPriceSync] = useState<string | null>(null)
    const [lastCustomerSync, setLastCustomerSync] = useState<string | null>(null)
    // Sync report modal
    const [reportModal, setReportModal] = useState<{ jobId: string | null; title: string } | null>(null)
    const [lastJobIds, setLastJobIds] = useState<{ inventory?: string; prices?: string; customers?: string; reconcile?: string }>({})

    // Load saved config AND last job IDs on mount
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

                // Load master toggle
                setQbEnabled(config.integration_enabled ?? true)

                // Load last sync timestamps from DB
                if (config.last_inventory_sync) setLastInventorySync(config.last_inventory_sync)
                if (config.last_price_sync) setLastPriceSync(config.last_price_sync)
                if (config.last_customer_sync) setLastCustomerSync(config.last_customer_sync)

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

        // Load last job IDs so View Report works after page refresh
        const loadLastJobs = async () => {
            try {
                const [inv, prices, cust, recon] = await Promise.all([
                    fetch('/admin/quickbooks/sync/last-job?type=inventory', { credentials: 'include' }).then(r => r.json()),
                    fetch('/admin/quickbooks/sync/last-job?type=prices', { credentials: 'include' }).then(r => r.json()),
                    fetch('/admin/quickbooks/sync/last-job?type=customers', { credentials: 'include' }).then(r => r.json()),
                    fetch('/admin/quickbooks/sync/last-job?type=reconcile', { credentials: 'include' }).then(r => r.json()).catch(() => ({ job_id: null })),
                ])
                setLastJobIds({
                    inventory: inv.job_id ?? undefined,
                    prices: prices.job_id ?? undefined,
                    customers: cust.job_id ?? undefined,
                    reconcile: recon.job_id ?? undefined,
                })
            } catch {
                // Non-blocking if backend just restarted and has no jobs yet
            }
        }

        loadConfig()
        loadLastJobs()
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

    // Format a timestamp for display
    const formatSyncDate = (dateStr: string | null): string => {
        if (!dateStr) return ''
        try {
            return new Date(dateStr).toLocaleString('en-US', {
                month: 'short', day: 'numeric', year: 'numeric',
                hour: '2-digit', minute: '2-digit', hour12: true,
            })
        } catch { return dateStr }
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

    const handleQbToggle = async () => {
        const newValue = !qbEnabled
        setQbToggling(true)
        try {
            const res = await fetch('/admin/quickbooks/config', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ integration_enabled: newValue })
            })
            if (!res.ok) throw new Error('Failed to toggle')
            setQbEnabled(newValue)
            alert(newValue
                ? '✅ QuickBooks Integration ENABLED. All syncs will now run normally.'
                : '🔴 QuickBooks Integration DISABLED. All syncs are paused until re-enabled.')
        } catch (error) {
            alert(`❌ Failed to toggle: ${(error as Error).message}`)
        } finally {
            setQbToggling(false)
        }
    }

    const handleInventorySync = async () => {
        setInventorySyncing(true)
        try {
            const res = await fetch('/admin/quickbooks/sync/inventory', {
                method: 'POST',
                credentials: 'include',
            })

            if (!res.ok) throw new Error('Failed to start sync')
            const data = await res.json()
            const jobId = data.job_id
            setLastJobIds(prev => ({ ...prev, inventory: jobId }))
            setReportModal({ jobId, title: '📦 Inventory Sync Report' })
        } catch (error) {
            alert(`❌ Sync failed to start: ${(error as Error).message}`)
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

            if (!res.ok) throw new Error('Failed to start sync')
            const data = await res.json()
            const jobId = data.job_id
            setLastJobIds(prev => ({ ...prev, prices: jobId }))
            setReportModal({ jobId, title: '💵 Price Sync Report' })
        } catch (error) {
            alert(`❌ Sync failed to start: ${(error as Error).message}`)
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


    const handleReconcile = async (isDryRun: boolean = false) => {
        const setLoadState = isDryRun ? setReconcilingDry : setReconciling
        setLoadState(true)
        try {
            const res = await fetch('/admin/quickbooks/sync/customers/reconcile', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dry_run: isDryRun })
            })

            const data = await res.json()
            if (!data.success) throw new Error(data.message || 'Failed to start reconcilation')

            setReportModal({ jobId: data.job_id, title: `🔍 QB Reconcile ${isDryRun ? '(Dry Run)' : ''}` })
            // Re-fetch jobs so the latest shows up
            const recon = await fetch('/admin/quickbooks/sync/last-job?type=reconcile', { credentials: 'include' }).then(r => r.json()).catch(() => ({ job_id: null }))
            if (recon.job_id) {
                setLastJobIds(prev => ({ ...prev, reconcile: recon.job_id }))
            }
        } catch (error) {
            alert(`❌ Reconciliation failed: ${(error as Error).message}`)
        } finally {
            setLoadState(false)
        }
    }

    const handleCustomerSync = async () => {
        setCustomerSyncing(true)
        try {
            const res = await fetch('/admin/quickbooks/sync/customers', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' }
            })
            if (!res.ok) throw new Error('Failed to start sync')
            const data = await res.json()
            const jobId = data.job_id
            setLastJobIds(prev => ({ ...prev, customers: jobId }))
            setReportModal({ jobId, title: '👥 Customer Sync Report' })
        } catch (error) {
            alert(`❌ Failed to start: ${(error as Error).message}`)
        } finally {
            setCustomerSyncing(false)
        }
    }

    return (
        <div className="flex flex-col gap-3 p-6 max-w-7xl">
            <div>
                <Heading level="h1">QuickBooks Desktop Integration</Heading>
            </div>

            {/* ─── MASTER INTEGRATION TOGGLE ─── */}
            <Container>
                <div className="p-4">
                    <div className="flex items-center justify-between">
                        <div>
                            <Heading level="h3" className="text-sm font-medium">⚡ QuickBooks Integration</Heading>
                            <Text className="text-xs text-ui-fg-subtle mt-1">
                                Master kill switch. When disabled, all QB syncs and order flows are paused immediately.
                            </Text>
                        </div>
                        <div className="flex items-center gap-3">
                            <span className={`text-xs font-semibold px-2 py-1 rounded-full ${qbEnabled === null ? 'bg-gray-100 text-gray-500' :
                                qbEnabled ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                                }`}>
                                {qbEnabled === null ? 'Loading...' : qbEnabled ? '● ENABLED' : '● DISABLED'}
                            </span>
                            <Button
                                variant={qbEnabled ? 'danger' : 'primary'}
                                onClick={handleQbToggle}
                                isLoading={qbToggling}
                                disabled={qbToggling || qbEnabled === null}
                                size="small"
                            >
                                {qbEnabled ? 'Disable QB' : 'Enable QB'}
                            </Button>
                        </div>
                    </div>
                    {qbEnabled === false && (
                        <div className="mt-3 p-2 rounded bg-red-50 border border-red-200">
                            <Text className="text-xs text-red-600">
                                🔴 Integration is disabled. Syncs and order flows will not run. Re-enable to resume.
                            </Text>
                        </div>
                    )}
                </div>
            </Container>

            {/* ─── Inventory Sync ─── */}
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
                                variant="secondary"
                                onClick={() => setReportModal({ jobId: lastJobIds.inventory ?? null, title: '📦 Inventory Sync Report' })}
                                className="flex-1"
                            >
                                View Report
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

                        {/* Last sync timestamp */}
                        <div className="flex items-center gap-1.5 text-xs text-ui-fg-subtle pt-1 border-t border-ui-border-base">
                            {lastInventorySync ? (
                                <>
                                    <span className="text-green-600">✅</span>
                                    <span>Last sync: <span className="font-medium text-ui-fg-base">{formatSyncDate(lastInventorySync)}</span></span>
                                </>
                            ) : (
                                <span className="text-ui-fg-muted">No sync recorded yet</span>
                            )}
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
                                variant="secondary"
                                onClick={() => setReportModal({ jobId: lastJobIds.prices ?? null, title: '💵 Price Sync Report' })}
                                className="flex-1"
                            >
                                View Report
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

                        {/* Last sync timestamp */}
                        <div className="flex items-center gap-1.5 text-xs text-ui-fg-subtle pt-1 border-t border-ui-border-base">
                            {lastPriceSync ? (
                                <>
                                    <span className="text-green-600">✅</span>
                                    <span>Last sync: <span className="font-medium text-ui-fg-base">{formatSyncDate(lastPriceSync)}</span></span>
                                </>
                            ) : (
                                <span className="text-ui-fg-muted">No sync recorded yet</span>
                            )}
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
                                onClick={() => setReportModal({ jobId: lastJobIds.customers ?? null, title: '👥 Customer Sync Report' })}
                                className="flex-1"
                            >
                                View Report
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

                        {/* QB ID Reconciliation — separate from sync */}
                        <div className="flex gap-2 pt-3 mt-3 border-t border-ui-border-base">
                            <Button
                                variant="secondary"
                                onClick={() => handleReconcile(true)}
                                isLoading={reconcilingDry}
                                disabled={reconciling || reconcilingDry}
                                className="flex-1"
                            >
                                {reconcilingDry ? 'Loading...' : 'Dry Run Reconcile'}
                            </Button>
                            <Button
                                variant="secondary"
                                onClick={() => setReportModal({ jobId: lastJobIds.reconcile ?? null, title: '🔍 QB Reconcile Report' })}
                                className="flex-1"
                            >
                                View Report
                            </Button>
                            <Button
                                onClick={() => handleReconcile(false)}
                                isLoading={reconciling}
                                disabled={reconciling || reconcilingDry}
                                className="flex-1"
                            >
                                {reconciling ? 'Reconciling...' : 'Live Reconcile IDs'}
                            </Button>
                        </div>

                        {/* Last sync timestamp */}
                        <div className="flex items-center gap-1.5 text-xs text-ui-fg-subtle pt-1 border-t border-ui-border-base">
                            {lastCustomerSync ? (
                                <>
                                    <span className="text-green-600">✅</span>
                                    <span>Last sync: <span className="font-medium text-ui-fg-base">{formatSyncDate(lastCustomerSync)}</span></span>
                                </>
                            ) : (
                                <span className="text-ui-fg-muted">No sync recorded yet</span>
                            )}
                        </div>
                    </div>
                </div>
            </Container>

            {/* Sync Report Modal (all 3 sync types) */}
            {reportModal && (
                <SyncReportModal
                    jobId={reportModal.jobId}
                    title={reportModal.title}
                    onClose={() => setReportModal(null)}
                />
            )}
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

import { defineRouteConfig } from "@medusajs/admin-sdk"
import { BuildingStorefront } from "@medusajs/icons"
import { Container, Heading, Text, Button, Switch, toast } from "@medusajs/ui"
import { useState, useEffect } from "react"
import { SyncReportModal } from "./components/SyncReportModal"
import { StoreHoursSection } from "./components/StoreHoursSection"
import { SyncCard } from "./components/SyncCard"
import { AuditModal } from "./components/AuditModal"
import { ActivityLog } from "./components/ActivityLog"

// ─── Interval options ─────────────────────────────────────────────────────────
const INVENTORY_INTERVALS = [
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
const HOUR_INTERVALS = [
    { value: "disabled", label: "Disabled" },
    { value: "1", label: "1 hour" },
    { value: "2", label: "2 hours" },
    { value: "5", label: "5 hours" },
    { value: "10", label: "10 hours" },
    { value: "24", label: "Daily" },
]
const TIME_OF_DAY = Array.from({ length: 24 }, (_, i) => {
    const h = i.toString().padStart(2, '0')
    return { value: `${h}:00`, label: `${h}:00` }
})

const formatSyncDate = (dateStr: string | null): string => {
    if (!dateStr) return ''
    try {
        return new Date(dateStr).toLocaleString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric',
            hour: '2-digit', minute: '2-digit', hour12: true,
        })
    } catch { return dateStr }
}

// ─── Page ─────────────────────────────────────────────────────────────────────
const QuickBooksPage = () => {
    // Master toggle
    const [qbEnabled, setQbEnabled] = useState<boolean | null>(null)
    const [qbToggling, setQbToggling] = useState(false)

    // Store hours
    const [storeOpenHour, setStoreOpenHour] = useState("9")
    const [storeCloseHour, setStoreCloseHour] = useState("18")
    const [storeSatOpen, setStoreSatOpen] = useState(false)
    const [storeSatOpenHour, setStoreSatOpenHour] = useState("9")
    const [storeSatCloseHour, setStoreSatCloseHour] = useState("14")
    const [storeSunOpen, setStoreSunOpen] = useState(false)
    const [storeSunOpenHour, setStoreSunOpenHour] = useState("10")
    const [storeSunCloseHour, setStoreSunCloseHour] = useState("14")
    const [storeTimezone, setStoreTimezone] = useState("America/New_York")

    // Inventory sync
    const [inventoryInterval, setInventoryInterval] = useState("disabled")
    const [inventorySyncing, setInventorySyncing] = useState(false)
    const [inventoryRespectHours, setInventoryRespectHours] = useState(true)
    const [lastInventorySync, setLastInventorySync] = useState<string | null>(null)

    // Price sync
    const [priceInterval, setPriceInterval] = useState("disabled")
    const [priceTimeOfDay, setPriceTimeOfDay] = useState("00:00")
    const [priceSyncing, setPriceSyncing] = useState(false)
    const [priceRespectHours, setPriceRespectHours] = useState(false)
    const [lastPriceSync, setLastPriceSync] = useState<string | null>(null)

    // Customer sync
    const [customerInterval, setCustomerInterval] = useState("disabled")
    const [customerTimeOfDay, setCustomerTimeOfDay] = useState("00:00")
    const [customerSyncing, setCustomerSyncing] = useState(false)
    const [customerRespectHours, setCustomerRespectHours] = useState(false)
    const [lastCustomerSync, setLastCustomerSync] = useState<string | null>(null)
    const [reconciling, setReconciling] = useState(false)
    const [reconcilingDry, setReconcilingDry] = useState(false)

    // Modals
    const [reportModal, setReportModal] = useState<{ jobId: string | null; title: string } | null>(null)
    const [lastJobIds, setLastJobIds] = useState<{ inventory?: string; prices?: string; customers?: string; reconcile?: string }>({})
    const [showAuditModal, setShowAuditModal] = useState(false)
    const [auditData] = useState<any>(null)

    // ─── Load config on mount ───────────────────────────────────────────────
    const refreshTimestamps = async () => {
        try {
            const res = await fetch('/admin/quickbooks/config', { method: 'GET', credentials: 'include' })
            if (!res.ok) return
            const { config } = await res.json()
            if (config.last_inventory_sync) setLastInventorySync(config.last_inventory_sync)
            if (config.last_price_sync) setLastPriceSync(config.last_price_sync)
            if (config.last_customer_sync) setLastCustomerSync(config.last_customer_sync)
        } catch { /* non-blocking */ }
    }

    useEffect(() => {
        const load = async () => {
            try {
                const res = await fetch('/admin/quickbooks/config', { method: 'GET', credentials: 'include' })
                if (!res.ok) return
                const { config } = await res.json()

                setQbEnabled(config.integration_enabled ?? true)
                if (config.last_inventory_sync) setLastInventorySync(config.last_inventory_sync)
                if (config.last_price_sync) setLastPriceSync(config.last_price_sync)
                if (config.last_customer_sync) setLastCustomerSync(config.last_customer_sync)

                // Store hours
                if (config.store_hours_open_hour != null) setStoreOpenHour(String(config.store_hours_open_hour))
                if (config.store_hours_close_hour != null) setStoreCloseHour(String(config.store_hours_close_hour))
                if (config.store_sat_open != null) setStoreSatOpen(config.store_sat_open)
                if (config.store_sat_open_hour != null) setStoreSatOpenHour(String(config.store_sat_open_hour))
                if (config.store_sat_close_hour != null) setStoreSatCloseHour(String(config.store_sat_close_hour))
                if (config.store_sun_open != null) setStoreSunOpen(config.store_sun_open)
                if (config.store_sun_open_hour != null) setStoreSunOpenHour(String(config.store_sun_open_hour))
                if (config.store_sun_close_hour != null) setStoreSunCloseHour(String(config.store_sun_close_hour))
                if (config.store_hours_timezone) setStoreTimezone(config.store_hours_timezone)

                // Respect hours flags
                if (config.inventory_respect_hours != null) setInventoryRespectHours(config.inventory_respect_hours)
                if (config.price_respect_hours != null) setPriceRespectHours(config.price_respect_hours)
                if (config.customer_respect_hours != null) setCustomerRespectHours(config.customer_respect_hours)

                // Intervals
                setInventoryInterval(config.inventory_interval_minutes != null ? String(config.inventory_interval_minutes) : 'disabled')
                setPriceInterval(config.price_interval_minutes != null ? String(Math.floor(config.price_interval_minutes / 60)) : 'disabled')
                setCustomerInterval(config.customer_interval_minutes != null ? String(Math.floor(config.customer_interval_minutes / 60)) : 'disabled')

                // Price sync hour ("price_sync_hour" is 0-23 integer → "HH:00" string)
                if (config.price_sync_hour != null) {
                    const h = String(config.price_sync_hour).padStart(2, '0')
                    setPriceTimeOfDay(`${h}:00`)
                }
            } catch (e) { console.error('Failed to load config:', e) }
        }
        const loadJobs = async () => {
            try {
                const [inv, prices, cust, recon] = await Promise.all([
                    fetch('/admin/quickbooks/sync/last-job?type=inventory', { credentials: 'include' }).then(r => r.json()),
                    fetch('/admin/quickbooks/sync/last-job?type=prices', { credentials: 'include' }).then(r => r.json()),
                    fetch('/admin/quickbooks/sync/last-job?type=customers', { credentials: 'include' }).then(r => r.json()),
                    fetch('/admin/quickbooks/sync/last-job?type=reconcile', { credentials: 'include' }).then(r => r.json()).catch(() => ({ job_id: null })),
                ])
                setLastJobIds({ inventory: inv.job_id ?? undefined, prices: prices.job_id ?? undefined, customers: cust.job_id ?? undefined, reconcile: recon.job_id ?? undefined })
            } catch { /* non-blocking */ }
        }
        load()
        loadJobs()
    }, [])

    // ─── Handlers ──────────────────────────────────────────────────────────
    const postConfig = async (body: Record<string, unknown>) => {
        const res = await fetch('/admin/quickbooks/config', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        })
        if (!res.ok) throw new Error((await res.json()).error || 'Failed to save')
    }

    const handleQbToggle = async () => {
        const newValue = !qbEnabled
        setQbToggling(true)
        try {
            await postConfig({ integration_enabled: newValue })
            setQbEnabled(newValue)
            toast.success(newValue ? 'QuickBooks Integration ENABLED' : 'QuickBooks Integration DISABLED', {
                description: newValue ? 'All syncs will run normally.' : 'All syncs are paused until re-enabled.',
            })
        } catch (e) { toast.error('Failed to toggle', { description: (e as Error).message }) }
        finally { setQbToggling(false) }
    }

    const handleSaveStoreHours = async () => {
        try {
            await postConfig({
                store_hours_open_hour: parseInt(storeOpenHour),
                store_hours_close_hour: parseInt(storeCloseHour),
                store_sat_open: storeSatOpen,
                store_sat_open_hour: parseInt(storeSatOpenHour),
                store_sat_close_hour: parseInt(storeSatCloseHour),
                store_sun_open: storeSunOpen,
                store_sun_open_hour: parseInt(storeSunOpenHour),
                store_sun_close_hour: parseInt(storeSunCloseHour),
                store_hours_timezone: storeTimezone,
            })
            toast.success('Store hours saved', { description: 'Your store schedule has been updated.' })
        } catch (e) { toast.error('Failed to save store hours', { description: (e as Error).message }) }
    }

    const handleSaveInventory = async () => {
        try {
            await postConfig({
                inventory_sync_interval_minutes: inventoryInterval === 'disabled' ? null : parseInt(inventoryInterval),
                inventory_respect_hours: inventoryRespectHours,
            })
            toast.success('Inventory sync saved')
        } catch (e) { toast.error('Failed to save', { description: (e as Error).message }) }
    }

    const handleSavePrice = async () => {
        try {
            // priceTimeOfDay is "HH:00" → extract hour as integer
            const priceSyncHour = parseInt(priceTimeOfDay.split(':')[0] ?? '0', 10)
            await postConfig({
                price_sync_interval_minutes: priceInterval === 'disabled' ? null : parseInt(priceInterval) * 60,
                price_respect_hours: priceRespectHours,
                price_sync_hour: priceSyncHour,
            })
            toast.success('Price sync saved', { description: `Scheduled daily at ${priceTimeOfDay}.` })
        } catch (e) { toast.error('Failed to save', { description: (e as Error).message }) }
    }

    const handleSaveCustomer = async () => {
        try {
            await postConfig({ customer_sync_interval_minutes: customerInterval === 'disabled' ? null : parseInt(customerInterval) * 60, customer_respect_hours: customerRespectHours })
            toast.success('Customer sync saved')
        } catch (e) { toast.error('Failed to save', { description: (e as Error).message }) }
    }

    const handleInventorySync = async () => {
        setInventorySyncing(true)
        try {
            const res = await fetch('/admin/quickbooks/sync/inventory', { method: 'POST', credentials: 'include' })
            if (!res.ok) throw new Error('Failed to start sync')
            const { job_id } = await res.json()
            setLastJobIds(p => ({ ...p, inventory: job_id }))
            setReportModal({ jobId: job_id, title: '📦 Inventory Sync Report' })
            await refreshTimestamps()
        } catch (e) { toast.error('Price sync failed', { description: (e as Error).message }) }
        finally { setInventorySyncing(false) }
    }

    const handlePriceSync = async () => {
        setPriceSyncing(true)
        try {
            const res = await fetch('/admin/quickbooks/sync/prices', { method: 'POST', credentials: 'include' })
            if (!res.ok) throw new Error('Failed to start sync')
            const { job_id } = await res.json()
            setLastJobIds(p => ({ ...p, prices: job_id }))
            setReportModal({ jobId: job_id, title: '💵 Price Sync Report' })
            await refreshTimestamps()
        } catch (e) { toast.error('Price sync failed', { description: (e as Error).message }) }
        finally { setPriceSyncing(false) }
    }

    const handleCustomerSync = async () => {
        setCustomerSyncing(true)
        try {
            const res = await fetch('/admin/quickbooks/sync/customers', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' } })
            if (!res.ok) throw new Error('Failed to start sync')
            const { job_id } = await res.json()
            setLastJobIds(p => ({ ...p, customers: job_id }))
            setReportModal({ jobId: job_id, title: '👥 Customer Sync Report' })
            await refreshTimestamps()
        } catch (e) { toast.error('Customer sync failed', { description: (e as Error).message }) }
        finally { setCustomerSyncing(false) }
    }

    const handleReconcile = async (isDryRun: boolean = false) => {
        const setLoad = isDryRun ? setReconcilingDry : setReconciling
        setLoad(true)
        try {
            const res = await fetch('/admin/quickbooks/sync/customers/reconcile', {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dry_run: isDryRun }),
            })
            const data = await res.json()
            if (!data.success) throw new Error(data.message || 'Failed')
            setReportModal({ jobId: data.job_id, title: `🔍 QB Reconcile ${isDryRun ? '(Dry Run)' : ''}` })
            const recon = await fetch('/admin/quickbooks/sync/last-job?type=reconcile', { credentials: 'include' }).then(r => r.json()).catch(() => ({ job_id: null }))
            if (recon.job_id) setLastJobIds(p => ({ ...p, reconcile: recon.job_id }))
        } catch (e) { toast.error('Reconciliation failed', { description: (e as Error).message }) }
        finally { setLoad(false) }
    }

    // ─── Render ─────────────────────────────────────────────────────────────
    return (
        <div className="flex flex-col gap-3 p-6 max-w-5xl">
            <div>
                <Heading level="h1">QuickBooks Desktop Integration</Heading>
            </div>

            {/* Master toggle */}
            <Container>
                <div className="p-4">
                    <div className="flex items-center justify-between">
                        <div>
                            <Heading level="h3" className="text-sm font-medium">⚡ QuickBooks Integration</Heading>
                            <Text className="text-xs text-ui-fg-subtle mt-1">
                                Master kill switch — when disabled, all QB syncs and order flows are paused immediately.
                            </Text>
                        </div>
                        <div className="flex items-center gap-3">
                            <Text className={`text-xs font-semibold ${qbEnabled === null ? 'text-ui-fg-muted' : qbEnabled ? 'text-green-600' : 'text-red-500'}`}>
                                {qbEnabled === null ? 'Loading...' : qbEnabled ? 'Enabled' : 'Disabled'}
                            </Text>
                            <Switch
                                id="qb-master-toggle"
                                checked={qbEnabled === true}
                                onCheckedChange={() => { if (qbEnabled !== null && !qbToggling) handleQbToggle() }}
                                disabled={qbToggling || qbEnabled === null}
                            />
                        </div>
                    </div>
                    {qbEnabled === false && (
                        <div className="mt-3 p-2 rounded bg-red-50 border border-red-200">
                            <Text className="text-xs text-red-600">🔴 Integration is disabled. Re-enable to resume syncs and order flows.</Text>
                        </div>
                    )}
                </div>
            </Container>

            {/* Store Hours */}
            <StoreHoursSection
                storeOpenHour={storeOpenHour} setStoreOpenHour={setStoreOpenHour}
                storeCloseHour={storeCloseHour} setStoreCloseHour={setStoreCloseHour}
                storeSatOpen={storeSatOpen} setStoreSatOpen={setStoreSatOpen}
                storeSatOpenHour={storeSatOpenHour} setStoreSatOpenHour={setStoreSatOpenHour}
                storeSatCloseHour={storeSatCloseHour} setStoreSatCloseHour={setStoreSatCloseHour}
                storeSunOpen={storeSunOpen} setStoreSunOpen={setStoreSunOpen}
                storeSunOpenHour={storeSunOpenHour} setStoreSunOpenHour={setStoreSunOpenHour}
                storeSunCloseHour={storeSunCloseHour} setStoreSunCloseHour={setStoreSunCloseHour}
                storeTimezone={storeTimezone} setStoreTimezone={setStoreTimezone}
                onSave={handleSaveStoreHours}
            />

            {/* Inventory Sync */}
            <SyncCard
                title="📦 Inventory Sync"
                intervalValue={inventoryInterval}
                onIntervalChange={setInventoryInterval}
                intervals={INVENTORY_INTERVALS}
                respectHours={inventoryRespectHours}
                onRespectHoursChange={setInventoryRespectHours}
                onSave={handleSaveInventory}
                onViewReport={() => setReportModal({ jobId: lastJobIds.inventory ?? null, title: '📦 Inventory Sync Report' })}
                onSyncNow={handleInventorySync}
                isSyncing={inventorySyncing}
                lastSync={lastInventorySync}
                formatSyncDate={formatSyncDate}
            />

            {/* Price Sync */}
            <SyncCard
                title="💵 Price Sync"
                intervalValue={priceInterval}
                onIntervalChange={setPriceInterval}
                intervals={HOUR_INTERVALS}
                respectHours={priceRespectHours}
                onRespectHoursChange={setPriceRespectHours}
                onSave={handleSavePrice}
                onViewReport={() => setReportModal({ jobId: lastJobIds.prices ?? null, title: '💵 Price Sync Report' })}
                onSyncNow={handlePriceSync}
                isSyncing={priceSyncing}
                lastSync={lastPriceSync}
                formatSyncDate={formatSyncDate}
                showTimePicker={priceInterval === "24"}
                timeValue={priceTimeOfDay}
                onTimeChange={setPriceTimeOfDay}
                timeOptions={TIME_OF_DAY}
            />

            {/* Customer Sync */}
            <SyncCard
                title="👥 Customer Sync"
                intervalValue={customerInterval}
                onIntervalChange={setCustomerInterval}
                intervals={HOUR_INTERVALS}
                respectHours={customerRespectHours}
                onRespectHoursChange={setCustomerRespectHours}
                onSave={handleSaveCustomer}
                onViewReport={() => setReportModal({ jobId: lastJobIds.customers ?? null, title: '👥 Customer Sync Report' })}
                onSyncNow={handleCustomerSync}
                isSyncing={customerSyncing}
                lastSync={lastCustomerSync}
                formatSyncDate={formatSyncDate}
                showTimePicker={customerInterval === "24"}
                timeValue={customerTimeOfDay}
                onTimeChange={setCustomerTimeOfDay}
                timeOptions={TIME_OF_DAY}
                footer={
                    <div className="flex gap-2">
                        <Button variant="secondary" onClick={() => handleReconcile(true)} isLoading={reconcilingDry} disabled={reconciling || reconcilingDry} className="flex-1">
                            {reconcilingDry ? 'Loading...' : 'Dry Run Reconcile'}
                        </Button>
                        <Button variant="secondary" onClick={() => setReportModal({ jobId: lastJobIds.reconcile ?? null, title: '🔍 QB Reconcile Report' })} className="flex-1">View Report</Button>
                        <Button onClick={() => handleReconcile(false)} isLoading={reconciling} disabled={reconciling || reconcilingDry} className="flex-1">
                            {reconciling ? 'Reconciling...' : 'Live Reconcile IDs'}
                        </Button>
                    </div>
                }
            />

            {/* Activity Log */}
            <ActivityLog />

            {/* Modals */}
            {reportModal && (
                <SyncReportModal
                    jobId={reportModal.jobId}
                    title={reportModal.title}
                    onClose={() => setReportModal(null)}
                />
            )}
            {showAuditModal && auditData && (
                <AuditModal auditData={auditData} onClose={() => setShowAuditModal(false)} />
            )}
        </div>
    )
}

export const config = defineRouteConfig({
    label: "QuickBooks",
    icon: BuildingStorefront,
})

export default QuickBooksPage

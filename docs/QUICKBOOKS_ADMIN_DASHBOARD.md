# QuickBooks Admin Dashboard - Complete Documentation


## 📋 Descripción del Documento

| Campo | Detalle |
|-------|---------|
| **Propósito** | Document the QuickBooks Admin Dashboard feature — a custom Admin Panel page showing QuickBooks sync status, last import timestamps, customer import progress, and reconciliation tools for the QuickBooks-Medusa data bridge. |
| **Problemas que resuelve** | Without visibility into the QuickBooks sync state, admins can't tell if customer/product data has been imported or if the bridge is failing silently. The dashboard provides real-time sync status and manual trigger controls. |
| **Resultado esperado** | Admins can see at a glance when the last QuickBooks sync ran, how many records were imported, and trigger a manual re-sync if needed, all from the Medusa Admin Panel. |
| **Scripts Creados** | `import-customers-from-qb.ts`, `setup/setup-meilisearch-customers.ts` |

## Overview

The QuickBooks Admin Dashboard (`/admin/quickbooks`) is a custom Medusa v2 admin route that provides manual and automated synchronization controls for QuickBooks Desktop integration via the Bridge API.

**Key Features:**
- ✅ Inventory sync (stock levels from QuickBooks)
- ✅ Price sync (retail + wholesale pricing from QB) → **auto re-indexes Meilisearch**
- ✅ Customer sync (audit + import)
- ✅ Configurable intervals with "Disabled" option
- ✅ Manual "Sync Now" triggers
- ✅ Compact, professional UI
- ✅ Master QB Integration Enable/Disable toggle

---

## Architecture

### File Structure

```
src/
├── admin/routes/quickbooks/
│   └── page.tsx                              # Main dashboard UI
├── api/admin/quickbooks/
│   ├── config/route.ts                       # GET/POST config
│   ├── sync/
│   │   ├── inventory/route.ts                # POST inventory sync
│   │   ├── prices/route.ts                   # POST price sync
│   │   └── customers/route.ts                # POST customer sync
│   └── check/
│       └── customers/route.ts                # GET/POST customer audit
├── lib/quickbooks/
│   ├── sync-inventory-core.ts                # Inventory sync logic
│   ├── sync-prices-core.ts                   # Price sync logic
│   ├── sync-customers-core.ts                # Customer sync logic
│   └── check-customers-core.ts               # Customer audit logic
└── migrations/
    ├── 1738425780000-AllowNullQuickBooksIntervals.ts
    └── 1738427200000-AddCustomerIntervalToConfig.ts
```

---

## Database Schema

### Table: `quickbooks_config`

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `id` | VARCHAR | NO | Primary key (single row) |
| `inventory_interval_minutes` | INTEGER | YES | Inventory sync interval (null = disabled) |
| `price_interval_minutes` | INTEGER | YES | Price sync interval (null = disabled) |
| `customer_interval_minutes` | INTEGER | YES | Customer sync interval (null = disabled) |
| `last_inventory_sync` | TIMESTAMP | YES | Last inventory sync timestamp |
| `last_price_sync` | TIMESTAMP | YES | Last price sync timestamp |
| `bridge_url` | VARCHAR | NO | Bridge API URL |
| `api_key` | VARCHAR | YES | Bridge API key |
| `created_at` | TIMESTAMP | NO | Creation timestamp |
| `updated_at` | TIMESTAMP | NO | Last update timestamp |

**Design Pattern:**
- NULL = Disabled (standard SQL pattern for optional features)
- INTEGER columns store minutes (inventory) or minutes (price/customer converted from hours)
- Single row configuration (id is constant)

### Table: `quickbooks_customer_audit`

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | Primary key |
| `total_in_qb` | INTEGER | Total customers in QuickBooks |
| `total_in_medusa` | INTEGER | Total customers in Medusa |
| `only_in_qb` | INTEGER | Customers only in QB |
| `only_in_medusa` | INTEGER | Customers only in Medusa |
| `in_both` | INTEGER | Customers in both systems |
| `customers_only_in_qb` | JSONB | Array of QB-only customer objects |
| `customers_only_in_medusa` | JSONB | Array of Medusa-only customer objects |
| `last_check_at` | TIMESTAMP | Audit timestamp |

---

## Frontend State Management

### React State Variables

```typescript
// Sync status flags
const [inventorySyncing, setInventorySyncing] = useState(false)
const [priceSyncing, setPriceSyncing] = useState(false)
const [customerSyncing, setCustomerSyncing] = useState(false)

// Interval selections (string: "disabled" | "5" | "10" | "1" | "6" | "12" | "24")
const [inventoryInterval, setInventoryInterval] = useState("disabled")
const [priceInterval, setPriceInterval] = useState("disabled")
const [customerInterval, setCustomerInterval] = useState("disabled")

// Time of day for 24-hour intervals (HH:MM format)
const [priceTimeOfDay, setPriceTimeOfDay] = useState("00:00")
const [customerTimeOfDay, setCustomerTimeOfDay] = useState("00:00")

// Customer audit modal
const [showAuditModal, setShowAuditModal] = useState(false)
const [auditData, setAuditData] = useState<any>(null)
```

### State Initialization (useEffect)

```typescript
useEffect(() => {
    const loadConfig = async () => {
        const res = await fetch('/admin/quickbooks/config', {
            method: 'GET',
            credentials: 'include',
        })
        const data = await res.json()
        const config = data.config
        
        // Convert DB values (null or minutes) → UI values ("disabled" or interval)
        if (config.inventory_interval_minutes !== null) {
            setInventoryInterval(config.inventory_interval_minutes.toString())
        } else {
            setInventoryInterval('disabled')
        }
        
        if (config.price_interval_minutes !== null) {
            const hours = Math.floor(config.price_interval_minutes / 60)
            setPriceInterval(hours.toString())
        } else {
            setPriceInterval('disabled')
        }
        
        if (config.customer_interval_minutes !== null) {
            const hours = Math.floor(config.customer_interval_minutes / 60)
            setCustomerInterval(hours.toString())
        } else {
            setCustomerInterval('disabled')
        }
    }
    loadConfig()
}, [])
```

**Design Pattern:**
- NULL in DB → "disabled" in UI
- Inventory: minutes → minutes (1:1)
- Price/Customer: minutes → hours (÷60)

---

## API Integration

### Configuration Endpoints

#### GET `/admin/quickbooks/config`

**Purpose:** Load saved configuration

**Response:**
```json
{
  "config": {
    "inventory_interval_minutes": 5,
    "price_interval_minutes": 60,
    "customer_interval_minutes": null,
    "last_inventory_sync": "2026-02-01T12:00:00Z",
    "last_price_sync": "2026-02-01T12:00:00Z"
  }
}
```

#### POST `/admin/quickbooks/config`

**Purpose:** Save interval configuration

**Request Body:**
```json
{
  "inventory_sync_interval_minutes": 10,
  "price_sync_interval_minutes": 120,
  "customer_sync_interval_minutes": null
}
```

**Validation:**
- Only validates non-null values
- Range: 1-10080 minutes (7 days)
- NULL is valid (disabled state)

**Database Update:**
```sql
UPDATE quickbooks_config 
SET 
    inventory_interval_minutes = $1,
    price_interval_minutes = $2,
    customer_interval_minutes = $3,
    updated_at = NOW()
WHERE id = 'default'
```

### Sync Endpoints

#### POST `/admin/quickbooks/sync/inventory`

Triggers immediate inventory sync using `syncInventoryCore()`.

#### POST `/admin/quickbooks/sync/prices`

Triggers immediate price sync using `syncPricesCore()`.

#### POST `/admin/quickbooks/sync/customers`

Triggers immediate customer import using `syncCustomersCore()`.

### Customer Audit Endpoints

#### POST `/admin/quickbooks/check/customers`

Triggers customer comparison audit using `checkCustomersCore()`.

#### GET `/admin/quickbooks/check/customers`

Retrieves latest audit results from `quickbooks_customer_audit` table.

**Response:**
```json
{
  "audit": {
    "total_in_qb": 150,
    "total_in_medusa": 145,
    "only_in_qb": 5,
    "only_in_medusa": 0,
    "in_both": 145,
    "customers_only_in_qb": [...],
    "customers_only_in_medusa": [],
    "last_check_at": "2026-02-01T12:30:00Z"
  }
}
```

---

## UI Components & Handlers

### Inventory Sync Section

**Intervals:**
```typescript
const inventoryIntervals = [
    { value: "disabled", label: "Disabled" },
    { value: "5", label: "5 minutes" },
    { value: "10", label: "10 minutes" },
    { value: "15", label: "15 minutes" },
    { value: "30", label: "30 minutes" },
    { value: "60", label: "1 hour" },
]
```

**Save Handler:**
```typescript
const handleSaveInventoryInterval = async () => {
    const nextSync = calculateNextInventorySync(inventoryInterval)
    
    const res = await fetch('/admin/quickbooks/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            inventory_sync_interval_minutes: 
                inventoryInterval === 'disabled' ? null : parseInt(inventoryInterval)
        })
    })
    
    alert(`✅ Inventory interval saved: ${inventoryInterval} minutes\n\n⏰ Next sync at: ${nextSync}`)
}
```

**Sync Now Handler:**
```typescript
const handleInventorySync = async () => {
    setInventorySyncing(true)
    const res = await fetch('/admin/quickbooks/sync/inventory', {
        method: 'POST',
        credentials: 'include'
    })
    setInventorySyncing(false)
    alert(res.ok ? '✅ Inventory sync completed!' : '❌ Sync failed')
}
```

### Price Sync Section

**Intervals (hours):**
```typescript
const priceIntervals = [
    { value: "disabled", label: "Disabled" },
    { value: "1", label: "1 hour" },
    { value: "6", label: "6 hours" },
    { value: "12", label: "12 hours" },
    { value: "24", label: "24 hours" },
]
```

**Time Picker (conditional):**
- Only shown when `priceInterval === '24'`
- Generates 24 hourly options (00:00 - 23:00)
- Stored in `priceTimeOfDay` state

**Save Handler:**
```typescript
const handleSavePriceInterval = async () => {
    const nextSync = calculateNextPriceSync(priceInterval, priceTimeOfDay)
    const priceIntervalMinutes = priceInterval === 'disabled' ? null : (parseInt(priceInterval) * 60)
    
    const res = await fetch('/admin/quickbooks/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            price_sync_interval_minutes: priceIntervalMinutes
        })
    })
    
    const timeInfo = priceInterval === '24' ? ` at ${priceTimeOfDay}` : ''
    alert(`✅ Price interval saved: ${priceInterval} hours${timeInfo}\n\n⏰ Next sync: ${nextSync}`)
}
```

### Customer Sync Section

**Save Handler:**
```typescript
const handleSaveCustomerInterval = async () => {
    const nextSync = calculateNextPriceSync(customerInterval, customerTimeOfDay)
    const customerIntervalMinutes = customerInterval === 'disabled' ? null : (parseInt(customerInterval) * 60)
    
    const res = await fetch('/admin/quickbooks/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            customer_sync_interval_minutes: customerIntervalMinutes
        })
    })
    
    alert(`✅ Customer interval saved: ${customerInterval} hours\n\n⏰ Next sync: ${nextSync}`)
}
```

**View Last Report Handler:**
```typescript
const handleViewCustomerReport = async () => {
    const res = await fetch('/admin/quickbooks/check/customers', {
        method: 'GET',
        credentials: 'include'
    })
    const data = await res.json()
    setAuditData(data.audit)
    setShowAuditModal(true)
}
```

**Sync Now Handler:**
```typescript
const handleCustomerSync = async () => {
    setCustomerSyncing(true)
    const res = await fetch('/admin/quickbooks/sync/customers', {
        method: 'POST',
        credentials: 'include'
    })
    setCustomerSyncing(false)
    alert(res.ok ? '✅ Customer sync completed!' : '❌ Sync failed')
}
```

### Customer Audit Modal

**UI Components:**
- Summary stats (Total in QB, Total in Medusa, In Both)
- Only in QuickBooks list (with ListNumber, DisplayName, Email)
- Only in Medusa list (with email, first_name, last_name)
- Last check timestamp

**Structure:**
```tsx
<Prompt open={showAuditModal} onOpenChange={setShowAuditModal}>
    <Prompt.Content>
        <Prompt.Header>
            <Prompt.Title>Customer Audit Report</Prompt.Title>
        </Prompt.Header>
        
        {/* Summary Stats */}
        <div className="grid grid-cols-3 gap-4 p-4 bg-ui-bg-subtle rounded">
            <StatBox label="Total in QB" value={auditData.total_in_qb} />
            <StatBox label="Total in Medusa" value={auditData.total_in_medusa} />
            <StatBox label="In Both" value={auditData.in_both} />
        </div>
        
        {/* Only in QuickBooks */}
        {auditData.only_in_qb > 0 && (
            <CustomerList 
                title="Only in QuickBooks" 
                customers={auditData.customers_only_in_qb}
                type="qb"
            />
        )}
        
        {/* Only in Medusa */}
        {auditData.only_in_medusa > 0 && (
            <CustomerList 
                title="Only in Medusa" 
                customers={auditData.customers_only_in_medusa}
                type="medusa"
            />
        )}
        
        <Prompt.Footer>
            <Button onClick={() => setShowAuditModal(false)}>Close</Button>
        </Prompt.Footer>
    </Prompt.Content>
</Prompt>
```

---

## Helper Functions

### Time Calculation

```typescript
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
        // Specific time of day
        const [targetHour, targetMinute] = timeOfDay.split(':').map(Number)
        const nextSync = new Date()
        nextSync.setHours(targetHour, targetMinute, 0, 0)

        // If time passed today, schedule for tomorrow
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
        // Relative interval
        const hours = parseInt(intervalHours)
        const nextSync = new Date(now.getTime() + hours * 3600000)

        return nextSync.toLocaleTimeString('en-US', { 
            hour: '2-digit', 
            minute: '2-digit',
            hour12: false 
        })
    }
}
```

---

## Styling & Layout

### Design Tokens

**Container:**
- `gap-3`: Vertical spacing between sections (was `gap-6`, reduced for compactness)
- `p-6`: Page padding
- `max-w-7xl`: Maximum width constraint

**Section Cards:**
- `p-4`: Internal padding (was `p-6`, reduced)
- `space-y-3`: Vertical spacing within sections (was `space-y-4`, reduced)
- `space-y-2`: Field spacing (was `space-y-3`, reduced)

**Headers:**
- `h3` with `text-sm font-medium`: Section titles (was `h2`, reduced)
- Emoji prefixes: 📦 (Inventory), 💵 (Price), 👥 (Customer)

**Labels:**
- `text-xs`: Smaller label text (was default size)
- `mb-1`: Minimal margin bottom (was `mb-2`)

### Responsive Layout

**Buttons:**
```tsx
<div className="grid grid-cols-2 gap-3">
    <Button variant="secondary" onClick={handleSave}>Save</Button>
    <Button variant="primary" onClick={handleSyncNow}>Sync Now</Button>
</div>
```

**Customer Sync (3 buttons):**
```tsx
<div className="grid grid-cols-3 gap-3">
    <Button variant="secondary" onClick={handleSave}>Save</Button>
    <Button variant="secondary" onClick={handleViewReport}>View Last Report</Button>
    <Button variant="primary" onClick={handleSyncNow}>Sync Now</Button>
</div>
```

---

## Data Flow Diagrams

### Save Interval Flow

```
User selects interval → handleSave() → Convert to API format → POST /config → DB UPDATE → Alert user
                ↓
          "disabled" → null
          "5" minutes → 5
          "1" hour → 60 minutes
```

### Load Config Flow

```
Page mount → useEffect → GET /config → DB SELECT → Parse response → setState()
                                            ↓
                                      null → "disabled"
                                      5 → "5"
                                      60 → "1" hour
```

### Sync Now Flow

```
User clicks → handleSync() → setSyncing(true) → POST /sync/[type] → Core function → Bridge API
                                                        ↓
                                                 setSyncing(false)
                                                        ↓
                                                   Alert result
```

**Price Sync Extended Flow:**
```
POST /sync/prices
  → syncPricesCore()
      → Fetch items from QB Bridge
      → Update retail prices in Medusa DB
      → Auto-calculate wholesale at 10% off
      → if (!dryRun && updatedPrice > 0)
            → syncInventoryWorkflow().run() → Re-index Meilisearch ✔
      → Return stats
```

### Customer Audit Flow

```
POST /check/customers → checkCustomersCore() → Fetch QB customers
                                                Fetch Medusa customers
                                                Compare by email
                                                Save to audit table
                                                ↓
GET /check/customers → Query audit table → Return latest audit → Display in modal
```

---

## Error Handling

### API Errors

```typescript
try {
    const res = await fetch('/admin/quickbooks/config', { ... })
    if (!res.ok) throw new Error('Failed to save configuration')
    alert('✅ Success')
} catch (error) {
    alert(`❌ Failed to save: ${(error as Error).message}`)
}
```

### Validation Errors (Backend)

```typescript
// Range validation
if (interval !== null && (interval < 1 || interval > 10080)) {
    res.status(400).json({
        error: "interval must be between 1 and 10080 (7 days)"
    })
    return
}

// Empty update check
if (updates.length === 0) {
    res.status(400).json({
        error: "No fields to update"
    })
    return
}
```

---

## Common Issues & Solutions

### Issue: Intervals show empty after refresh

**Cause:** useEffect not handling null values correctly

**Solution:**
```typescript
// WRONG
if (config.interval !== null) {
    setInterval(config.interval.toString())
}
// Leaves state empty if null

// CORRECT
if (config.interval !== null) {
    setInterval(config.interval.toString())
} else {
    setInterval('disabled')
}
// Always sets a value
```

### Issue: 400 error when saving "disabled"

**Cause:** Backend not accepting null values

**Solution:**
```typescript
// WRONG
if (interval !== undefined && interval !== null) {
    updates.push(`interval = $${paramIndex}`)
}
// Doesn't push if null

// CORRECT
if (interval !== undefined && interval !== null) {
    // Validation only for non-null
    if (interval < 1 || interval > 10080) throw error
}
if (interval !== undefined) {
    // Push even if null
    updates.push(`interval = $${paramIndex}`)
    values.push(interval)
}
```

### Issue: Server changes not reflected

**Cause:** Server needs restart to load new code

**Solution:**
- Stop: `Ctrl+C` in terminal running `bash dev.sh`
- Start: `bash dev.sh`
- Hard refresh admin: `Ctrl+Shift+R`

---

## Testing Checklist

- [ ] Save each interval type ("disabled", 5 min, 1 hour, etc.)
- [ ] Hard refresh and verify values persist
- [ ] Test "Sync Now" for all three types
- [ ] Verify time calculation for 24-hour intervals
- [ ] Test customer audit modal display
- [ ] Check responsive layout on different screen sizes
- [ ] Verify API error handling (disconnect Bridge, etc.)
- [ ] Test NULL handling in database queries

---

## Future Enhancements

### Planned Features
- 🔄 Background job scheduling (replace manual sync)
- 📊 Sync history dashboard
- 🔔 Error notifications (replace alerts with toast)
- 📈 Sync metrics and analytics
- 🔐 Audit log for configuration changes

### Known Limitations
- Synchronous API calls (blocks UI during sync)
- No real-time progress feedback
- Alert-based notifications (not ideal UX)
- No retry mechanism for failed syncs
- Meilisearch re-index only fires on price sync (not on inventory sync)

---

## Meilisearch Auto Re-index After Price Sync

**Archivo:** `src/lib/quickbooks/sync-prices-core.ts` (línea 346-358)

### Comportamiento

Despues de un **Price Sync exitoso**, el sistema automáticamente re-indexa el índice Meilisearch `inventory` para que el `inventory-advanced` UI refleje los nuevos precios **de inmediato** sin esperar al reconciliation job de 5 minutos.

```typescript
// src/lib/quickbooks/sync-prices-core.ts
// After prices are written to DB:
if (!dryRun && stats.updatedPrice > 0) {
    logger.info(`⭐ Re-indexing Meilisearch inventory with updated prices...`)
    try {
        const meiliResult = await syncInventoryWorkflow(container).run({ input: {} })
        logger.info(`✅ Meilisearch re-indexed ${meiliResult.result.synced} inventory items`)
    } catch (meiliErr: any) {
        // Non-blocking — price sync succeeds even if Meilisearch fails
        logger.warn(`⚠️ Meilisearch re-index failed (non-blocking): ${meiliErr.message}`)
    }
}
```

### Condiciones de disparo

| Condición | Resultado |
|-----------|----------|
| `dryRun=false` AND `updatedPrice > 0` | ✅ Re-index disparado |
| `dryRun=true` | ❌ Skipped (no hubo cambios en DB) |
| `updatedPrice === 0` | ❌ Skipped (sin cambios, re-index es innecesario) |
| Meilisearch falla | ⚠️ Warning log, price sync retorna `success: true` igual |

### Relación con inventory-advanced

| Cola de sync | Qué lo dispara | Cuándo llega |
|-------------|----------------|-------------|
| Middleware (Layer 1) | Cambios de stock en UI | ~500ms |
| QB Price Sync | Price sync QB → Medusa | Al final del sync |
| Reconciliation Job (Layer 2) | Cron cada 5 min | ≤5 min |
| Manual Sync (Layer 3) | Botón en inventory-advanced | On-demand |

> **⚠️ Nota:** El Meilisearch re-index tras price sync incluye los nuevos `pricesByList` para que las **Dynamic Pricing Columns** en `inventory-advanced` reflejen los precios actualizados inmediatamente.

---

## Environment Variables

```bash
DATABASE_URL=postgresql://...
BRIDGE_URL=http://localhost:7000
API_KEY=your-bridge-api-key
```

---

## Related Documentation

- [QuickBooks Bridge Architecture](./quickbooks/bridge_architecture.md)
- [Customer Migration Guide](./quickbooks/customer_migration.md)
- [Bulk Sync Strategy](./quickbooks/bulk_sync_strategy.md)
- [Medusa Admin UI Customization](../admin_ui_customization.md)

---

**Last Updated:** 2026-02-22  
**Version:** 1.1 — Added Meilisearch Auto Re-index section  
**Status:** ✅ Production Ready

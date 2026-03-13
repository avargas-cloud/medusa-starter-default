# POS Document Template System — Complete Reference

> **Last updated:** March 2026  
> **Applies to:** `ecopowertech-store-pos` Next.js app (all pages under `app/(pos)/templates/`)

---

## Overview

The Template System is the engine that drives PDF/print generation for Estimates, Sales Orders, and Invoices in the EcoPowerTech POS. It is a **3-step wizard**:

```
Step 1 — Fields   →   Step 2 — Layout Designer   →   Step 3 — Preview
/templates/[id]/edit   /templates/[id]/design       /templates/[id]/preview
```

Templates are **type-scoped** (`estimate | order | invoice`), support **duplicate/set-default**, and are stored in the backend database via a dedicated `document-templates` endpoint on the Medusa admin API.

---

## File Map

| File | Purpose |
|------|---------|
| `app/(pos)/templates/page.tsx` | Gallery — lists all templates grouped by type |
| `app/(pos)/templates/[id]/edit/page.tsx` | **Step 1** — Fields & toggles configurator |
| `app/(pos)/templates/[id]/design/page.tsx` | **Step 2** — Visual layout drag-and-drop editor |
| `app/(pos)/templates/[id]/preview/page.tsx` | **Step 3** — Print preview with real store data |
| `hooks/useDocumentTemplates.ts` | CRUD hook for the backend API |
| `components/pos/TemplatePicker.tsx` | Picker widget used in Estimates/Orders to apply a template |

---

## Backend API Endpoints

All calls go through `medusaFetch()` to `/admin/document-templates`.

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/admin/document-templates` | List all templates (optional `?doc_type=estimate`) |
| `GET` | `/admin/document-templates/:id` | Get single template |
| `POST` | `/admin/document-templates` | Create new template |
| `PATCH` | `/admin/document-templates/:id` | Update template (name, field_config, layout_data, is_default) |
| `DELETE` | `/admin/document-templates/:id` | Delete template |
| `POST` | `/admin/document-templates/:id/duplicate` | Duplicate template |
| `POST` | `/admin/document-templates/:id/set-default` | Set as default for its doc_type |

### `DocumentTemplate` Interface

```typescript
// hooks/useDocumentTemplates.ts
export interface DocumentTemplate {
    id:           string
    name:         string
    doc_type:     'estimate' | 'order' | 'invoice'
    is_default:   boolean
    thumbnail:    string | null
    field_config: Record<string, any>   // ← Step 1 output
    layout_data:  any[]                 // ← Step 2 output (LayoutBlock[])
    created_by:   string | null
    created_at:   string
    updated_at:   string
}
```

### `useDocumentTemplates` Hook

```typescript
// Usage
const {
    templates,           // DocumentTemplate[]
    loading, error,
    reload,
    createTemplate,      // (body) => Promise<DocumentTemplate>
    updateTemplate,      // (id, Partial<DocumentTemplate>) => Promise<DocumentTemplate>
    deleteTemplate,      // (id) => Promise<void>
    duplicateTemplate,   // (id) => Promise<DocumentTemplate>
    setDefault,          // (id) => Promise<void>
} = useDocumentTemplates(doc_type?)  // optional filter
```

---

## Data Model

### `FieldConfig` (saved in `template.field_config`)

Produced by **Step 1 — Fields**. Controls which sections appear on print.

```typescript
interface FieldConfig {
    // Store info
    show_logo:    ToggleValue   // { screen: boolean, print: boolean }
    show_name:    ToggleValue
    show_address: ToggleValue

    // Customer fields
    customer_fields: {
        company_name: ToggleValue
        first_name:   ToggleValue
        last_name:    ToggleValue
        phone:        ToggleValue
        email:        ToggleValue
    }
    customer_field_order: string[]  // drag-sorted order saved here

    // Order doc info
    show_customer_shipping: ToggleValue
    show_customer_billing:  ToggleValue
    show_date:              ToggleValue
    show_order_number:      ToggleValue
    show_shipping:          ToggleValue
    show_promotions:        ToggleValue
    show_notes:             ToggleValue
    show_policy:            ToggleValue & { text: string }

    // Dynamic metadata (from /admin/system-defaults)
    metadata_fields: MetadataField[]

    // Item table column configuration
    columns: ColumnConfig[]           // visibility, width %, custom label
    summary_rows: SummaryRowConfig[]  // visibility, drag-sorted, custom label

    // Custom labels for any field
    custom_labels: Record<string, string>
}
```

### `LayoutBlock` (elements of `template.layout_data`)

Produced by **Step 2 — Layout**. Each block is a positioned rectangle on the page.

```typescript
// design/page.tsx
export interface LayoutBlock {
    id:       string             // unique, stable ('store_logo_img', 'table', etc.)
    groupId?: string             // if set, block belongs to an explicit drag group
    type:     BlockType          // see block types below
    label:    string             // display name
    fieldKey: string | null      // links back to FieldConfig (e.g. 'store_name')
    subType:  'title' | 'data' | null
    x:        number             // mm from left edge of print area
    y:        number             // mm from top edge of print area
    width:    number             // mm
    height:   number             // mm
    locked:   boolean            // prevents deletion (structural blocks)
    hidden:   boolean            // hides from canvas and print
    style:    BlockStyle
    props:    Record<string, any>
    customerFieldOrder?: string[]  // only set on customer_detail blocks
}

export type BlockType =
    | 'structural'       // table + summary — cannot be deleted
    | 'field_title'      // label header for a field (e.g. "DATE:")
    | 'field_data'       // value area for a field (e.g. "March 12, 2026")
    | 'customer_detail'  // special multi-line customer info block
    | 'text'             // free-form text block
    | 'divider'          // horizontal line
    | 'spacer'           // blank space
    | 'image'            // image block (used for store logo)
```

### `BlockStyle`

All style properties stored per-block in `block.style`:

```typescript
export interface BlockStyle {
    fontSize:       number    // pt, default 9
    fontColor:      string    // hex, default '#111111'
    fontFamily:     string    // 'sans' | 'serif' | 'mono'
    fontWeight:     'normal' | 'bold'
    fontStyle:      'normal' | 'italic'
    textDecoration: 'none' | 'underline'
    bgColor:        string    // hex or 'transparent'
    borderTop:      number    // px
    borderRight:    number
    borderBottom:   number
    borderLeft:     number
    borderColor:    string    // hex
    borderRadius:   number    // px, default 0
    textAlign:      'left' | 'center' | 'right'
    verticalAlign:  'top' | 'middle' | 'bottom'
}

const DEFAULT_STYLE: BlockStyle = {
    fontSize: 9, fontColor: '#111111', fontFamily: 'sans',
    fontWeight: 'normal', fontStyle: 'normal', textDecoration: 'none',
    bgColor: 'transparent',
    borderTop: 0, borderRight: 0, borderBottom: 0, borderLeft: 0,
    borderColor: '#cccccc', borderRadius: 0,
    textAlign: 'left', verticalAlign: 'top',
}
```

### Page Dimensions

```typescript
const MM_TO_PX  = 3.7795
const PAGE_W_MM = 215.9   // US Letter width  (8.5in)
const PAGE_H_MM = 279.4   // US Letter height (11in)

function mmToPx(mm: number) { return mm * MM_TO_PX }
function pxToMm(px: number) { return Math.round(px / MM_TO_PX * 10) / 10 }
```

---

## Step 1 — Fields Configurator (`edit/page.tsx`)

### What It Does

- User selects which fields appear on screen vs. print
- Configures item table column visibility and widths (must total ≤ 100%)
- Configures order summary row visibility and order
- Drag-sorts customer fields and summary rows
- Supports custom labels for any field (renamed inline)
- Fetches available metadata fields from `/admin/system-defaults`

### Column Width Validation

```typescript
// Must be exactly 100% — Description column gets remaining width auto-assigned
const colWidthSum  = visibleCols.reduce((s, c) => s + c.width, 0)
const colWidthOver = colWidthSum > 100

// On save: if under 100%, extra goes to 'description' column
if (colWidthSum < 100) {
    const diff = 100 - colWidthSum
    finalConfig = {
        ...config,
        columns: config.columns.map(c =>
            c.key === 'description' && c.visible ? { ...c, width: c.width + diff } : c
        ),
    }
}
```

### Navigation

| Button | Destination |
|--------|-------------|
| `← Cancel` | `router.push('/templates')` — never uses browser back |
| `Save` | PATCH field_config, stay on page |
| `Save & Continue to Layout` | PATCH field_config, then `router.push('/templates/[id]/design')` |

---

## Step 2 — Layout Designer (`design/page.tsx`)

### Architecture: 3-Column Layout

```
┌─────────────────┬────────────────────────────┬─────────────────────┐
│   Fields Panel  │       Canvas (zoom)         │  Block Properties   │
│   (left, 240px) │   (center, flex-1)          │   (right, 280px)    │
│                 │                             │                     │
│ "PRINT FIELDS"  │  White page (215.9×279.4mm) │ Position & Size     │
│  [field rows]   │  with mm ruler overlay      │ Font controls       │
│ "NEW BLOCKS"    │                             │ Border controls     │
│  [text/divider] │  Ctrl+Scroll = zoom         │ Background color    │
└─────────────────┴────────────────────────────┴─────────────────────┘
```

### `extractPrintFields(fc)` — Field → Block Key Mapping

Central function that converts `field_config` → list of renderable field keys. **Both** `design/page.tsx` and `preview/page.tsx` implement identical logic.

```typescript
// Returns PrintField[] — ordered list of enabled-for-print fields
function extractPrintFields(fc: FieldConfig): PrintField[] {
    if (fc.show_logo?.print)    add('store_logo',    'Company Logo')
    if (fc.show_name?.print)    add('store_name',    'Company Name')
    if (fc.show_address?.print) add('store_address', 'Company Address')
    if (fc.show_date?.print)    add('doc_date',      'Date')
    if (fc.show_order_number?.print) add('doc_number', 'Document Number')
    // customer_detail → ONE entry if any customer field is print-enabled
    const anyCustomerPrint = Object.values(cf).some(v => v?.print)
    if (anyCustomerPrint) add('customer_detail', ...)
    if (fc.show_customer_shipping?.print) add('shipping_addr', ...)
    if (fc.show_customer_billing?.print)  add('billing_addr',  ...)
    if (fc.show_shipping?.print)          add('freight',       ...)
    if (fc.show_promotions?.print)        add('promotions',    ...)
    if (fc.show_notes?.print)             add('notes',         ...)
    if (fc.show_policy?.print)            add('policy',        ...)
    // Metadata fields: key = 'meta_${mf.key}'
    for (const mf of fc.metadata_fields ?? []) {
        if (mf.print) add(`meta_${mf.key}`, mf.label || mf.key)
    }
}
```

### `generateDefaultLayout(fc)` — Default Block Positions

Called when no existing layout is found. Generates a stack of blocks with `y` advancing downward.

```typescript
function generateDefaultLayout(fc: FieldConfig): LayoutBlock[] {
    const W = 195   // default block width in mm
    let y = 10

    // store_logo  → single image block   (30mm wide × 20mm tall)
    // store_name  → single brand block   (90mm wide × 9mm tall)  ← NEW: 1 block only
    // store_address → field_title + field_data pair
    // doc_date, doc_number, ... → field_title + field_data pair
    // customer_detail → field_title + customer_detail data block
    // metadata → field_title + field_data pair

    // Always appended at the end:
    blocks.push(mk({ id: 'table',   label: 'Line Items Table', y, height: 80, locked: true }))
    blocks.push(mk({ id: 'summary', label: 'Order Summary', x: 120, y, width: W - 110, height: 30, locked: true }))
}
```

**Store Name Special Case:** `store_name` generates a **single** `field_data` block (id: `store_name_brand`) instead of a T+D pair. It is positioned directly below the logo and is intended as a branding text element.

### Block IDs — Naming Conventions

| Block | ID Pattern |
|-------|-----------|
| Store logo | `store_logo_img` |
| Store name (brand) | `store_name_brand` |
| Field title | `{fieldKey}_title` |
| Field data | `{fieldKey}_data` |
| Customer detail data | `customer_detail_data` |
| Line items table | `table` |
| Order summary | `summary` |
| Free text (added by user) | `text_{timestamp}` |
| Divider | `divider_{timestamp}` |
| Image | `image_{timestamp}` |

### Structural Blocks

`table` and `summary` are `locked: true` — they cannot be deleted but CAN be:
- Moved by drag
- Moved by arrow keys
- Resized via corner handles
- Styled via the Properties panel
- Clamped by `clampBlock()`

### Block Clamping — `clampBlock()`

All block mutations pass through this helper to enforce page boundaries:

```typescript
function clampBlock<T extends { x: number; y: number; width: number; height: number }>(b: T): T {
    const x = Math.max(0, Math.min(b.x, PAGE_W_MM - 1))
    const y = Math.max(0, Math.min(b.y, PAGE_H_MM - 1))
    const width  = Math.max(1, Math.min(b.width,  PAGE_W_MM - x))
    const height = Math.max(1, Math.min(b.height, PAGE_H_MM - y))
    return { ...b, x, y, width, height }
}
```

**Applied at every mutation point:**

| Handler | When |
|---------|------|
| `onPointerMove` drag path | While dragging any block |
| `onPointerMove` resize path | While dragging a resize handle |
| `onPointerMove` gridResize path | While dragging col/row dividers on structural blocks |
| Arrow key handler | On any arrow key nudge (0.1mm or 1mm with Shift) |
| `patchBlock()` | Any property panel change (X, Y, W, H inputs) |
| `moveSelection()` | Multi-select drag/move |
| `setBlocks()` on load | Initial clamp of blocks loaded from database |
| Multi-select W/H fan-out | When batch-resizing in the properties panel |

### Arrow Key Nudging

```typescript
// Shift = 1mm steps, no Shift = 0.1mm steps
const step = e.shiftKey ? 1 : 0.1
const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
const dy = e.key === 'ArrowUp'   ? -step : e.key === 'ArrowDown'  ? step : 0

setBlocks(prev => prev.map(b => {
    if (!ids.has(b.id)) return b
    return clampBlock({
        ...b,
        x: parseFloat((b.x + dx).toFixed(1)),
        y: parseFloat((b.y + dy).toFixed(1)),
    })
}))
```

Works on ALL selected blocks including locked structural blocks.

### Ctrl+Scroll Zoom

Implemented as a **native `document` event listener** (NOT React synthetic events) because React's wheel events are passive by default, preventing `e.preventDefault()`:

```typescript
useEffect(() => {
    const handler = (e: WheelEvent) => {
        if (!e.ctrlKey) return
        if (!canvasRef.current?.contains(e.target as Node)) return
        e.preventDefault()   // blocks browser zoom — only works with { passive: false }
        const delta = e.deltaY > 0 ? -0.1 : 0.1
        setScale(s => Math.max(0.25, Math.min(3.0, parseFloat((s + delta).toFixed(2)))))
    }
    document.addEventListener('wheel', handler, { passive: false })
    return () => document.removeEventListener('wheel', handler)
}, [])
```

### `DimInput` — Math Expression Input

Position and size fields accept arithmetic expressions:

```typescript
// User can type: "22 + 6" → resolves to 28
// User can type: "100 - 15.5" → resolves to 84.5
function DimInput({ value, onChange, min }) {
    const [raw, setRaw] = useState(String(value))
    const commit = () => {
        try {
            const result = Function(`'use strict'; return (${raw})`)()
            if (isFinite(result) && result >= (min ?? 0)) onChange(parseFloat(result.toFixed(1)))
        } catch { setRaw(String(value)) }  // revert on invalid expression
    }
    return <input value={raw} onChange={e => setRaw(e.target.value)} onBlur={commit} onKeyDown={e => e.key === 'Enter' && commit()} />
}
```

### Block Selection — No Resize Animation Glitch

Selecting/deselecting blocks previously caused adjacent blocks to flicker via border-collapse shift recalculation. Fixed by disabling the shift when any block is selected:

```typescript
// blockCanvasStyle() — isActive disables border-collapse shift
const isActive = dragging.current !== null
    || resizing.current !== null
    || selectedIds.size > 0   // ← this is the key fix
```

### Block Groups

Blocks can be grouped via the toolbar button. Grouped blocks:
- Are selected together when any member is clicked
- Move together when dragged
- Can be ungrouped via the toolbar
- **Ctrl+Drag** pulls a single block out of a group (breaks it individually)

```typescript
// groupId stored on each block
const dragIds = selectedIds.has(blockId)
    ? [...selectedIds]
    : b.groupId
        ? blocks.filter(x => x.groupId === b.groupId).map(x => x.id)
        : [blockId]
```

### Text Formatting in Text Blocks

Text blocks support inline `bold`, `italic`, `underline` via the toolbar. Stored in `block.props.richText` as a simple markup string. The canvas renders using a `<div dangerouslySetInnerHTML>` after sanitizing tags.

### Block Style Modal (Back Style)

The Properties panel exposes a "Back Style" modal (triggered from the panel) for:
- Background color picker
- Border top/right/bottom/left (individual px values)
- Border color
- Border radius (px)
- Reference images for radius values shown as visual previews

### `patchBlock()` — Single Block Update

```typescript
function patchBlock(id: string, patch: Partial<LayoutBlock>) {
    setBlocks(prev => prev.map(b =>
        b.id === id ? clampBlock({ ...b, ...patch }) : b
    ))
}
```

All position/size updates from the properties panel go through `patchBlock`, which then calls `clampBlock`.

### Migration — Old Layout Format Handling

When a template is loaded with an older layout format, migrations run automatically:

```typescript
// 1. Strip old monolithic header block
migrated = migrated.filter(b => !(b.id === 'header' && b.type === 'structural'))

// 2. Migrate old dual store_name blocks → single brand block
const hasOldTitle = migrated.some(b => b.id === 'store_name_title')
const hasNewBrand = migrated.some(b => b.id === 'store_name_brand')
if (hasOldTitle && !hasNewBrand) {
    const oldData = migrated.find(b => b.id === 'store_name_data')
    const brandBlock: LayoutBlock = {
        id: 'store_name_brand', type: 'field_data', label: 'Company Name',
        fieldKey: 'store_name', subType: 'data',
        x: oldData?.x ?? 10, y: oldData?.y ?? 35,
        width: 90, height: 9, locked: false, hidden: false,
        style: { ...(oldData?.style ?? DEFAULT_STYLE) }, props: {},
    }
    migrated = migrated
        .filter(b => b.id !== 'store_name_title' && b.id !== 'store_name_data')
        .concat(brandBlock)
}

// 3. Inject missing store_* blocks from fresh layout generation
const freshStoreBlocks = generateDefaultLayout(fc).filter(b =>
    ['store_logo', 'store_name', 'store_address'].includes(b.fieldKey ?? '')
)
// (only injected if not already present)
```

### `handleSave()` — Save with Field Config Sync

When saving the layout, blocks that are **all hidden** for a given `fieldKey` automatically disable that field's `print` toggle in `field_config`. This prevents "field enabled but no block on canvas" errors in the Preview step.

```typescript
async function handleSave(andContinue = false) {
    // fieldKey → field_config key mapping
    const FIELD_TO_CONFIG = {
        store_logo: 'show_logo', store_name: 'show_name', store_address: 'show_address',
        doc_date: 'show_date', doc_number: 'show_order_number',
        customer_detail: 'customer_detail',   // special
        shipping_addr: 'show_customer_shipping', billing_addr: 'show_customer_billing',
        freight: 'show_shipping', promotions: 'show_promotions',
        notes: 'show_notes', policy: 'show_policy',
    }

    // Group blocks by fieldKey
    const byKey = new Map<string, LayoutBlock[]>()
    for (const b of blocks) {
        if (!b.fieldKey) continue
        const arr = byKey.get(b.fieldKey) ?? []; arr.push(b); byKey.set(b.fieldKey, arr)
    }

    for (const [fieldKey, bArr] of byKey) {
        const allHidden = bArr.every(b => b.hidden)
        if (!allHidden) continue  // still visible — leave field_config alone

        // For customer_detail: disable all customer subfields
        // For metadata fields (meta_*): update metadata_fields array
        // For standard toggles: set configKey.print = false
    }

    const savePayload: any = { layout_data: blocks }
    if (fcChanged) savePayload.field_config = newFieldConfig

    await updateTemplate(id, savePayload)
    toast.success(fcChanged ? 'Layout saved — field config updated' : 'Layout saved')
}
```

### Fields Panel — T/D Block Visibility Toggles

Each field in the left panel shows T (title) and D (data) buttons. Clicking toggles the corresponding block's `hidden` property:

```typescript
function toggleSubBlockVisible(fieldKey: string, subType: 'title' | 'data', visible: boolean) {
    setBlocks(prev => prev.map(b =>
        b.fieldKey === fieldKey && (b.subType === subType || b.type === 'customer_detail')
            ? { ...b, hidden: !visible }
            : b
    ))
}
```

The toggle state is read from the actual block's `hidden` property — not from `field_config`. They sync to `field_config` only on **Save**.

---

## Step 3 — Preview (`preview/page.tsx`)

### Layout Validation

Before rendering the preview, the system checks for missing fields:

```typescript
// Fields enabled for print but not placed as a visible block
const missingFields = allPrintFields.filter(field => {
    if (field.key === 'store_logo') {
        return !visibleBlocks.some(b => b.fieldKey === 'store_logo')
    }
    return !visibleBlocks.some(b => b.fieldKey === field.key)
})

// If any fields are missing → show error panel with field list + link back to layout
if (hasNoLayout || missingFields.length > 0) { /* show error UI */ }
```

This prevents blank sections or crashes when the PDF renderer encounters missing data.

### Dummy Data Map

Preview renders with realistic sample data. Store info (name, logo, address) is pulled **live** from `useStoreInfo()`:

```typescript
const liveDummy = {
    ...DUMMY,
    store_name:    { title: 'Company', data: storeInfo.name },       // ← live
    store_address: { title: 'Address', data: storeInfo.address },    // ← live
    store_logo:    { title: 'Logo',    data: storeInfo.logoUrl },    // ← live
}
```

### Block CSS — `blockCSS(block)`

Converts `LayoutBlock` to React inline styles, scaling all mm values by current zoom:

```typescript
function blockCSS(b: LayoutBlock): React.CSSProperties {
    const s = b.style ?? {}
    return {
        position: 'absolute',
        left:   mmToPx(b.x) * scale,
        top:    mmToPx(b.y) * scale,
        width:  mmToPx(b.width) * scale,
        height: mmToPx(b.height) * scale,
        backgroundColor: s.bgColor !== 'transparent' ? s.bgColor : undefined,
        // borders — only applied if at least one side > 0
        color:      s.fontColor ?? '#111111',
        fontSize:   `${s.fontSize ?? 9}pt`,
        fontFamily: s.fontFamily === 'serif' ? 'Georgia, serif'
                  : s.fontFamily === 'mono'  ? 'monospace'
                  : 'system-ui, sans-serif',
    }
}
```

### Rendering by Block Type

| Block Type | Render |
|------------|--------|
| `structural` (id=`table`) | `<table>` with sample line items |
| `structural` (id=`summary`) | Subtotal / Tax / Total rows |
| `image` / `fieldKey=store_logo` | `<img>` with store logo |
| `field_title` (subType=`title`) | Bold uppercase label text |
| `customer_detail` | Multi-line customer field rows from `customerFieldOrder` |
| `field_data` (subType=`data`) | Data value text from DUMMY map |

### Sample Line Items (Preview Only)

```typescript
const LINE_ITEMS = [
    { sku: 'ECO-SP-400',  desc: 'Solar Panel 400W Monocrystalline',         qty: 4, price: 350.00 },
    { sku: 'ECO-BAT-10K', desc: 'Battery Storage System 10kWh LiFePO4',    qty: 1, price: 2200.00 },
    { sku: 'ECO-INV-5K',  desc: 'Hybrid Inverter 5kW w/ Grid Tie',          qty: 1, price: 890.00 },
    { sku: 'INST-FULL',   desc: 'Full System Installation & Commissioning', qty: 1, price: 1200.00 },
]
```

### Navigation

| Button | Destination |
|--------|-------------|
| `← Back to Designer` | `router.push('/templates/[id]/design')` |
| `Print Test` | `window.print()` |
| `Save & Set as Default` | PATCH `is_default: true` → redirect to `/templates` |

---

## Template Gallery (`templates/page.tsx`)

### Features

- 3 sections: Estimates / Sales Orders / Invoices
- Each template card shows: name, default badge, thumbnail (if set)
- **Context menu** (3-dot) per card with: Edit Fields, Edit Layout, Rename (inline), Duplicate, Delete
- Delete requires typing `DELETE` in a confirmation input
- Inline rename with Save/Cancel (Enter to save, Escape to cancel)
- Fixed-position dropdown (uses `getBoundingClientRect()` to position relative to viewport)
- Admin-only guard: `isPosStaff` users are redirected to `/dashboard`

### Create Template Flow

```typescript
const template = await createTemplate({
    name:     'My New Estimate',
    doc_type: 'estimate',
})
router.push(`/templates/${template.id}/edit`)
```

---

## `TemplatePicker` Component

Used inside the Estimates/Orders pages to apply a template to an existing document.

```typescript
// components/pos/TemplatePicker.tsx
<TemplatePicker
    docType="estimate"
    onSelect={(template) => applyTemplateToDocument(template)}
/>
```

---

## Building a New Template Page from Scratch

If you need to create a **new page** that renders template output (e.g., a real PDF endpoint instead of the browser preview), follow this pattern:

### 1. Load the template

```typescript
const { templates } = useDocumentTemplates()
const template = templates.find(t => t.id === id)
const fc     = template.field_config ?? {}
const blocks = (template.layout_data ?? []) as LayoutBlock[]
```

### 2. Filter visible blocks

```typescript
const visibleBlocks = blocks.filter(b => !b.hidden && 'fieldKey' in b)
```

### 3. Check for missing print fields

```typescript
const allPrint = extractPrintFields(fc)
const missing  = allPrint.filter(f => !visibleBlocks.some(b => b.fieldKey === f.key))
if (missing.length > 0) { /* show error */ }
```

### 4. Render each block

```typescript
visibleBlocks.map(block => {
    // CSS: position absolute, use mmToPx(b.x) * scale etc.
    // Type dispatch:
    if (block.type === 'structural' && block.id === 'table')   → render <table>
    if (block.type === 'structural' && block.id === 'summary') → render totals
    if (block.type === 'image')                                → render <img>
    if (block.subType === 'title')                             → render bold label
    if (block.type === 'customer_detail')                      → render field rows
    if (block.subType === 'data')                              → render value
})
```

### 5. Apply block style to CSS

```typescript
const s = block.style
const css: React.CSSProperties = {
    position:   'absolute',
    left:       mmToPx(block.x) * scale,
    top:        mmToPx(block.y) * scale,
    width:      mmToPx(block.width) * scale,
    height:     mmToPx(block.height) * scale,
    color:      s.fontColor ?? '#111111',
    fontSize:   `${s.fontSize ?? 9}pt`,
    fontWeight: s.fontWeight ?? 'normal',
    fontStyle:  s.fontStyle ?? 'normal',
    textDecoration: s.textDecoration ?? 'none',
    fontFamily: s.fontFamily === 'serif' ? 'Georgia, serif'
              : s.fontFamily === 'mono'  ? 'monospace'
              : 'system-ui, sans-serif',
    textAlign:  s.textAlign ?? 'left',
    backgroundColor: s.bgColor !== 'transparent' ? s.bgColor : undefined,
    borderTopWidth:    s.borderTop    ? s.borderTop    : undefined,
    borderRightWidth:  s.borderRight  ? s.borderRight  : undefined,
    borderBottomWidth: s.borderBottom ? s.borderBottom : undefined,
    borderLeftWidth:   s.borderLeft   ? s.borderLeft   : undefined,
    borderColor:       (s.borderTop || s.borderRight || s.borderBottom || s.borderLeft)
                       ? s.borderColor : undefined,
    borderStyle:       (s.borderTop || s.borderRight || s.borderBottom || s.borderLeft)
                       ? 'solid' : undefined,
    borderRadius: s.borderRadius ? `${s.borderRadius}px` : undefined,
}
```

---

## FieldKey → FieldConfig Mapping Reference

Use this table when writing sync logic, validators, or PDF renderers:

| `fieldKey` (block) | `field_config` key | Notes |
|--------------------|-------------------|-------|
| `store_logo` | `show_logo` | Image block |
| `store_name` | `show_name` | Single brand block (`store_name_brand`) |
| `store_address` | `show_address` | T+D pair |
| `doc_date` | `show_date` | T+D pair |
| `doc_number` | `show_order_number` | T+D pair |
| `customer_detail` | `customer_fields.*` | All subfields disabled together |
| `shipping_addr` | `show_customer_shipping` | T+D pair |
| `billing_addr` | `show_customer_billing` | T+D pair |
| `freight` | `show_shipping` | T+D pair |
| `promotions` | `show_promotions` | T+D pair |
| `notes` | `show_notes` | T+D pair |
| `policy` | `show_policy` | T+D pair, has `.text` property |
| `meta_{key}` | `metadata_fields[].key` | Dynamic from system-defaults |

---

## Common Gotchas

### 1. Duplicate `extractPrintFields` — Keep in Sync
Both `design/page.tsx` and `preview/page.tsx` each have their own copy of `extractPrintFields`. If you add a new field type, **update both**. A future refactor should extract this to a shared utility in `lib/templateUtils.ts`.

### 2. `store_name` is 1 Block, Everything Else is 2
When counting blocks for a field, do not assume T+D pairs everywhere. `store_name` (brand block) and `store_logo` are single blocks.

### 3. Block `hidden` ≠ `field_config.print = false`
`hidden` is a layout-level toggle (block exists but is invisible). `field_config.print = false` means the field is completely excluded from the print fields list. They sync on Save — but not in real time.

### 4. Locked ≠ Immovable
`locked: true` only prevents **deletion**. Drag, resize, arrow keys, and the Properties panel all still work on locked blocks.

### 5. `clampBlock` Shrinks Dimensions
If a block's `x + width > PAGE_W_MM`, the width is shrunk to fit. Width is never negative (min 1mm). The block is never pushed — only shrunk.

### 6. Metadata Fields Need `meta_` Prefix
In block `fieldKey`, metadata fields use `meta_${mf.key}`. When doing lookups in `field_config`, strip the `meta_` prefix to get the actual key.

---

## Quick Code Snippets

### Check if a block is a store-info block
```typescript
const isStoreBlock = ['store_logo', 'store_name', 'store_address']
    .includes(block.fieldKey ?? '')
```

### Get the displayed label for a block
```typescript
const label = fc.custom_labels?.[block.fieldKey ?? ''] || block.label
```

### Check if a field is fully hidden in the layout
```typescript
const blocksForField = blocks.filter(b => b.fieldKey === fieldKey)
const allHidden = blocksForField.length > 0 && blocksForField.every(b => b.hidden)
```

### Build a new structural block (for use in generateDefaultLayout)
```typescript
const mk = (o: Partial<LayoutBlock>): LayoutBlock => ({
    id: '', type: 'structural', label: '', fieldKey: null, subType: null,
    x: 10, y: 0, width: 195, height: 10, locked: false, hidden: false,
    style: { ...DEFAULT_STYLE }, props: {},
    ...o,
})
```

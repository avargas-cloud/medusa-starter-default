# POS Document Template System — Complete Reference

> **Last updated:** March 2026 (v2 — SVG borders, column alignment, metadata auto-inject)
> **Applies to:** `ecopowertech-store-pos` Next.js app (all pages under `app/(pos)/templates/`)

---

## Overview

The Template System is the engine that drives PDF/print generation for Estimates, Sales Orders, and Invoices in the EcoPowerTech POS. It is a **3-step wizard**:

```
Step 1 — Fields   →   Step 2 — Layout Designer   →   Step 3 — Preview
/templates/[id]/edit   /templates/[id]/design       /templates/[id]/preview

Templates are then instantiated on the **Estimates Page** `/estimates/[id]` where they can be printed, downloaded as PDF, or attached directly to customer emails via the `Send Estimate` modal.
```

Templates are **type-scoped** (`estimate | order | invoice`), support **duplicate/set-default**, and are stored in the backend database via a dedicated `document-templates` endpoint on the Medusa admin API.

---

## File Map

| File | Purpose |
|------|---------|
| `app/(pos)/templates/page.tsx` | Gallery — lists all templates grouped by type |
| `app/(pos)/templates/[id]/edit/page.tsx` | **Step 1** — Fields & toggles configurator |
| `app/(pos)/templates/[id]/edit/_components.tsx` | `ToggleRow`, `Section`, `StepBadge` UI primitives |
| `app/(pos)/templates/[id]/design/page.tsx` | **Step 2** — Visual layout drag-and-drop editor |
| `app/(pos)/templates/[id]/preview/page.tsx` | **Step 3** — Print preview with real store data |
| `app/(pos)/templates/[id]/_design/_types.ts` | Shared TypeScript interfaces (`LayoutBlock`, `BlockStyle`, etc.) |
| `app/(pos)/templates/[id]/_design/_utils/` | Utility barrel (`fields.ts`, `styles.ts`, `dimensions.ts`) |
| `app/(pos)/templates/[id]/_design/_utils/fields.ts` | `extractPrintFields`, `generateDefaultLayout`, `defaultCustomerFieldOrder` |
| `app/(pos)/templates/[id]/_design/_utils/styles.ts` | `blockCanvasStyle`, `canvasBorderLines`, `subBorderStyle`, `canvasDataText` |
| `app/(pos)/templates/[id]/_design/_utils/dimensions.ts` | `mmToPx`, `pxToMm`, constants |
| `app/(pos)/templates/[id]/_design/FieldsPalette.tsx` | Left panel — visibility toggles & auto-create for all fields |
| `app/(pos)/templates/[id]/_design/StructuralBlockCanvas.tsx` | Table/summary block editor with column/row resize |
| `app/(pos)/templates/[id]/_design/SubElStylePanel.tsx` | Per-subelement style controls (th/td border, font, alignment) |
| `app/(pos)/templates/[id]/_design/BlockPropertiesPanel.tsx` | Right panel — position, size, style for selected block |
| `app/(pos)/templates/[id]/_design/GuidelinesOverlay.tsx` | Snap guides overlay component |
| `app/(pos)/templates/[id]/_design/BatchModal.tsx` | Batch-apply style to multiple selected blocks |
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
    id:            string
    name:          string
    doc_type:      'estimate' | 'order' | 'invoice'
    is_default:    boolean
    thumbnail:     string | null
    field_config:  Record<string, any>   // ← Step 1 output
    layout_data:   any[]                 // ← Step 2 output (LayoutBlock[])
    layout_guides: any[]                 // ← Step 2 output (Guide[])
    created_by:    string | null
    created_at:    string
    updated_at:    string
}
```

### `useDocumentTemplates` Hook

```typescript
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

Produced by **Step 1 — Fields**. Controls which sections appear on screen vs. print.

```typescript
interface ToggleValue { screen: boolean; print: boolean }

interface MetadataField {
    key:    string    // matches key from /admin/system-defaults
    label:  string    // custom display label
    screen: boolean   // show in screen view
    print:  boolean   // show in print/PDF
}

interface FieldConfig {
    // Store info
    show_logo:         ToggleValue
    show_store_brand:  ToggleValue   // "Company Name Logo" (separate from show_name)
    show_name:         ToggleValue
    show_address:      ToggleValue
    show_document_name: ToggleValue & { text: string }

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
    show_thank_you:         ToggleValue & { text: string }

    // Dynamic metadata from /admin/system-defaults (e.g. customer_po, project_name, lead_time)
    metadata_fields: MetadataField[]

    // Store Contact Additions (March 2026)
    show_store_phone: ToggleValue
    show_store_email: ToggleValue

    // Item table column configuration
    columns: {
        key:     string    // 'img' | 'sku' | 'description' | 'qty' | 'unit_price' | 'amount'
        label:   string    // display header
        width:   number    // percentage of table width (must sum ≤ 100)
        visible: boolean
    }[]

    summary_rows: {
        key:     string    // 'subtotal' | 'tax' | 'shipping' | 'discount' | 'total'
        label:   string
        visible: boolean
    }[]

    // Custom labels for any field
    custom_labels: Record<string, string>
}
```

### `LayoutBlock` (elements of `template.layout_data`)

Produced by **Step 2 — Layout**. Each block is a positioned rectangle on the page.

```typescript
export interface LayoutBlock {
    id:       string             // unique, stable ('store_logo_img', 'table', etc.)
    groupId?: string             // if set, block belongs to an explicit drag group
    type:     BlockType
    label:    string
    fieldKey: string | null      // links back to FieldConfig (e.g. 'store_name', 'meta_customer_po')
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
    borderTop:      number    // px stroke width (0 = no border)
    borderRight:    number
    borderBottom:   number
    borderLeft:     number
    borderColor:    string    // hex, default '#cccccc'
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

### Sub-element Styles (`block.props.subStyles`)

Structural blocks (table `id='table'`) support per-subelement style overrides stored in `block.props.subStyles`:

```typescript
// block.props.subStyles is a Record<string, Partial<BlockStyle>>
// Keys: 'th' (header row), 'td' (data rows)
const thStyle = block.props.subStyles?.['th'] ?? {}   // header row style
const tdStyle = block.props.subStyles?.['td'] ?? {}   // data row style

// Per-column alignment overrides (SEPARATE for th and td!)
// block.props.thColStyles: Record<colKey, { textAlign, verticalAlign }>
// block.props.tdColStyles: Record<colKey, { textAlign, verticalAlign }>
// IMPORTANT: thColStyles and tdColStyles are INDEPENDENT — changing one does NOT affect the other
```

> **Critical:** `thColStyles` and `tdColStyles` are always stored separately. Pre-v2 layouts used `colStyles` for both — if you encounter an old `colStyles` key, fall back to it for both `th` and `td`, then save separate keys on next update.

### Page Dimensions

```typescript
// _design/_utils/dimensions.ts
const MM_TO_PX  = 3.7795
const PAGE_W_MM = 215.9   // US Letter width  (8.5in)
const PAGE_H_MM = 279.4   // US Letter height (11in)

function mmToPx(mm: number) { return mm * MM_TO_PX }
function pxToMm(px: number) { return Math.round(px / MM_TO_PX * 10) / 10 }
```

---

## Step 1 — Fields Configurator (`edit/page.tsx`)

### What It Does

- User selects which fields appear on screen (`Monitor` icon) vs. print (`Printer` icon) — **independently**
- Configures item table column visibility and widths (must total ≤ 100%)
- Configures order summary row visibility and order
- Drag-sorts customer fields and summary rows
- Supports custom labels for any field (renamed inline via `onCustomLabelChange`)
- Fetches available metadata fields from `/admin/system-defaults` (e.g. `customer_po`, `project_name`, `lead_time`)

### `ToggleRow` Component (`_edit/_components.tsx`)

```typescript
// Each field row has independent Screen and Print checkboxes
<ToggleRow
    label="Customer PO"
    screen={mf?.screen ?? false}
    print={mf?.print ?? false}
    onChange={(which, val) => setMetaField(key, which, val)}
    customLabel={mf?.label}
    onCustomLabelChange={(v) => setMetaField(key, 'label', v)}
/>
```

**Critical implementation rules:**
- The `screen` checkbox and `print` checkbox call `onChange('screen', val)` and `onChange('print', val)` **independently** — they must NEVER be linked
- `onAnyChange` is deprecated and removed — do NOT add a callback that sets both checkboxes from a single click

### `setMetaField` — Metadata Checkbox Handler

```typescript
const setMetaField = useCallback((key: string, which: 'screen' | 'print' | 'label', val: boolean | string) => {
    setConfig(prev => {
        const existing = prev.metadata_fields.find(f => f.key === key)
        if (existing) {
            // Update the specific field that was changed
            return { ...prev, metadata_fields: prev.metadata_fields.map(f =>
                f.key === key ? { ...f, [which]: val } : f
            )}
        }
        // NEW ENTRY: only the clicked checkbox is enabled; other defaults to false
        return {
            ...prev,
            metadata_fields: [...prev.metadata_fields, {
                key,
                label: key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
                screen: which === 'screen' ? val as boolean : false,  // ← NEVER default true
                print:  which === 'print'  ? val as boolean : false,  // ← NEVER default true
            }]
        }
    })
}, [])
```

> **Bug history (fixed Mar 2026):** The original code used `onAnyChange` which called `setMetaField(key, 'screen', true)` whenever ANY checkbox fired. New entries also hardcoded the other field to `true`. Both defects caused "both checkboxes toggle together" — now completely removed.

### Column Width Validation

```typescript
// Must be exactly 100% — Description column gets remaining width auto-assigned
const colWidthSum  = visibleCols.reduce((s, c) => s + c.width, 0)
const colWidthOver = colWidthSum > 100

// On save: 'description' column adapts to reach exactly 100%
if (Math.abs(100 - colWidthSum) > 0.001) {
    const totalWithoutDesc = visibleCols.filter(c => c.key !== 'description').reduce((s, c) => s + c.width, 0)
    const newDescWidth = parseFloat(Math.max(0, 100 - totalWithoutDesc).toFixed(2))
    
    finalConfig = {
        ...config,
        columns: config.columns.map(c =>
            c.key === 'description' && c.visible ? { ...c, width: newDescWidth } : c
        ),
    }
}
```

> **v2.1 Feature:** Column resizing inside the layout designer canvas snaps to 0.01% increments to allow high precision, while the description column width is read-only in the fields editor since it auto-absorbs remaining space.

### Store Information Enhancements

Two new fields were added to the `Store Information` sector:
1. **Company Phone** (`show_store_phone`) -> Prints `'Phone: ' + config value`
2. **Company Email** (`show_store_email`) -> Prints `'Email: ' + config value`

These fields utilize the actual store metadata values provided by the `useStoreInfo` hook and automatically add their respective prefixes before rendering.

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
│   (left, 208px) │   (center, flex-1)          │   (right, 280px)    │
│                 │                             │                     │
│  [field rows]   │  White page (215.9×279.4mm) │ Position & Size     │
│  eye = visible  │  with optional guides       │ Font controls       │
│  + = no blocks  │                             │ Border controls     │
│                 │  Ctrl+Scroll = zoom          │ Background color    │
└─────────────────┴────────────────────────────┴─────────────────────┘
```

### `extractPrintFields(fc)` — Field → Block Key Mapping

Lives in `_design/_utils/fields.ts`. Converts `field_config` → ordered list of renderable fields.

```typescript
export function extractPrintFields(fc: any): PrintField[] {
    // FieldConfig booleans → PrintField[]
    if (fc.show_logo?.print)          add('store_logo',    'Company Logo')
    if (fc.show_store_brand?.print)   add('store_brand',   'Company Name Logo')
    if (fc.show_name?.print)          add('store_name',    'Company Name')
    if (fc.show_address?.print)       add('store_address', 'Company Address')
    if (fc.show_document_name?.print) add('doc_name',      fc.show_document_name.text || 'Document Name')
    if (fc.show_date?.print)          add('doc_date',      'Date')
    if (fc.show_order_number?.print)  add('doc_number',    'Document Number')

    // customer_detail → ONE entry if ANY customer field has screen OR print enabled
    const anyCustomerPrint = Object.values(cf).some(v => v?.print)
    if (anyCustomerPrint) add('customer_detail', cl['customer_detail'] || 'Customer Detail')

    if (fc.show_customer_shipping?.print) add('shipping_addr', ...)
    if (fc.show_customer_billing?.print)  add('billing_addr',  ...)
    if (fc.show_shipping?.print)          add('freight',       ...)
    if (fc.show_promotions?.print)        add('promotions',    ...)
    if (fc.show_notes?.print)             add('notes',         ...)
    if (fc.show_policy?.print)            add('policy',        ...)
    if (fc.show_thank_you?.print)         add('thank_you',     fc.show_thank_you.text || ...)

    // Metadata fields: include if EITHER screen OR print is true
    // This ensures screen-only metadata fields (e.g. customer_po) appear in the
    // layout palette even if print is disabled. The PDF preview separately checks mf.print.
    for (const mf of fc.metadata_fields ?? []) {
        if (mf.screen || mf.print) out.push({ key: `meta_${mf.key}`, label: mf.label || mf.key })
    }
    return out
}
```

> **v2 change:** Metadata fields previously checked `mf.print` only. Changed to `mf.screen || mf.print` so screen-only fields appear in the layout editor palette. The PDF preview independently verifies `mf.print`.

### `generateDefaultLayout(fc)` — Default Block Positions

Called for fresh templates (no existing layout). Uses `extractPrintFields(fc)` internally so it automatically respects screen/print toggles.

```typescript
export function generateDefaultLayout(fc: any): LayoutBlock[] {
    const W = 195   // default block width in mm
    let y = 10
    const mk = (o: Partial<LayoutBlock>): LayoutBlock => ({
        id: '', type: 'structural', label: '', fieldKey: null, subType: null,
        x: 10, y: 0, width: W, height: 10, locked: false, hidden: false,
        style: { ...DEFAULT_STYLE }, props: {},
        ...o,
    })

    for (const f of extractPrintFields(fc)) {
        if (f.key === 'store_logo') {
            // Single image block (30mm × 20mm)
            blocks.push(mk({ id: 'store_logo_img', type: 'image', fieldKey: 'store_logo', y, width: 30, height: 20 }))
            y += 25
        } else if (f.key === 'store_name') {
            // Single brand block — NOT a T+D pair
            blocks.push(mk({ id: 'store_name_brand', type: 'field_data', fieldKey: 'store_name', subType: 'data', y, width: 90, height: 9 }))
            y += 13
        } else if (f.key === 'customer_detail') {
            // Title block + a custom-type data block
            blocks.push(mk({ id: 'customer_detail_title', type: 'field_title', fieldKey: 'customer_detail', subType: 'title', y, ... }))
            blocks.push(mk({ id: 'customer_detail_data',  type: 'customer_detail', fieldKey: 'customer_detail', subType: 'data', ... }))
            y += 8 + dataH + 4
        } else {
            // Standard T+D pair: {key}_title and {key}_data
            blocks.push(mk({ id: `${f.key}_title`, type: 'field_title', fieldKey: f.key, subType: 'title', y,      height: 7  }))
            blocks.push(mk({ id: `${f.key}_data`,  type: 'field_data',  fieldKey: f.key, subType: 'data',  y: y+8, height: 12 }))
            y += 24
        }
    }

    // Always locked at the bottom:
    blocks.push(mk({ id: 'table',   label: 'Line Items Table', y, height: 80, locked: true }))
    blocks.push(mk({ id: 'summary', label: 'Order Summary', x: 120, y, width: W - 110, height: 30, locked: true }))
}
```

### Block IDs — Naming Conventions

| Block | ID Pattern |
|-------|-----------|
| Store logo | `store_logo_img` |
| Store name (brand) | `store_name_brand` |
| Field title (any field) | `{fieldKey}_title` |
| Field data (any field) | `{fieldKey}_data` |
| Metadata title | `meta_{key}_title` |
| Metadata data | `meta_{key}_data` |
| Customer detail data | `customer_detail_data` |
| Line items table | `table` |
| Order summary | `summary` |
| Free text (added by user) | `text_{timestamp}` |
| Divider | `divider_{timestamp}` |
| Image | `image_{timestamp}` |

### `FieldsPalette` — Left Panel (`_design/FieldsPalette.tsx`)

Shows all enabled fields (screen OR print). Provides eye-toggle for canvas visibility and **auto-creates** blocks if a field has no canvas representation yet.

```typescript
// For each printField in extractPrintFields(fc):
const allBlocks = blocks.filter(b => b.fieldKey === f.key)
const anyVisible = allBlocks.some(b => !b.hidden)
const noBlocks   = allBlocks.length === 0   // field enabled but never added to canvas

// Eye button logic:
if (noBlocks) {
    // AUTO-CREATE: generate title+data blocks at bottom of canvas
    const newBlocks = makeBlocksForField(f, blocks)
    setBlocks(prev => [...prev, ...newBlocks])
} else {
    // TOGGLE: show/hide existing blocks
    setBlocks(prev => prev.map(b => b.fieldKey === f.key ? { ...b, hidden: anyVisible } : b))
}
```

Fields with no canvas blocks show a small amber `+` badge. Normal hidden fields show at 50% opacity with `EyeOff` icon.

**`makeBlocksForField(f, existingBlocks)`** helper inside the palette:
- Places new blocks below the last non-locked visible block
- Generates image block for `store_logo`
- Generates single `field_data` block for `store_brand`, `store_name`, `doc_name`, `thank_you`
- Generates title + data pair for all other fields (including `meta_*`)
- Uses `crypto.randomUUID()` for new block IDs (no external dependency)

### Auto-Injection into Existing Layouts (Design Page Init)

When opening the Design page for a template that already has a saved layout (`raw?.length > 0`), the init `useEffect` auto-injects any newly-enabled fields that are missing from the saved blocks:

```typescript
// design/page.tsx — useEffect for 'Init blocks'
const allEnabledFields = extractPrintFields(fc)
for (const pf of allEnabledFields) {
    if (migrated.some(b => b.fieldKey === pf.key)) continue  // already in layout

    // Try to get default block template from generateDefaultLayout
    let newBlocks = generateDefaultLayout(fc).filter(b => b.fieldKey === pf.key)

    // If not found (i.e. screen-only metadata), build manually:
    if (newBlocks.length === 0 && pf.key.startsWith('meta_')) {
        const bottomY = migrated.filter(b => !b.locked).reduce((m, b) => Math.max(m, b.y + b.height), 10) + 4
        const base = { x: 10, width: 95, locked: false, hidden: false, style: { ...DEFAULT_STYLE }, props: {} }
        newBlocks = [
            { ...base, id: `${pf.key}_title`, type: 'field_title', fieldKey: pf.key, subType: 'title', y: bottomY,     height: 7  },
            { ...base, id: `${pf.key}_data`,  type: 'field_data',  fieldKey: pf.key, subType: 'data',  y: bottomY + 8, height: 12 },
        ]
    }

    if (newBlocks.length > 0) {
        const bottomY = migrated.filter(b => !b.locked).reduce((m, b) => Math.max(m, b.y + b.height), 10) + 4
        migrated = [...migrated, ...newBlocks.map((b, i) => ({ ...b, y: bottomY + i * 14 }))]
    }
}
```

> **User flow:** Enable "Customer PO" in Step 1 → Save → Go to Step 2 → `meta_customer_po` blocks are automatically placed at the bottom of the canvas. No manual action needed.

### Border Rendering — SVG Overlay System

**⚠️ DO NOT use CSS borders on block divs.** Borders are rendered via a dedicated SVG overlay that draws each edge exactly once, eliminating:
- Double borders at shared edges between adjacent blocks
- Diagonal cut artifacts at corners when border widths differ
- Border disappearing at high zoom levels
- Block `backgroundColor` covering border lines

#### Editor Canvas — `CanvasBordersSVG` (inline in `design/page.tsx`)

```typescript
// Rendered AFTER all block divs in the DOM with zIndex: 20
const { hLines, vLines } = canvasBorderLines(blocks.filter(b => !b.hidden), scale)
// ... SVG <line> elements drawn from hLines and vLines

<svg className="absolute inset-0 pointer-events-none" style={{ zIndex: 20 }}
    width={svgW} height={svgH} viewBox={`0 0 ${svgW} ${svgH}`}>
    {hLines.map((l, i) => <line key={`h${i}`} x1={l.x1} y1={l.y} x2={l.x2} y2={l.y} stroke={l.c} strokeWidth={l.w} strokeLinecap="square" />)}
    {vLines.map((l, i) => <line key={`v${i}`} x1={l.x} y1={l.y1} x2={l.x} y2={l.y2} stroke={l.c} strokeWidth={l.w} strokeLinecap="square" />)}
</svg>
```

#### Preview Page — `BordersSVG` component (inside `preview/page.tsx`)

```typescript
// Must be rendered AFTER all block divs in the DOM with zIndex: 2
// WRONG (causes bgColor to cover borders): <BordersSVG/> then {blocks.map(...)}
// CORRECT:                                  {blocks.map(...)} then <BordersSVG/>

{visibleBlocks.map(block => { /* render each block */ })}
<BordersSVG blocks={visibleBlocks} />   // ← AFTER blocks

// SVG element:
<svg style={{ position: 'absolute', left: 0, top: 0, width: W, height: H,
              pointerEvents: 'none', overflow: 'visible',
              zIndex: 2 }}>   // ← zIndex ensures it floats above block backgrounds
```

#### `canvasBorderLines(blocks, scale)` — `_utils/styles.ts`

Deduplication algorithm. For each block, it adds border lines to a Map keyed by the line's coordinates. Adjacent blocks sharing an edge produce the same key — only the first is kept:

```typescript
export function canvasBorderLines(blocks: LayoutBlock[], scale: number) {
    const hMap = new Map<string, { x1: number; x2: number; y: number; w: number; c: string }>()
    const vMap = new Map<string, { y1: number; y2: number; x: number; w: number; c: string }>()

    for (const b of blocks) {
        if (b.hidden || b.type === 'image') continue
        const { x, y, width, height } = b
        const x2 = x + width, y2 = y + height
        const c = b.style?.borderColor ?? '#000'
        const s = b.style ?? {}

        // Key format: "x1,x2,y" for horizontal, "x,y1,y2" for vertical
        // Shared edges between adjacent blocks produce identical keys → deduplicated
        if (s.borderTop)    { const k = `${x},${x2},${y}`;  if (!hMap.has(k)) hMap.set(k, { x1:x, x2, y,  w: s.borderTop    ?? 1, c }) }
        if (s.borderBottom) { const k = `${x},${x2},${y2}`; if (!hMap.has(k)) hMap.set(k, { x1:x, x2, y:y2, w: s.borderBottom ?? 1, c }) }
        if (s.borderLeft)   { const k = `${x},${y},${y2}`;  if (!vMap.has(k)) vMap.set(k, { y1:y, y2, x,  w: s.borderLeft   ?? 1, c }) }
        if (s.borderRight)  { const k = `${x2},${y},${y2}`; if (!vMap.has(k)) vMap.set(k, { y1:y, y2, x:x2, w: s.borderRight  ?? 1, c }) }
    }

    const px = (mm: number) => mmToPx(mm) * scale
    return {
        hLines: [...hMap.values()].map(l => ({ x1: px(l.x1), x2: px(l.x2), y: px(l.y), w: l.w, c: l.c })),
        vLines: [...vMap.values()].map(l => ({ y1: px(l.y1), y2: px(l.y2), x: px(l.x), w: l.w, c: l.c })),
    }
}
```

#### `blockCanvasStyle(b)` — `_utils/styles.ts`

```typescript
// NO border CSS properties — borders handled by SVG overlay
export function blockCanvasStyle(b: LayoutBlock): React.CSSProperties {
    const s = b.style
    return {
        backgroundColor: (s.bgColor && s.bgColor !== 'transparent') ? s.bgColor : undefined,
        borderRadius:     s.borderRadius ? `${s.borderRadius}px` : undefined,
        color:      s.fontColor  ?? '#111111',
        fontSize:   `${s.fontSize ?? 9}pt`,
        // ...font, padding, flex alignment...
        // NO borderLeft / borderRight / borderTop / borderBottom
    }
}
```

### Column Alignment in Structural Blocks (Table)

Header row (`th`) and data rows (`td`) have **completely independent** alignment controls:

- `block.props.thColStyles[colKey].textAlign` — alignment for the header cell of that column
- `block.props.tdColStyles[colKey].textAlign` — alignment for the data cells of that column

**Editor Canvas (`StructuralBlockCanvas.tsx`):**
```typescript
// Header cells
<th style={{ textAlign: colStyles[col.key]?.textAlign ?? thSS.textAlign ?? 'left' }}>

// Data cells — ONLY applied to td, NOT to th
<td style={{ textAlign: tdColStyles[col.key]?.textAlign ?? tdSS.textAlign ?? 'left' }}>
```

**Preview (`preview/page.tsx`):**
```typescript
const thColStylesPv = (block.props?.thColStyles ?? block.props?.colStyles ?? {}) as ColStyleMap
const tdColStylesPv = (block.props?.tdColStyles ?? block.props?.colStyles ?? {}) as ColStyleMap

// Header:
<th style={{ textAlign: thColStylesPv[col.key]?.textAlign ?? thSS.textAlign ?? 'left' }}>
// Data cells:
<td style={{ textAlign: tdColStylesPv[col.key]?.textAlign ?? tdSS.textAlign ?? 'left' }}>
```

> **Bug history (fixed Mar 2026):** The old code used a single `colStyles` for both header and data rows. Alignment changes to a data column incorrectly also changed the header column and vice versa. Fixed by separating `thColStyles` from `tdColStyles`.

### Column-Specific Font Size Overrides

The font size for individual columns can now be explicitly set independently from the global `td` or `th` style:
- `block.props.thColStyles[colKey].fontSize`
- `block.props.tdColStyles[colKey].fontSize`

If omitted, the engine falls back to the row's base font size (`tdSS.fontSize`), which in turn falls back to the block's base font size (`tdColStyles[col.key]?.fontSize ?? tdSS.fontSize ?? 8`).

### Dynamic Row Heights & Text Wrapping

Line item table rows (`td`) use `minHeight` instead of a fixed `height`. This ensures that cells with significant text wrapping (like the `description` column, which is explicitly set to `whiteSpace: 'normal'`) can expand the row height vertically without getting cut off at the bottom.

### Image Scaling

If a product line item does not have a real thumbnail image, the renderer defaults to `/ecopowertech-logo.png`. To prevent the logo from appearing aggressively large, the engine applies a visual shrink: `transform: scale(0.7)` if the image source matches the fallback logo path, and dynamically fades the opacity to `0.65`.

---

Shown in the right panel when a sub-element (th or td) is selected within a structural block.

```typescript
// isColumnRole: true for both 'th' and 'td' (header AND data cells can have per-column overrides)
const isColumnRole = role === 'th' || role === 'td'

// Per-column override section only shows when a column cell is selected
// Label differs: "Override: header column" vs "Override: data column"
```

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

Applied at: drag, resize, arrow key nudge, property panel changes, init load, multi-select resize.

### Arrow Key Nudging

```typescript
const step = e.shiftKey ? 1 : 0.1   // mm
// ArrowLeft/Right → dx, ArrowUp/Down → dy
setBlocks(prev => prev.map(b =>
    selectedIds.has(b.id)
        ? clampBlock({ ...b, x: parseFloat((b.x + dx).toFixed(1)), y: parseFloat((b.y + dy).toFixed(1)) })
        : b
))
```

Works on ALL selected blocks including locked structural blocks.

### Ctrl+Scroll Zoom

Implemented as a **native `document` event listener** (NOT React synthetic events) to call `e.preventDefault()`:

```typescript
useEffect(() => {
    const handler = (e: WheelEvent) => {
        if (!e.ctrlKey || !canvasRef.current?.contains(e.target as Node)) return
        e.preventDefault()
        setScale(s => Math.min(4.0, Math.max(0.25, parseFloat((s + (e.deltaY < 0 ? 0.1 : -0.1)).toFixed(2)))))
    }
    document.addEventListener('wheel', handler, { passive: false })
    return () => document.removeEventListener('wheel', handler)
}, [])
```

### `DimInput` — Math Expression Input

Position and size fields accept arithmetic expressions:

```typescript
// User can type: "22 + 6" → 28, "100 - 15.5" → 84.5
function DimInput({ value, onChange, min }) {
    const commit = () => {
        try {
            const result = Function(`'use strict'; return (${raw})`)()
            if (isFinite(result) && result >= (min ?? 0)) onChange(parseFloat(result.toFixed(1)))
        } catch { setRaw(String(value)) }
    }
    return <input value={raw} onChange={e => setRaw(e.target.value)} onBlur={commit} onKeyDown={e => e.key === 'Enter' && commit()} />
}
```

### Resize Handles

Blocks can be resized via **8 handles**: 4 corners + 4 edge midpoints.

```typescript
// Resize directions:
type ResizeDir = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

// Each handle is a small div positioned around the block's selection outline
// CSS cursors: nw-resize, n-resize, ne-resize, e-resize, etc.

// During resize, dx/dy are applied to x/y/width/height depending on direction:
// 'n' handle  → adjusts y and height (push top edge up/down)
// 's' handle  → adjusts height only  (push bottom edge)
// 'e' handle  → adjusts width only   (push right edge)
// 'w' handle  → adjusts x and width  (push left edge)
// Corners     → adjust both axes simultaneously
```

All resize mutations go through `clampBlock()`.

### Block Groups

Blocks can be grouped via the toolbar button. Grouped blocks:
- Are selected together when any member is clicked
- Move together when dragged
- Can be ungrouped via the toolbar
- **Ctrl+Drag** pulls a single block out of a group (breaks it individually)

```typescript
const dragIds = selectedIds.has(blockId)
    ? [...selectedIds]
    : b.groupId
        ? blocks.filter(x => x.groupId === b.groupId).map(x => x.id)
        : [blockId]
```

### Guide Lines

User-added horizontal and vertical snap guides:
- Stored in `layout_guides` (persisted alongside `layout_data` on save)
- Rendered as colored lines over the canvas via `GuidelinesOverlay`
- Blocks snap to guides during drag (`snapToGuides()` helper)
- Guides are draggable; a position input field accepts a mm value

### `handleSave()` — Save with Field Config Sync

When blocks for a field are **all hidden**, the save handler automatically disables that field's `print` toggle:

```typescript
// Metadata fields:
if (fk.startsWith('meta_')) {
    const mfIdx = fc.metadata_fields.findIndex(m => m.key === fk.slice(5))
    if (mfIdx >= 0 && fc.metadata_fields[mfIdx].print !== false) {
        fc.metadata_fields[mfIdx] = { ...fc.metadata_fields[mfIdx], print: false }
        changed = true
    }
}
```

Save payload always includes `layout_guides`:
```typescript
const payload: any = { layout_data: blocks, layout_guides: guides }
if (changed) payload.field_config = fc
```

### Migration — Old Layout Format Handling

```typescript
// 1. Strip old monolithic header block
migrated = migrated.filter(b => !(b.id === 'header' && b.type === 'structural'))

// 2. Migrate old dual store_name blocks → single brand block (store_name_brand)
if (hasOldTitle && !hasNewBrand) { /* rebuild as single store_name_brand block */ }

// 3. Inject missing store_* blocks (logo, brand, name, address) from fresh layout
for (const sb of generateDefaultLayout(fc).filter(b => ['store_logo','store_brand','store_name','store_address'].includes(b.fieldKey ?? '')))
    if (!migrated.some(b => b.fieldKey === sb.fieldKey)) migrated = [sb, ...migrated]

// 4. Migrate old fieldKey-less blocks by ID pattern
migrated = migrated.map(b => {
    if (!b.fieldKey) {
        if (b.id?.includes('thank_you')) return { ...b, fieldKey: 'thank_you' }
        if (b.id?.includes('doc_name'))  return { ...b, fieldKey: 'doc_name' }
    }
    return b
})

// 5. Auto-inject ALL enabled fields missing from the saved layout (covers metadata!)
const allEnabledFields = extractPrintFields(fc)
for (const pf of allEnabledFields) { /* ... see Auto-Injection section above ... */ }

// 6. Migrate old cust_* blocks → customer_detail block
if (oldStyle && !hasCustomerDetail) { /* rebuild customer_detail_title + customer_detail_data */ }
```

### Sample Data in Canvas Editor (`StructuralBlockCanvas.tsx`)

The editor shows realistic sample data in the `table` block:

```typescript
const SAMPLE_ROWS = [
    { img: '🔆', sku: 'ECO-SP-400',  item: 'ECO-SP-400',  description: 'Solar Panel 400W Monocrystalline', quantity: 4,    unit_price: 64.00,  total: 256.00 },
    { img: '🔋', sku: 'ECO-BAT-10K', item: 'ECO-BAT-10K', description: 'Battery Storage 10kWh LiFePO4',    quantity: 1000, unit_price: 2.00,   total: 2000.00 },
]

// Column key → SAMPLE_ROWS key mapping:
const VAL = (row, colKey) => {
    if (colKey === 'qty' || colKey === 'quantity') return row.quantity
    if (colKey === 'price' || colKey === 'unit_price') return row.unit_price
    if (colKey === 'amount' || colKey === 'total') return row.total
    return row[colKey] ?? 'sample'
}
```

---

## Step 3 — Preview (`preview/page.tsx`)

### Layout Validation

Before rendering, checks for missing print fields:

```typescript
const missingFields = allPrintFields.filter(field =>
    !visibleBlocks.some(b => b.fieldKey === field.key)
)
// If any missing → error panel with field list + link back to layout
```

### Block Rendering Order

**Critical:** the `BordersSVG` component must be rendered **AFTER** all block `<div>` elements to paint on top of `backgroundColor`:

```typescript
{visibleBlocks.map(block => (
    <div key={block.id} style={blockCSS(block)}> {/* block content */} </div>
))}
<BordersSVG blocks={visibleBlocks} />  {/* ← ALWAYS LAST inside the page container */}
```

The `BordersSVG` SVG element itself has `zIndex: 2` to ensure it floats above block backgrounds.

### `blockCSS(b)` — Preview Block Styles

```typescript
function blockCSS(b: LayoutBlock): React.CSSProperties {
    return {
        position: 'absolute',
        left:   mmToPx(b.x),   // NOTE: no scale multiplication — transform is on parent
        top:    mmToPx(b.y),
        width:  mmToPx(b.width),
        height: mmToPx(b.height),
        overflow: 'hidden',
        backgroundColor: s.bgColor && s.bgColor !== 'transparent' ? s.bgColor : undefined,
        borderRadius:    s.borderRadius ? `${s.borderRadius}px` : undefined,
        color:           s.fontColor ?? '#111111',
        // ...font, padding, textAlign...
        // NO CSS border properties — handled by BordersSVG overlay
    }
}
```

### Dummy Data Map

```typescript
const liveDummy = {
    ...DUMMY,
    store_name:    { title: 'Company', data: storeInfo.name },    // ← live from useStoreInfo()
    store_address: { title: 'Address', data: storeInfo.address }, // ← live
    store_logo:    { title: 'Logo',    data: storeInfo.logoUrl }, // ← live
}
```

### Sample Line Items (Preview Only)

```typescript
const LINE_ITEMS = [
    { sku: 'ECO-SP-400',  desc: 'Solar Panel 400W Monocrystalline',         qty: 4, price: 350.00 },
    { sku: 'ECO-BAT-10K', desc: 'Battery Storage System 10kWh LiFePO4',    qty: 1, price: 2200.00 },
    { sku: 'ECO-INV-5K',  desc: 'Hybrid Inverter 5kW w/ Grid Tie',          qty: 1, price: 890.00 },
    { sku: 'INST-FULL',   desc: 'Full System Installation & Commissioning', qty: 1, price: 1200.00 },
]
```

Column data for different `col.key` values:
```typescript
// In preview, col.key can be: 'img', 'sku', 'item', 'description', 'qty', 'quantity', 'price', 'unit_price', 'amount', 'total'
const data = col.key === 'img'            ? <img src={row.img} />
           : col.key === 'qty'   || col.key === 'quantity'   ? row.qty
           : col.key === 'price' || col.key === 'unit_price' ? `$${row.price.toFixed(2)}`
           : col.key === 'amount'|| col.key === 'total'      ? `$${(row.qty * row.price).toFixed(2)}`
           : row[col.key] ?? ''
```

### Navigation

| Button | Destination |
|--------|-------------|
| `← Back to Designer` | `router.push('/templates/[id]/design')` |
| `Print Test` | `window.print()` |
| `Save & Set as Default` | PATCH `is_default: true` → redirect to `/templates` |
| `Already Default` | Disabled button (already the default template) |

---

## Template Gallery (`templates/page.tsx`)

- 3 sections: Estimates / Sales Orders / Invoices
- Each template card shows: name, default badge, thumbnail (if set)
- **Context menu** (3-dot) per card: Edit Fields, Edit Layout, Rename (inline), Duplicate, Delete
- Delete requires typing `DELETE` in a confirmation input
- Inline rename with Save/Cancel (Enter to save, Escape to cancel)
- Fixed-position dropdown using `getBoundingClientRect()` for viewport-relative positioning
- Admin-only guard: `isPosStaff` users → redirected to `/dashboard`

### Create Template Flow

```typescript
const template = await createTemplate({ name: 'My New Estimate', doc_type: 'estimate' })
router.push(`/templates/${template.id}/edit`)
```

---

## `TemplatePicker` Component

```typescript
<TemplatePicker
    docType="estimate"
    onSelect={(template) => applyTemplateToDocument(template)}
/>
```

---

## 4. POS Interface Integration (Estimates Page)

The `/estimates/[id]` details page natively bridges the template engine to the operational flow:

### Contextual Printing & PDF
When the user clicks the **Print** or **PDF** actions on an estimate, the app uses the `TemplatePicker` to allow the user to select the desired layout (which defaults to the `is_default` template).

The user is then seamlessly redirected to `/print/[templateId]?id=[estimateId]` which uses the exact same `BlockRenderer` logic as the layout preview but injects the **real, live data** fetched from Medusa, bypassing the dummy data module.

### Send Estimate Modal (Email Integration)
The `SendEstimateModal.tsx` handles generating and attaching a PDF of the configured template directly into an email targeting the customer.

1. **CC Support**: The modal supports adding a CC email address. The default CC email is automatically pre-filled utilizing the `"cc_email"` metadata field from the `customer` object linked to the order. 
2. **Payload**: The backend route `/admin/draft-orders/[id]/send-estimate` receives the template request, generates the PDF server-side using the identical rendering logic, attaches it to a SendGrid email template, and dispatches it immediately to the primary and CC recipients.

---

## Building a New Template Renderer from Scratch

### 1. Load Data

```typescript
const { templates } = useDocumentTemplates()
const template = templates.find(t => t.id === id)
const fc     = template.field_config ?? {}
const blocks = (template.layout_data ?? []) as LayoutBlock[]
```

### 2. Filter Visible Blocks

```typescript
const visibleBlocks = blocks.filter(b => !b.hidden && 'fieldKey' in b)
```

### 3. Validate Missing Print Fields

```typescript
const allPrint = extractPrintFields(fc)
const missing  = allPrint.filter(f => !visibleBlocks.some(b => b.fieldKey === f.key))
if (missing.length > 0) { /* show error */ }
```

### 4. Render Block Container

```html
<!-- Outer div at true mm size, parent applies CSS scale transform for zoom -->
<div style="position: relative; width: {PAGE_W_MM * MM_TO_PX}px; height: {PAGE_H_MM * MM_TO_PX}px; background: white;">
    <!-- All block divs first -->
    <!-- Then <BordersSVG> last, with zIndex: 2 -->
</div>
```

### 5. Apply Block Style

```typescript
const s = block.style
const css: React.CSSProperties = {
    position:   'absolute',
    left:       mmToPx(block.x),
    top:        mmToPx(block.y),
    width:      mmToPx(block.width),
    height:     mmToPx(block.height),
    overflow:   'hidden',
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
    borderRadius: s.borderRadius ? `${s.borderRadius}px` : undefined,
    // ⚠️ NO CSS border properties! Use the SVG overlay instead.
}
```

### 6. Render Borders via SVG (after all block divs)

```typescript
// Embed the deduplication logic from canvasBorderLines() or BordersSVG()
// SVG must be: position absolute, inset 0, zIndex >= 2, pointerEvents none
```

### 7. Block Type Dispatch

```typescript
if (block.type === 'structural' && block.id === 'table')   → render <table> with line items
if (block.type === 'structural' && block.id === 'summary') → render subtotal / tax / total rows
if (block.type === 'image')                                → render <img src={storeLogoUrl} />
if (block.subType === 'title')                             → render bold uppercase label
if (block.type === 'customer_detail')                      → render multi-line customer fields
if (block.subType === 'data')                              → render data value from dummy/live data
if (block.type === 'text')                                 → render block.props.richText (sanitized HTML)
if (block.type === 'divider')                              → render <hr />
if (block.type === 'spacer')                               → render empty div
```

---

## FieldKey → FieldConfig Mapping Reference

| `fieldKey` (block) | `field_config` key | Block shape | Notes |
|--------------------|-------------------|-------------|-------|
| `store_logo` | `show_logo` | Single image block | `type: 'image'` |
| `store_brand` | `show_store_brand` | Single data block | Company name logo text |
| `store_name` | `show_name` | Single data block (`store_name_brand`) | NOT a T+D pair |
| `store_address` | `show_address` | T+D pair | |
| `doc_name` | `show_document_name` | Single data block | e.g. "ESTIMATE" |
| `doc_date` | `show_date` | T+D pair | |
| `doc_number` | `show_order_number` | T+D pair | |
| `customer_detail` | `customer_fields.*` | title + `customer_detail` data block | All customer subfields |
| `shipping_addr` | `show_customer_shipping` | T+D pair | |
| `billing_addr` | `show_customer_billing` | T+D pair | |
| `freight` | `show_shipping` | T+D pair | |
| `promotions` | `show_promotions` | T+D pair | |
| `notes` | `show_notes` | T+D pair | |
| `policy` | `show_policy` | T+D pair | Has `.text` property |
| `thank_you` | `show_thank_you` | Single data block | Has `.text` property |
| `meta_{key}` | `metadata_fields[].key` | T+D pair | Dynamic from system-defaults |

---

## Common Gotchas

### 1. `extractPrintFields` is the Single Source of Truth
Both `design/page.tsx` (via `_utils/fields.ts`) and `preview/page.tsx` (`BordersSVG` + `blockCSS`) must use the exact same field-inclusion logic. Adding a new field type? Update `extractPrintFields` in `_utils/fields.ts`. The preview has its own inline `BordersSVG` but reads from the same `LayoutBlock[]`.

### 2. Metadata Fields: `screen || print` for UI, `print` for PDF
`extractPrintFields` includes metadata where `screen || print` (palette display). The PDF renderer and preview must separately check `mf.print` before rendering a metadata field in the actual document.

### 3. `store_name` is 1 Block, Most Others are 2
`store_logo`, `store_name`, `store_brand`, `doc_name`, `thank_you` → single block. Everything else → title + data pair. Exception: `customer_detail` → title + `customer_detail` typed data block.

### 4. Block `hidden` ≠ `field_config.print = false`
`hidden` = block exists on canvas but invisible. `field_config.print = false` = field is completely excluded from the print fields list. They only sync on **Save** in the Layout editor.

### 5. Locked ≠ Immovable
`locked: true` only prevents deletion. Drag, resize, arrow keys, and the Properties panel still work on locked blocks.

### 6. `clampBlock` Shrinks Dimensions, Not Position
If `x + width > PAGE_W_MM`, the width is shrunk to fit. The block is never pushed off-screen — only shrunk. Width/height minimum is 1mm.

### 7. Borders Must Use the SVG Overlay
Adding CSS border properties to block divs will cause double-borders at shared edges and diagonal-cut artifacts at corners. Always use the SVG overlay. Block `bgColor` also covers CSS border lines — another reason to use SVG.

### 8. `thColStyles` vs `tdColStyles` — Must Stay Separate
Always read `block.props.thColStyles` for header alignment and `block.props.tdColStyles` for data alignment. DO NOT write to a shared `colStyles` key. If you encounter old layouts using `colStyles`, fall back to it as the default but always write to the separate keys.

### 9. Metadata `fieldKey` has `meta_` Prefix
In `LayoutBlock.fieldKey`, metadata fields use `meta_${mf.key}` (e.g. `meta_customer_po`). When doing lookups in `field_config.metadata_fields`, strip the `meta_` prefix first: `fieldKey.slice(5)`.

### 10. New Metadata Fields Auto-Appear in Layout
When a user enables a metadata field in Step 1 and saves, opening the Layout editor (Step 2) will automatically place title+data blocks for any metadata field not yet on the canvas. This is handled in the init `useEffect` — no manual step needed.

---

## Quick Code Snippets

### Check if a block is a store-info block
```typescript
const isStoreBlock = ['store_logo', 'store_name', 'store_address', 'store_brand'].includes(block.fieldKey ?? '')
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

### Get metadata key from fieldKey
```typescript
const metaKey = block.fieldKey?.startsWith('meta_') ? block.fieldKey.slice(5) : null
const mf = fc.metadata_fields?.find(m => m.key === metaKey)
```

### Check if a metadata field is print-enabled (for the PDF renderer)
```typescript
const mf = fc.metadata_fields?.find(m => `meta_${m.key}` === block.fieldKey)
if (!mf?.print) return null  // don't render in PDF
```

### Deduplicate border lines for a custom SVG renderer
```typescript
// Use the same Map-key pattern as canvasBorderLines():
// hMap key: `${x1},${x2},${y}`   (sorted left-right)
// vMap key: `${x},${y1},${y2}`   (sorted top-bottom)
// Only set if key doesn't already exist
if (!hMap.has(k)) hMap.set(k, lineDescriptor)
```

---

## Changelog

| Date | Change |
|------|--------|
| Mar 2026 | **Estimates Email Integration** — Added full support for generating PDFs from layouts and sending them via the Send Estimate modal, including auto-prefilling CC addresses from customer metadata. |
| Mar 2026 | **Column Customizations** — Description column now enforces exactly 100% total row width via an auto-adjustment algorithm. Column drag resizing snaps precisely to 0.01%. |
| Mar 2026 | **Text Wrapping & Height** — Data rows (`td`) switch to `minHeight` instead of rigid `height` constraints, allowing heavily-wrapped product descriptions to expand the row cleanly without cutoff. |
| Mar 2026 | **Font Size Overrides** — Added per-column font-size overrides for `tdColStyles` and `thColStyles`. |
| Mar 2026 | **Store Information Fields** — Added `show_store_phone` and `show_store_email` to step 1, which auto-prefix their outputs with `"Phone: "` and `"Email: "`. |
| Mar 2026 | **No-Image Fallback Shrink** — The default `/ecopowertech-logo.png` fallback product thumbnail is dynamically scaled down by 30% (`transform: scale(0.7)`) to reduce visual noise. |
| Mar 2026 | **SVG border overlay** — replaced CSS borders with deduped SVG lines in both editor canvas and preview. Eliminates double-borders, corner artifacts, and disappearing borders at zoom |
| Mar 2026 | **Block background color fix** — `BordersSVG` moved to render after all block divs in preview; added `zIndex: 2` to SVG to prevent block `backgroundColor` from covering border lines |
| Mar 2026 | **Independent column alignment** — `thColStyles` and `tdColStyles` separated; header and data row alignment now independently controlled |
| Mar 2026 | **Display/Print checkbox fix** — Removed `onAnyChange` in `edit/page.tsx` that was force-enabling `screen` when any checkbox fired; new metadata entries now default the unclicked checkbox to `false` |
| Mar 2026 | **Metadata field auto-injection** — `extractPrintFields` changed from `mf.print` to `mf.screen \|\| mf.print`; Design page init now auto-creates blocks for all enabled fields missing from saved layout |
| Mar 2026 | **FieldsPalette auto-create** — Eye icon click on a field with no canvas blocks now generates and adds default title+data blocks instead of doing nothing |
| Mar 2026 | **8-direction block resize** — Added N/S/E/W edge handles in addition to corner handles |
| Mar 2026 | **Sample data improvements** — `SAMPLE_ROWS` in `StructuralBlockCanvas` updated with realistic qty and unit_price values; column key aliases (`qty`↔`quantity`, `price`↔`unit_price`) handled in data lookup |

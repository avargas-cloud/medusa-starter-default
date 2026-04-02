# System Defaults & Note Presets API
> **Type**: Technical Reference
> **Repo**: backend
> **Last verified**: 2026-04-02
> **Status**: Current

---

## What they are and why they exist

Two admin API endpoints manage configurable dropdown options and reusable text snippets for the POS:

1. **`/admin/system-defaults`** — a key-value configuration store for dropdown options used throughout the POS (payment terms, lead times, order types, payment methods, etc.)
2. **`/admin/note-presets`** — a library of reusable text blocks that staff can insert into estimate notes (store policies, scope of work, installation notes, etc.)

Both use raw PostgreSQL via the `pg` client (not Medusa modules) because they manage their own tables with auto-migration on startup — no Medusa migration system needed.

---

## System Defaults (`/admin/system-defaults`)

### Table: `system_defaults`

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `context` | TEXT | Category grouping (e.g., `"Document Defaults"`, `"Payment Methods"`) |
| `field_name` | TEXT | Field identifier (e.g., `"Payment Terms"`, `"Lead Time"`) |
| `value` | TEXT | The dropdown value |
| `sort_order` | INT | Display order within group |
| `data_scope` | TEXT | Where this default is used: `"orders"`, `"customers,orders"`, or `"pos"` |
| `metadata` | JSONB | Optional metadata (used extensively for Payment Methods) |

Unique constraint: `(context, field_name, value)`

### Contexts and Their Fields

| Context | Fields |
|---------|--------|
| `Document Defaults` | Payment Terms, Tax Code, Order Type, Lead Time, Customer PO, Project Name |
| `Templates Footer` | Draft Order (Estimates) — default footer text for estimate printouts |
| `Payment Methods` | Payment Method — all available POS payment methods with display metadata |

### Payment Methods Metadata Structure

The `Payment Methods` context entries use `metadata` (JSONB) to store display and integration info:

```json
{
  "display": "Visa",
  "icon": "💳",
  "ledger_method": "card",
  "qb_method": "Visa"
}
```

| Field | Purpose |
|-------|---------|
| `display` | Human-readable name shown in POS |
| `icon` | Emoji shown in POS payment picker |
| `ledger_method` | Finance ledger category: `cash`, `card`, `check`, `ach`, `zelle`, `other`, `credit_memo` |
| `qb_method` | QuickBooks payment method name (`null` if not sent to QB) |

### Seeded Payment Methods

`cash`, `visa`, `mastercard`, `discover`, `amex`, `capital_one`, `debit_card`, `check`, `checking_account`, `money_order`, `paypal`, `zelle`, `e_check`, `transfer`, `wire_transfer`, `credit_memo`

### Auto-migration Behavior

The table and all migrations run on every `GET` or `POST` call to `/admin/system-defaults`. This includes:
- Column additions (`data_scope`, `metadata`)
- Context renaming (`Customer Defaults` / `Order Defaults` → `Document Defaults`)
- Field renaming (`Terms` → `Payment Terms`, `Estimate Status` → `Order Status`)
- Idempotent seed inserts (`ON CONFLICT DO NOTHING`)

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/system-defaults` | All defaults, ordered by context/field/sort_order |
| POST | `/admin/system-defaults` | Create a new default value |
| DELETE | `/admin/system-defaults/:id` | Delete a specific default |
| PUT | `/admin/system-defaults/:id` | Update a specific default |

### `/admin/estimate-options`

A **read-only convenience endpoint** that queries `system_defaults` and returns structured data for the POS estimate/order header dropdowns:

```json
{
  "payment_terms": ["Due on Receipt", "Net-30", ...],
  "lead_times": ["Immediate", "1-2 Business Days", ...],
  "order_types": ["Standard Order", "Store Pickup", "Project"],
  "sales_reps": [{ "id": "...", "name": "...", "is_sales_rep": true }]
}
```

Sales reps are stored as `field_name: "Sales Rep User"`, `context: "Global"`, with a JSON `value` field containing user data.

---

## Note Presets (`/admin/note-presets`)

### Table: `note_presets`

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `group_name` | TEXT | Category (e.g., `"Store Policy"`, `"Installation"`, `"Projects"`) |
| `title` | TEXT | Short label for the preset |
| `content` | TEXT | Full text of the note |
| `sort_order` | INT | Display order within group |

### Seeded Preset Groups

| Group | Titles |
|-------|--------|
| Store Policy | Payment Terms, Lead Time, Validity, Warranty, Scope Note |
| Scope of Work | Materials Only, Custom Fabrication, Partial Orders |
| Installation | No Service, Assembly – LED Panels, Assembly – Linear |
| Projects | Project Notes (comprehensive project terms) |

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/note-presets` | All presets, ordered by group/sort_order/title |
| POST | `/admin/note-presets` | Create a new preset |
| PATCH | `/admin/note-presets/:id` | Update a preset |
| DELETE | `/admin/note-presets/:id` | Delete a preset |

---

## Key Files

| Type | Full Path | Purpose |
|------|-----------|---------|
| System Defaults Route | `backend/src/api/admin/system-defaults/route.ts` | Full CRUD + auto-migration |
| Estimate Options Route | `backend/src/api/admin/estimate-options/route.ts` | Read-only dropdown data |
| Note Presets Route | `backend/src/api/admin/note-presets/route.ts` | Note library CRUD |

---

## Rules

- Both tables use **auto-migration on first access** — no separate migration runner needed
- Seed data uses `ON CONFLICT DO NOTHING` — user edits to seeded rows are preserved
- The `metadata` JSONB field on `system_defaults` is required for payment methods to function correctly in the ledger and QB integration
- `ledger_method` values must match the constants expected by the finance module: `cash`, `card`, `check`, `ach`, `zelle`, `other`, `credit_memo`

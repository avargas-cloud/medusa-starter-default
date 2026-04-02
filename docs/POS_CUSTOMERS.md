# POS Customers — Gestión de Clientes
> **Tipo**: Technical Reference
> **Repo**: backend
> **Última verificación**: 2026-04-02
> **Estado**: ✅ Current

---

## ¿Qué es y por qué existe?

El módulo de Customers permite al staff del POS buscar, crear y gestionar clientes B2B de EcoPowerTech. Integra MeiliSearch para búsqueda en tiempo real, QuickBooks para sync automático, y un historial consolidado de Estimates y Orders por cliente. Incluye ledger de créditos para clientes con balance a favor.

---

## Arquitectura

```
/customers (lista)
    └── MeiliSearch (índice: customers) — debounce 250ms
         └── searchCustomers() en lib/meilisearch.ts

/customers/[id] (detalle)
    ├── GET /admin/customers/:id
    ├── GET /admin/orders?customer_id=:id
    ├── GET /admin/draft-orders?customer_id=:id
    ├── GET /admin/customers/:id/addresses
    ├── GET /admin/customers/:id/credits   ← balance y ledger de crédito
    └── GET /admin/customers/balances      ← balances de múltiples clientes
```

---

## Modelo de Datos / Estructura

### Campos en MeiliSearch (índice: customers)

| Campo en Meili | Fuente en Medusa |
|----------------|-----------------|
| `customer_type` | `metadata.qb_customer_type` |
| `price_level` | Grupo "Wholesale" → `metadata.price_level` |
| `acquisition_channel` | `metadata.acquisition_channel` |
| `list_id` | `metadata.qb_list_id` (QuickBooks ListID) |
| `status` | `"Registered"` si `has_account`, sino `"Guest"` |

### Metadata Relevante en Customer

| Metadata key | Contenido |
|-------------|-----------|
| `qb_list_id` | QuickBooks Customer ListID |
| `qb_customer_type` | Tipo (Residential / Commercial / etc.) |
| `qb_price_level` | Price level en QB |
| `price_level` | Price level en Medusa (usado para POS) |
| `acquisition_channel` | Canal de adquisición |
| `alt_contact` | Nombre del contacto alterno |
| `alt_phone` | Teléfono del contacto alterno |
| `alt_email` | Email personal del contacto alterno |
| `cc_emails` | Emails adicionales para notificaciones (comma-separated) |
| `is_tax_exempt` | `'Yes'` si el cliente tiene exención fiscal |

### Tabla `customer_credit_ledger`

| Campo | Descripción |
|-------|-------------|
| `id` | UUID |
| `customer_id` | FK a Medusa customer |
| `amount` | Monto del movimiento (positivo) |
| `type` | `'credit'` (a favor) o `'debit'` (aplicado) |
| `reference_id` | ID de la orden/invoice relacionada |
| `reference_type` | Tipo de referencia |
| `note` | Nota del movimiento |
| `created_by` | Usuario que lo creó |
| `created_at` | Timestamp |

El balance se calcula como: `SUM(amount WHERE type='credit') - SUM(amount WHERE type='debit')`.

---

## Flujo de Implementación

### Layout de Detalle — 3 Filas (No-Scroll 1080p)

```
┌──────────────────────────────┬──────────────────────────────────┐
│  Fila 1 LEFT: Details         │  Fila 1 RIGHT: Addresses          │
│  CustomerDetailsCard         │  CustomerAddressesCard            │
│  - Nombre, Teléfono, Email   │  - Billing (editable)             │
│  - QB List ID, QB Type       │  - Shipping (editable)            │
│  - Status badge, Price Level │                                    │
├──────────────────────────────┴──────────────────────────────────┤
│  Fila 2: CustomerSystemDefaultsCard (full width)                  │
│  - Default Sales Rep / Payment Terms / Shipping / Tax Exempt     │
├──────────────────────────────────────────────────────────────────┤
│  Fila 3: CustomerActivity (full width, scroll interno)            │
│  - Historial: Estimates + Orders                                  │
│  - Tabs: All / Estimates / Orders / Open / Closed                │
└──────────────────────────────────────────────────────────────────┘
```

### CustomerActivity — Historial Consolidado

| Tab | Criterio |
|-----|---------|
| All | Todo (sin cancelados por default) |
| Estimates | Solo Draft Orders |
| Orders | Solo Orders confirmadas |
| Open | `not_fulfilled` o `partially_fulfilled` |
| Closed | `fulfilled` / `shipped` / `delivered` |

- Toggle **Show Cancelled** con badge de count
- Dropdown fecha: All time / This week / This month / This year / Last year / Rango custom
- Click en fila: navega a `/estimates/{id}` o `/orders/{id}`

---

## API / Interfaces

### Endpoints usados

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/admin/customers` | Lista con MeiliSearch como proxy |
| `POST` | `/admin/customers` | Crear cliente |
| `PATCH` | `/admin/customers/:id` | Actualizar datos del cliente |
| `PATCH` | `/admin/customers/:id/addresses/:addressId` | Actualizar dirección |
| `GET` | `/admin/customers/:id/credits` | Balance y ledger de créditos |
| `POST` | `/admin/customers/:id/credits` | Agregar entrada de crédito |
| `POST` | `/admin/customers/:id/credits/apply` | Aplicar crédito a una orden |
| `GET` | `/admin/customers/balances` | Balances de múltiples clientes |
| `GET` | `/admin/customers/rankings` | Ranking de clientes por volumen |
| `POST` | `/admin/customers/resync-meili` | Re-sync MeiliSearch |
| `GET` | `/admin/orders?customer_id=:id&limit=50` | Historial de órdenes |
| `GET` | `/admin/draft-orders?customer_id=:id&limit=50` | Historial de estimates |
| `GET` | `/admin/customer-groups` | Price levels disponibles (para modal de nuevo cliente) |

### Payload — Crear Cliente

```typescript
POST /admin/customers
{
    first_name: string | undefined,
    last_name: string | undefined,
    email: string,          // real o dummy: noemail-{timestamp}@ecopowertech.com
    phone: string | undefined,
    company_name: string | undefined,
    metadata: {
        qb_customer_type: string | null,
        price_level: string | null,
        qb_price_level: string | null,   // duplicado para QB compatibility
        acquisition_channel: string | null,
        alt_contact: string | null,
        alt_phone: string | null,
        alt_email: string | null,
        cc_emails: string | null,
    }
}
```

### Payload — Aplicar Crédito

```typescript
POST /admin/customers/:id/credits/apply
{
    order_id: string,   // orden a la que se aplica el crédito
    amount: number,     // monto a debitar del balance
    note?: string
}
→ { success, entry, new_balance, remaining_order_balance }
```

---

## Modal "Add New Customer" — Reglas de Validación

```
(First Name AND Last Name)  OR  Company Name — al menos uno de los dos grupos
```

- Email es **opcional** — si está vacío se genera: `noemail-{Date.now()}@ecopowertech.com`
- Teléfono es opcional pero recomendado para B2B
- Secciones: Identity (azul), Classification (índigo), Alt. Contact (ámbar)

---

## QuickBooks Sincronización

- Si un cliente no existe en QB, `ensureCustomerInQb()` del bridge lo crea automáticamente al enviar un Estimate/Order
- El bridge usa `qb_list_id` (no el email) para identificar al cliente — el dummy email no causa problemas en QB
- Re-sync manual: `Admin > Customers Advanced` → botón **Check Sync** o **Force Sync**

---

## Reglas Críticas

- `alt_email` ≠ `cc_emails`: `alt_email` es el contacto personal; `cc_emails` es la lista de destinatarios CC para notificaciones
- Después de editar una dirección: llamar `queryClient.invalidateQueries(['customer', id])` para cache fresco
- El transformer de MeiliSearch en `medusa-config.ts` inyecta campos custom (`customer_type`, `price_level`) a nivel raíz del documento — no son campos nativos de Medusa Customer
- El crédito se gestiona en la tabla `customer_credit_ledger` (no en Medusa finance nativo)

---

## Archivos Clave

| Tipo | Ruta Completa | Propósito |
|------|---------------|-----------|
| Config | `backend/medusa-config.ts` | Transformer MeiliSearch para customers |
| API (nativo) | `backend/src/api/admin/customers/` | CRUD customers |
| API (custom) | `backend/src/api/admin/customers/[id]/credits/route.ts` | Balance y ledger |
| API (custom) | `backend/src/api/admin/customers/[id]/credits/apply/route.ts` | Aplicar crédito |
| API (custom) | `backend/src/api/admin/customers/balances/route.ts` | Balances multi-cliente |
| API (custom) | `backend/src/api/admin/customers/rankings/route.ts` | Rankings por volumen |
| API (custom) | `backend/src/api/admin/customers/resync-meili/route.ts` | Re-sync MeiliSearch |

---

## Historial de Decisiones

- **Dummy email automático** (2026-03-11): Medusa requiere email único. Los clientes B2B muchas veces no quieren compartir email. El dummy `noemail-{timestamp}@ecopowertech.com` sigue el patrón del script `quickbooks-customer-import.ts`.
- **MeiliSearch como fuente primaria en lista**: Latencia <50ms vs ~200ms de query Medusa. El índice `customers` se mantiene sincronizado via subscriber automático.
- **`customer_credit_ledger` separado de `finance`**: El ledger de créditos de clientes (depósitos anticipados, notas de crédito) opera en lógica diferente al finance ledger de pagos de facturas.

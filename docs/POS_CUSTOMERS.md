# POS_CUSTOMERS — Gestión de Clientes

| Campo | Detalle |
|-------|---------|
| **Módulo** | Customers |
| **Rutas POS** | `/customers`, `/customers/[id]` |
| **Medusa** | `GET/POST /admin/customers`, `GET /admin/customer-groups` |
| **Última revisión** | 2026-03-11 |

---

## Descripción General

El módulo de Customers permite al staff buscar, ver y gestionar clientes B2B de EcoPowerTech. Incluye:

- **Listado avanzado** con MeiliSearch para búsqueda en tiempo real
- **Vista de detalle** optimizada en 3 filas (no-scroll 1080p)
- **Modal "Add New Customer"** consistente en Customers, Estimates y Orders
- **Sincronización con QuickBooks** via metadata

---

## 1. Búsqueda de Clientes — Lista `/customers`

**Archivo:** `app/(pos)/customers/page.tsx`

Layout **No-Scroll 1080p** con `max-w-[1800px]` para que la tabla use todo el ancho disponible.

### 1.1 Fuente de Datos

- **MeiliSearch** — `searchCustomers()` en `lib/meilisearch.ts`
- Debounce: **250ms** desde última keystroke
- Index: `customers`

### 1.2 Transformer de MeiliSearch (backend `medusa-config.ts`)

El plugin Medusa-MeiliSearch inyecta a nivel raíz campos adicionales que no son nativos del objeto Customer:

| Campo en Meili | Fuente en Medusa |
|----------------|-----------------|
| `customer_type` | `metadata.qb_customer_type` → `metadata.customer_type` |
| `price_level` | grupo "Wholesale" → `metadata.price_level` |
| `acquisition_channel` | `metadata.acquisition_channel` |
| `list_id` | `metadata.qb_list_id` (QuickBooks ListID) |
| `status` | `"Registered"` si `has_account`, sino `"Guest"` |

**Configuración relevante en `medusa-config.ts`:**

```typescript
filterableAttributes: [
  "customer_type", "price_level", "has_account", "groups", "status"
],
displayedAttributes: [
  "id", "email", "first_name", "last_name", "company_name", "phone",
  "has_account", "groups", "metadata", "created_at", "updated_at",
  "customer_type", "price_level", "acquisition_channel", "list_id", "status"
]
```

### 1.3 Columnas de la Tabla (CSS Grid)

```
Name | Company | Email | Phone | Customer Type | Price Level | Acq. Channel | Status
```

### 1.4 Botón "Add Customer"

Abre `AddCustomerModal` (ver sección 3 — mismo modal compartido con Estimates y Orders).

---

## 2. Detalle de Cliente — `/customers/[id]`

**Archivo:** `app/(pos)/customers/[id]/page.tsx`

### 2.1 Layout de 3 Filas (No-Scroll 1080p)

```
┌──────────────────────────────┬──────────────────────────────────┐
│  FILA 1 (LEFT): Details       │  FILA 1 (RIGHT): Addresses        │
│  CustomerDetailsCard         │  CustomerAddressesCard            │
│  - Nombre, Teléfono, Email   │  - Billing Address (editable)     │
│  - QB List ID, QB Type       │  - Shipping Address (editable)    │
│  - Status badge, Price Level │                                    │
├──────────────────────────────┴──────────────────────────────────┤
│  FILA 2 (Full width): CustomerSystemDefaultsCard                 │
│  - Default Sales Rep                                             │
│  - Default Payment Terms                                         │
│  - Default Shipping Method                                       │
│  - Tax Exempt Status                                             │
├──────────────────────────────────────────────────────────────────┤
│  FILA 3 (Full width, scroll interno): CustomerActivity           │
│  - Historial de Estimates + Orders                               │
│  - Tabs: All / Estimates / Orders / Open / Closed                │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 CustomerActivity — Historial Consolidado

El componente combina Orders y Draft Orders del cliente:

```
GET /admin/orders?customer_id={id}&limit=50&fields=id,display_id,status,payment_status,total,created_at
GET /admin/draft-orders?customer_id={id}&limit=50&fields=id,display_id,status,total,created_at
```

**Tabs con contador dinámico:**

| Tab | Criterio |
|-----|---------|
| All | Todo (sin cancelados por default) |
| Estimates | Solo Draft Orders |
| Orders | Solo Orders confirmadas |
| Open | `not_fulfilled` o `partially_fulfilled` |
| Closed | `fulfilled` / `shipped` / `delivered` |

- Toggle **Show Cancelled** con badge de count
- Dropdown fecha: All time / This week / This month / This year / Last year / Rango customizado
- Columnas: `Type | # | Date | Items | Total | Status`
- Click en fila: navega a `/estimates/{id}` o `/orders/{id}`

### 2.3 Acciones Directas en Toolbar

| Botón | Acción |
|-------|--------|
| **New Order** | Redirige a `/orders/new?customerId=[id]` |
| **New Estimate** | Redirige a `/estimates/new?customerId=[id]` |

### 2.4 Edición de Direcciones (`CustomerAddressesCard`)

Cada dirección (Billing / Shipping) tiene su propio modal de edición con:
- Validación de estados de USA (select dropdown)
- `PATCH /admin/customers/{id}/addresses/{addressId}` para actualizar
- `queryClient.invalidateQueries(['customer', id])` para cache fresco sin reload

---

## 3. Modal "Add New Customer"

**Archivos:**
- `app/(pos)/customers/components/AddCustomerModal.tsx` — página `/customers`
- Modal equivalente embebido en los modales de selección de cliente en Estimates y Orders

El modal es **idéntico** en todas las páginas donde aparece.

### 3.1 Regla de Validación

```
(First Name AND Last Name)  OR  Company Name ← al menos uno de los dos grupos
```

```typescript
const hasFullName = form.first_name.trim() && form.last_name.trim()
const hasCompany = form.company_name.trim()
if (!hasFullName && !hasCompany) {
    toast.error('Provide a Company Name, or both First and Last Name.')
    return
}
```

- El **teléfono y email son opcionales** — no se bloquea el guardado si faltan
- El campo **Phone** es opcional pero recomendado para clientes B2B

### 3.2 Dummy Email Automático

Medusa requiere un email único para cada customer. Si el cliente no quiere compartir su email:

```typescript
const emailToSave = form.email.trim()
    || `noemail-${Date.now()}@ecopowertech.com`
```

- El hint se muestra automáticamente cuando el campo Email está vacío: *"A placeholder email will be generated automatically"*
- Sigue el mismo patrón del script `quickbooks-customer-import.ts` que ya existe en el backend

### 3.3 Secciones del Formulario

El modal está dividido en **3 secciones** separadas visualmente con bordes de color:

#### 🔵 Identity (borde accent)

| Campo | Tipo | Regla |
|-------|------|-------|
| First Name | text | Requerido si no hay Company |
| Last Name | text | Requerido si no hay Company |
| Email | email | Opcional — genera dummy si vacío |
| Phone | tel | Opcional |
| Company Name | text | Requerido si no hay First+Last Name |

#### 🟣 Classification (borde indigo, todos opcionales)

| Campo | Tipo | Valores |
|-------|------|---------|
| Customer Type | select | `CUSTOMER_TYPE_OPTIONS` — Residential / Commercial / etc. |
| Price Level | select | Dinámico desde `GET /admin/customer-groups` |
| Acquisition Channel | select | `ACQUISITION_CHANNEL_OPTIONS` |

#### 🟡 Alt. Contact & Notifications (borde ámbar, todos opcionales)

| Campo | Descripción | Se guarda en |
|-------|-------------|-------------|
| Alt. Contact Name | Nombre de persona de referencia alterna | `metadata.alt_contact` |
| Alt. Contact Phone | Teléfono de la persona alterna | `metadata.alt_phone` |
| Alt. Email | Email directo del contacto alterno (separado de CC) | `metadata.alt_email` |
| CC Emails | Emails adicionales CC'd en estimates e invoices (comma-separated) | `metadata.cc_emails` |

> ⚠️ **Alt. Email ≠ CC Emails**
> - `alt_email`: email personal del contacto de referencia (una persona específica)
> - `cc_emails`: lista de destinatarios CC para notificaciones masivas (accounting, manager, etc.)

### 3.4 Payload Enviado a Medusa

```typescript
POST /admin/customers
{
    first_name: form.first_name || undefined,
    last_name: form.last_name || undefined,
    email: emailToSave,   // real o dummy generado
    phone: form.phone || undefined,
    company_name: form.company_name || undefined,
    metadata: {
        qb_customer_type: form.qb_customer_type || null,
        price_level: form.price_level || null,
        qb_price_level: form.price_level || null,  // duplicado para QB compatibility
        acquisition_channel: form.acquisition_channel || null,
        alt_contact: form.alt_contact || null,
        alt_phone: form.alt_phone || null,
        alt_email: form.alt_email || null,
        cc_emails: form.cc_emails || null,
    }
}
```

Tras éxito: `queryClient.invalidateQueries({ queryKey: ['customers-ms'] })` + toast + `onClose()`.

---

## 4. QuickBooks Sincronización

### 4.1 Campos QB en Metadata

| Metadata key | Contenido |
|-------------|-----------|
| `qb_list_id` | QuickBooks Customer ListID |
| `qb_customer_type` | Tipo de cliente (Residential / Commercial) |
| `qb_price_level` | Precio level en QB |
| `is_tax_exempt` | `'Yes'` si el cliente tiene exención fiscal |

### 4.2 Auto-creación en QB

Si un cliente no existe en QB, la función `ensureCustomerInQb()` del bridge lo crea automáticamente al enviar un Estimate/Order. No requiere acción manual del staff.

### 4.3 Sincronización MeiliSearch

- Los clientes se indexan automáticamente via el subscriber de Medusa
- Para re-sync manual: página `Admin > Customers Advanced` → botón **Check Sync** o **Force Sync**
- Force Sync bypasea el smart check y re-indexa todos los customers aunque el count no haya cambiado

---

## 5. Estructura de Archivos

```
ecopowertech-store-pos/
├── app/(pos)/customers/
│   ├── page.tsx                           ← Lista (MeiliSearch + AddCustomerModal)
│   ├── components/
│   │   └── AddCustomerModal.tsx           ← Modal "Add New Customer" (standalone)
│   └── [id]/
│       ├── page.tsx                       ← Detalle (3-row no-scroll layout)
│       ├── addresses/
│       │   └── page.tsx                   ← Address book legacy (redirige a detail)
│       └── components/
│           ├── CustomerDetailsCard.tsx    ← Fila 1 izquierda
│           ├── CustomerAddressesCard.tsx  ← Fila 1 derecha
│           ├── CustomerDefaultsCard.tsx   ← Fila 2 (System Defaults)
│           ├── CustomerActivity.tsx       ← Fila 3 (historial + tabs)
│           └── shared.tsx                 ← Modal, FormField, FormSelect, CUSTOMER_TYPE_OPTIONS
```

---

## 6. Known Issues / Maintenance

| Issue | Solución / Prevención |
|-------|----------------------|
| **Columnas vacías en tabla** | Verificar transformer en `backend/medusa-config.ts` y re-sync MeiliSearch |
| **"Caché viejo al editar"** | Usar `queryClient.invalidateQueries(['customer', id])` tras cada mutación |
| **Customer sin email en QB** | No hay problema — el dummy email funciona. El bridge usa el `list_id` para identificar al cliente, no el email |
| **emails CC no enviados** | Los `cc_emails` están en metadata — el template de SendGrid debe leerlos explícitamente. Verificar `EMAIL_TEMPLATE_IMPROVEMENTS.md` |
| **Price Level no aparece** | Verificar que `customer-groups` tenga el grupo creado. La tabla carga los grupos de `GET /admin/customer-groups` al abrir el modal |

---

## Changelog

### 2026-03-11 — Modal "Add New Customer" Rediseñado

**Cambios implementados:**

1. **Validación actualizada:** `(First + Last Name) OR Company Name` — el email ya no es obligatorio
2. **Dummy email automático:** `noemail-{timestamp}@ecopowertech.com` cuando email está vacío
3. **Secciones visuales diferenciadas:** Identity (azul) / Classification (índigo) / Alt. Contact (ámbar)
4. **Alt. Contact persona:** campos `alt_contact`, `alt_phone`, `alt_email` para persona de referencia
5. **CC Emails separado de Alt. Email:** `cc_emails` (destinatarios broadcast) ≠ `alt_email` (persona específica)
6. **Hint contextual:** aparece cuando Email está vacío informando del dummy email
7. **Aplicado en:** `/customers` (AddCustomerModal), Estimates y Orders (modal embebido)

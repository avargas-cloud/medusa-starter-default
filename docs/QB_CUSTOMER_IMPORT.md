# QuickBooks Customer Import
> **Tipo**: Operational Guide
> **Repo**: backend
> **Ultima verificacion**: 2026-04-02
> **Estado**: Current

---

## Que es y por que existe

EcoPowerTech tenia una base de ~7,444 clientes en QuickBooks Desktop que necesitaba migrarse a Medusa v2 sin perder datos de empresa, email, telefono, nivel de precio o QB ListID. Esta guia documenta el flujo de importacion y como re-ejecutarlo limpiamente.

---

## Prerequisitos

- QB Bridge activo y accesible
- Backend Medusa corriendo
- Acceso a `backend/src/scripts/`

---

## Script de importacion

```
backend/src/scripts/import-customers-from-qb.ts
```

Ejecutar:
```bash
cd backend
yarn ts-node src/scripts/import-customers-from-qb.ts
```

---

## Flujo de Importacion

### 1. Exportar clientes desde QB

```
GET /qb/customers/export
```

Produce un JSON con todos los clientes de QB. Dataset tipico: ~7,444 clientes, ~7 MB.

### 2. Analizar calidad del dato

Distribucion esperada del dataset:
- Emails vacios: ~2,500 (34%)
- Emails con formato invalido: ~84 (1.1%)
- Emails multiples en un campo: ~70 (1%)
- Clientes con direccion: ~3,000 (40%)

### 3. Correccion de emails

**Correcciones automaticas** (el script las aplica):
- Espacios en email: `aabdemur@ aol.com` -> `aabdemur@aol.com`
- Falta `@`: `CWKITCHENARTCORP.COM` -> prefijo derivado del nombre + dominio
- Typos comunes: normalizacion de dominio

**Correcciones manuales:** El script genera un CSV de emails no corregibles para revision manual antes de importar.

### 4. Mapeo de campos QB -> Medusa

| Campo QB | Campo Medusa | Notas |
|----------|-------------|-------|
| `Name` | `company_name` | Si es company; si es persona: first/last |
| `Email` | `email` | Primer email si hay multiples |
| `Phone` | `phone` | Normalizado a E.164 si es posible |
| `BillAddress` | `addresses[0]` | Direccion de facturacion |
| `ShipAddress` | `addresses[1]` | Direccion de envio |
| `ListID` | `metadata.qb_list_id` | ID unico en QB -- critico para sync futuro |
| `PriceLevel` | `metadata.price_level` | Nivel de precio QB |
| `CustomerType` | `metadata.qb_customer_type` | Tipo de cliente QB |

### 5. Deduplicacion

El script detecta clientes ya importados por:
1. Email exacto existente en Medusa
2. `metadata.qb_list_id` existente

Si el cliente ya existe, se actualiza `qb_list_id` si falta, y se salta sin crear duplicado.

---

## Sincronizacion Continua (QB -> Medusa)

Despues de la importacion inicial, el sync continuo de clientes se hace via:

- **Scheduled:** `quickbooks-daily-sync` job (configurable en `/admin/quickbooks/config` con `customer_interval_minutes`)
- **Manual:** `POST /admin/quickbooks/sync/customers`
- **Reconciliar:** `POST /admin/quickbooks/sync/customers/reconcile`

El sync actualiza:
- Nombre / empresa
- Telefono
- `qb_list_id` en metadata

El sync NO borra clientes de Medusa que ya no esten en QB.

---

## QB ListID -- Campo Critico

El campo `metadata.qb_list_id` en el customer de Medusa es la unica forma de vincular un cliente Medusa con su contraparte en QB. Sin el, no se puede:
- Crear Sales Orders, Invoices o Payments para ese cliente en QB
- Actualizar el registro de cliente en QB (CustomerMod)

**Donde se usa:**
- Todos los handlers de orden QB leen `customer.metadata.qb_list_id`
- Si no existe, `ensureCustomerInQb()` crea el customer en QB y guarda el ListID

---

## Reconciliacion

```
POST /admin/quickbooks/sync/customers/reconcile
```

Verifica que todos los clientes de Medusa con `qb_list_id` existen en QB con los mismos datos. Reporta discrepancias.

---

## Archivos Clave

| Tipo | Ruta | Proposito |
|------|------|-----------|
| Script de importacion | `src/scripts/import-customers-from-qb.ts` | Importacion inicial |
| Core de sync | `src/lib/quickbooks/sync-customers-core.ts` | Logica de sync incremental |
| Core de chequeo | `src/lib/quickbooks/check-customers-core.ts` | Verificacion de consistencia |
| Core de reconciliacion | `src/lib/quickbooks/reconcile-customers-core.ts` | Reconciliacion |
| Customer build name | `src/lib/quickbooks/build-customer-name.ts` | Normaliza nombre QB |
| API sync | `src/api/admin/quickbooks/sync/customers/route.ts` | Endpoint de sync manual |
| API reconcile | `src/api/admin/quickbooks/sync/customers/reconcile/route.ts` | Endpoint de reconciliacion |
| API check | `src/api/admin/quickbooks/check/customers/route.ts` | Endpoint de verificacion |

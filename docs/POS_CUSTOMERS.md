# POS_CUSTOMERS — Gestión de Clientes

| Campo | Detalle |
|-------|---------|
| **Módulo** | Customers |
| **Rutas POS** | `/customers`, `/customers/[id]` |
| **Última revisión** | 2026-03-06 |

---

## Descripción

El módulo de Customers permite al staff buscar, ver y gestionar clientes de EcoPowerTech. Incluye historial de órdenes, credit balance, y sincronización con QuickBooks.

---

## Búsqueda de Clientes

La búsqueda usa **MeiliSearch** para resultados en tiempo real:

```typescript
// Index: customers
// Campos buscables: email, first_name, last_name, phone, company_name
// Filtros: has_account, metadata.qb_customer_id
```

---

## Lista de Clientes (`/customers`)

- Búsqueda por nombre, email, empresa, teléfono
- Indicador de cuenta activa vs. guest
- Indicador de QB Customer vinculado
- Columnas: Nombre, Email, Empresa, Teléfono, Balance Crédito, QB

---

## Detalle de Cliente (`/customers/[id]`)

### Tabs

| Tab | Descripción |
|-----|-------------|
| **Overview** | Info básica: nombre, email, empresa, dirección |
| **Orders** | Historial de órdenes del cliente |
| **Estimates** | Cotizaciones activas y pasadas |
| **Credit** | Balance de crédito + historial de movimientos |
| **QB** | Información del cliente en QuickBooks |

### Acciones

| Acción | Descripción |
|--------|-------------|
| **New Estimate** | Crear cotización para este cliente |
| **New Order** | Crear venta directa |
| **Receive Payment** | Abrir Capture Payment con este cliente pre-seleccionado |
| **Add Credit** | Registrar pago/crédito sin asignar a orden |
| **Sync to QB** | Sincronizar datos del cliente a QB |

---

## QuickBooks Customer

En QB, cada cliente tiene un `ListID` único. El POS guarda este ID en `metadata.qb_customer_id`.

```json
// Medusa Customer metadata:
{
  "qb_customer_id": "80000001-1234567890",
  "qb_customer_synced_at": "2026-03-06T..."
}
```

Si un cliente no existe en QB, `ensureCustomerInQb()` lo crea automáticamente al momento de crear un SR o SO.

---

## Credit Balance

Ver [POS_CAPTURE_PAYMENT.md](./POS_CAPTURE_PAYMENT.md) para la documentación del credit ledger.

```
GET /admin/customers/:id/credits    → balance actual + historial
```

### Historial en la UI

```
Date          Type      Amount    Note
2026-03-01    Credit    +$1,000   Check #4521
2026-03-03    Debit     -$500     Applied to Order #1089
2026-03-05    Debit     -$200     Applied to Order #1092
─────────────────────────────────────────────
                         $300     Available Balance
```

---

## Known Issues

| Issue | Fix |
|-------|-----|
| Cliente no aparece en búsqueda MeiliSearch | Re-indexar: `POST /admin/meilisearch/reindex` |
| Cliente QB duplicado | Verificar `qb_customer_id` en metadata antes de `ensureCustomerInQb()` |
| 404 en `/admin/customers/:id` | Cliente puede ser guest sin cuenta — usar endpoint con validación y 404 defense |

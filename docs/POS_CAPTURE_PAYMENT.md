# POS_CAPTURE_PAYMENT — Recibir Pagos

| Campo | Detalle |
|-------|---------|
| **Módulo** | Capture Payment / Receive Payment |
| **Ruta POS** | `/capture-payment` |
| **Componente modal** | `components/pos/CapturePaymentModal.tsx` (desde orders/estimates) |
| **Página standalone** | `app/(pos)/capture-payment/page.tsx` |
| **QB Doc** | Receive Payment |
| **Última revisión** | 2026-03-10 |

---

## Descripción

El módulo Capture Payment permite al staff recibir un pago de un cliente. Existe en dos modalidades:

| Modalidad | Dónde | Cómo se abre |
|---|---|---|
| **Modal inline** | Dentro de Orders o Estimates | Botón 💳 en el `DocumentToolbar` |
| **Página standalone** | `/capture-payment` | Sidebar nav |

---

## Modalidad 1 — CapturePaymentModal (inline en Orders/Estimates)

Abre un modal sobre la orden o estimate activo. El cliente y el total ya están pre-cargados.

### Flujo

```
[Order page] → click "Capture Payment" → CapturePaymentModal abre
  ↓  applyCredit (si aplica)
  POST /admin/customers/{id}/credits/apply
  ↓  grabar metadatos
  POST /admin/orders/{id}  { metadata: { pos_payment_method, ... } }
  ↓  success state inline (sin navegar)
```

### Props del Modal

| Prop | Tipo | Descripción |
|---|---|---|
| `open` | `boolean` | Visibilidad |
| `onClose` | `() => void` | Cierre/cancelación |
| `orderId` | `string` | UUID de la orden Medusa |
| `customerId` | `string \| null` | Para habilitar sección de crédito |
| `orderTotal` | `number` | Total en dólares |
| `orderDisplayId` | `number \| null` | Ej: `#1092` |
| `customerName` | `string \| undefined` | Contexto visual |
| `onSuccess` | `() => void` | Callback para invalidar queries |

---

## Modalidad 2 — Página Standalone `/capture-payment`

Usada cuando el cliente viene a pagar sin partir desde una orden específica. También soporta URL params para pre-cargar desde una orden/estimate.

### Layout (3 columnas, post-selección de cliente)

```
┌───────────────────┬──────────────────────────┬──────────────┐
│  LEFT  (~320px)   │  MIDDLE  (flex-1)         │  RIGHT(260px)│
│  Customer card    │  Open orders list         │  Balance(*)  │
│  Order total      │  (scrollable — el botón   │  Customer    │
│  Amount presets   │  de Capture nunca queda   │  Credit      │
│  Payment method   │  fuera del scroll)        │              │
│  Credit summary   │                           │              │
│  [Capture button] │                           │              │
└───────────────────┴──────────────────────────┴──────────────┘
(*) Balance placeholder — se conectará al AR en sprint futuro
```

### Step 1 — Customer Search (antes de seleccionar cliente)

- Input MeiliSearch debounced 300ms, activa desde ≥ 2 caracteres.
- Dropdown muestra: empresa, nombre, email.
- Al seleccionar → layout expande a 3 columnas.

### MIDDLE — Open Orders Picker

```
GET /admin/orders?customer_id={id}&limit=20
    &fields=id,display_id,status,payment_status,total,created_at
```

- Filtra solo órdenes activas (excluye: canceled, completed, captured, fulfilled).
- **Click** → selecciona orden, pre-carga amount al 100%.
- **Click en seleccionada** → deselecciona, vuelve a entrada manual.
- Sin órdenes → empty-state card preserva el ancho de columna.

### LEFT — Formulario de Pago

- **Order total card** — visible cuando hay orden seleccionada o URL param.
- **Amount presets** — 30% / 50% / 75% / Full — solo si `orderTotal > 0`. Custom input siempre disponible.
- **Payment method grid** — 9 opciones: Cash, Visa, Mastercard, Discover, Amex, Check, ACH/Wire, Zelle, Other.
- **Reference field** — placeholder contextual ("Last 4 digits", "Check #", etc.).
- **Mixed ledger** — visible cuando se combina crédito + pago adicional.
- **Capture button** — siempre visible al fondo de LEFT, independiente de cuántas órdenes haya en MIDDLE.

### RIGHT — Crédito del Cliente

| Tarjeta | Estado | Detalle |
|---|---|---|
| **Customer Balance** | Placeholder | Futuro: AR balance (cuentas por cobrar) |
| **Customer Credit** | Live | `GET /admin/customers/{id}/credits`, muestra balance disponible, apply max / custom amount |

### Persistencia F5-safe (sessionStorage)

| Key | Contenido |
|---|---|
| `cp_customer` | Objeto `SelectedCustomer` (JSON) |
| `cp_order_id` | UUID de la orden seleccionada |
| `cp_credit` | Amount de crédito a aplicar (string) |

Se limpian automáticamente al capturar exitosamente.

### URL Params (backward compat)

| Param | Efecto |
|---|---|
| `?orderId=…` | Salta búsqueda; auto-carga cliente + total desde la orden |
| `?estimateId=…` | Igual, desde un draft order |

En ambos casos la columna MIDDLE se oculta.

---

## Flujo de Captura (ambas modalidades)

```typescript
// 1. Aplicar crédito del cliente (si creditApplied > 0)
POST /admin/customers/{customerId}/credits/apply
  { order_id, amount: creditApplied, note: "..." }

// 2. Registrar pago en metadatos de la orden/draft
POST /admin/orders/{orderId}   |   /admin/draft-orders/{estimateId}
  { metadata: {
      pos_payment_method:    "visa",
      pos_payment_reference: "4242",
      pos_payment_amount:    96.45,
      pos_payment_pct:       75,
      pos_credit_applied:    50.00,
      pos_payment_date:      "2026-03-10T23:32:00Z"
  }}
```

---

## Credit Ledger

### Tabla: `customer_credit_ledger`

```sql
CREATE TABLE customer_credit_ledger (
    id              TEXT PRIMARY KEY DEFAULT 'cred_' || gen_random_uuid()::text,
    customer_id     TEXT          NOT NULL,
    amount          NUMERIC(12,2) NOT NULL,   -- siempre positivo
    type            TEXT          NOT NULL,   -- 'credit' | 'debit'
    reference_id    TEXT,                     -- order_id cuando type='debit'
    reference_type  TEXT,                     -- 'order' | 'payment' | 'adjustment' | 'refund'
    note            TEXT,
    created_by      TEXT,                     -- Medusa user ID
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Endpoints

```
GET    /admin/customers/:id/credits         Balance + historial completo
POST   /admin/customers/:id/credits         Agregar crédito (pago sin factura específica)
POST   /admin/customers/:id/credits/apply   Aplicar crédito a una orden específica
```

### Casos de Uso

| Situación | type | reference_type | amount |
|-----------|------|----------------|--------|
| Cheque $1,000 sin orden específica | `credit` | `payment` | 1000.00 |
| Se aplica $500 al Order #1089 | `debit` | `order` | 500.00 |
| Ajuste manual / corrección | `credit`/`debit` | `adjustment` | X |
| Reembolso que se convierte en crédito | `credit` | `refund` | X |

### Balance Query

```sql
SELECT SUM(CASE WHEN type = 'credit' THEN amount ELSE -amount END) AS balance
FROM customer_credit_ledger
WHERE customer_id = $1;
```

---

## GET `/admin/customers/:id/credits`

```json
{
  "customer_id": "cus_01ABC",
  "balance": 300.00,
  "entries": [
    { "id": "cred_...", "amount": 500.00, "type": "credit", "note": "Check #1234" },
    { "id": "cred_...", "amount": 200.00, "type": "debit",  "reference_id": "order_01XYZ" }
  ]
}
```

---

## Payment Methods Soportados

| ID | Label | Reference placeholder |
|---|---|---|
| `cash` | Cash | Reference (optional) |
| `visa` | Visa | Last 4 digits |
| `mastercard` | Mastercard | Last 4 digits |
| `discover` | Discover | Last 4 digits |
| `amex` | Amex | Last 4 digits |
| `check` | Check | Check # |
| `ach` | ACH / Wire | Wire / ACH reference |
| `zelle` | Zelle | Zelle confirmation # |
| `other` | Other | Reference (optional) |

---

## Known Issues

| Issue | Fix |
|-------|-----|
| `/credits/apply` no captura pago en Medusa | El endpoint solo registra el debit. Llamar `capture_payment` en Medusa por separado si se necesita |
| Balance negativo inesperado | Usar entrada `credit` con `reference_type: 'adjustment'` para corrección |
| Pago parcial no actualiza estado QB Invoice | Llamar `POST /admin/quickbooks/receive-payment` por cada pago aplicado |

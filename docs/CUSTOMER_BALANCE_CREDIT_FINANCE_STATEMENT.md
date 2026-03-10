# CUSTOMER_BALANCE_CREDIT_FINANCE_STATEMENT

| Campo | Detalle |
|-------|---------|
| **Módulo** | Customer Balance / Accounts Receivable / Credit Statements |
| **Keywords** | balance, credit, finance, statement, accounts receivable, AR, credit ledger, open balance, outstanding, payments |
| **Rutas backend** | `/admin/customers/:id/credits`, `/admin/customers/balances` |
| **Última revisión** | 2026-03-10 |

---

## Descripción

El sistema de balance de cliente funciona igual que QuickBooks:
- **Órdenes abiertas** = monto negativo (lo que el cliente debe)
- **Pagos recibidos** = monto positivo (lo que el cliente ha pagado o tiene en crédito)
- **Balance Neto** = Crédito disponible − Deuda de órdenes abiertas

Un balance **negativo** indica que el cliente **debe dinero** (AR outstanding).  
Un balance **positivo** indica que el cliente tiene **crédito en cuenta** (overpayment/prepago).

---

## Fórmula del Balance QB-Style

```
Net Balance = credit_ledger_balance − open_orders_outstanding

Donde:
  credit_ledger_balance = SUM(credits) - SUM(debits) FROM customer_credit_ledger
  open_orders_outstanding = SUM(original_order_total - paid_total)
                            FROM order_summary
                            WHERE order no está cancelado + no es draft
```

---

## Fuentes de Datos

### 1. Credit Ledger — `customer_credit_ledger`

```sql
CREATE TABLE customer_credit_ledger (
    id              TEXT PRIMARY KEY DEFAULT 'cred_' || gen_random_uuid()::text,
    customer_id     TEXT          NOT NULL,
    amount          NUMERIC(12,2) NOT NULL,   -- siempre positivo
    type            TEXT          NOT NULL,   -- 'credit' | 'debit'
    reference_id    TEXT,                     -- order_id cuando type='debit'
    reference_type  TEXT,                     -- 'order' | 'payment' | 'adjustment' | 'refund'
    note            TEXT,
    created_by      TEXT,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
```

| type | reference_type | Significado |
|------|----------------|-------------|
| `credit` | `payment` | Pago recibido sin orden específica |
| `debit` | `order` | Crédito aplicado a una orden |
| `credit` | `adjustment` | Corrección manual / ajuste |
| `credit` | `refund` | Reembolso convertido en crédito |

### 2. Órdenes Abiertas — `order_summary.totals` (JSONB)

Los totales de cada orden están en `order_summary.totals`:

```json
{
  "original_order_total": 1450.75,
  "paid_total": 0,
  "transaction_total": 0,
  "pending_difference": 1450.75,
  "refunded_total": 0
}
```

> ⚠️ Los valores están en **dólares (USD)**, no en centavos.  
> Medusa POS guarda los precios en centavos internamente, pero `order_summary.totals` normaliza a USD.

### 3. Pagos Capturados — `order_transaction`

Cuando un pago se captura (`/admin/payments/:paymentId/capture`), Medusa inserta un registro en `order_transaction` con `reference = 'capture'`.

```sql
-- Pagos capturados de un cliente
SELECT ot.amount
FROM order_transaction ot
JOIN "order" o ON o.id = ot.order_id
WHERE o.customer_id = $1
  AND ot.reference = 'capture'
  AND ot.deleted_at IS NULL
```

---

## Endpoints

### `GET /admin/customers/:id/credits`

Balance individual de un cliente + historial del ledger.

```json
{
  "customer_id": "cus_01ABC",
  "balance": 300.00,
  "entries": [
    { "id": "cred_...", "amount": 500.00, "type": "credit", "note": "Check #1234" },
    { "id": "cred_...", "amount": 200.00, "type": "debit", "reference_id": "order_01XYZ" }
  ]
}
```

### `POST /admin/customers/:id/credits`

Agregar crédito manual (pago sin orden específica).

```json
{ "amount": 500.00, "note": "Check #1234", "reference_type": "payment" }
```

### `POST /admin/customers/:id/credits/apply`

Aplicar crédito existente a una orden específica.

```json
{ "order_id": "order_01XYZ", "amount": 200.00 }
```

### `GET /admin/customers/balances?customer_ids=id1,id2,...`

Bulk balance QB-style para múltiples clientes en una sola query.

**Lógica:**
```sql
Net Balance = credit_ledger_balance - open_orders_outstanding
```

**Response:**
```json
{
  "balances": {
    "cus_01ABC": -150.75,   // cliente debe $150.75  
    "cus_02DEF":  300.00,   // cliente tiene crédito de $300
    "cus_03GHI":    0.00    // balance cero
  }
}
```

**Display en UI:**
| Valor | Color | Significado |
|-------|-------|-------------|
| `> 0` | 🟢 Verde | Tiene crédito en cuenta |
| `< 0` | 🔴 Rojo | Debe dinero (AR outstanding) |
| `= 0` | ─ Dash | Balance cero |

---

## Flujo de un Pago QB-Style

```
1. Cliente tiene Order #1089 por $1,200 (unpaid)
   → open_orders_outstanding = $1,200
   → Net Balance = $0 - $1,200 = -$1,200 (rojo)

2. Staff recibe cheque de $800
   POST /admin/customers/:id/credits  { amount: 800, note: "Check #555" }
   → credit_ledger_balance = $800
   → Net Balance = $800 - $1,200 = -$400 (aún rojo, debe $400)

3. Staff aplica crédito a la orden:
   POST /admin/customers/:id/credits/apply  { order_id: "order_01...", amount: 800 }
   → credit_ledger: debit $800 against order
   → Medusa: capture_payment $800 on the order
   → credit_ledger_balance = $0
   → open_orders_outstanding = $400 (still unpaid)
   → Net Balance = $0 - $400 = -$400 (rojo)

4. Cliente paga restante $400:
   → credit_ledger_balance += $400 → apply → $0
   → open_orders_outstanding = $0
   → Net Balance = $0 (cero)
```

---

## Queries de Referencia

### Balance Neto Individual
```sql
WITH credits AS (
    SELECT 
        COALESCE(SUM(CASE WHEN type='credit' THEN amount ELSE -amount END), 0) AS ledger_balance
    FROM customer_credit_ledger
    WHERE customer_id = $1
),
ar AS (
    SELECT
        COALESCE(SUM(
            (os.totals->>'original_order_total')::numeric -
            (os.totals->>'paid_total')::numeric
        ), 0) AS ar_outstanding
    FROM "order" o
    JOIN order_summary os ON os.order_id = o.id AND os.deleted_at IS NULL
    WHERE o.customer_id = $1
      AND o.deleted_at IS NULL
      AND o.status != 'canceled'
      AND o.is_draft_order = false
)
SELECT (credits.ledger_balance - ar.ar_outstanding) AS net_balance
FROM credits, ar;
```

### Balance Neto Bulk (múltiples clientes)
```sql
SELECT
    o.customer_id,
    COALESCE(SUM(
        (os.totals->>'original_order_total')::numeric -
        (os.totals->>'paid_total')::numeric
    ), 0) AS ar_outstanding
FROM "order" o
JOIN order_summary os ON os.order_id = o.id AND os.deleted_at IS NULL
WHERE o.customer_id = ANY($1)
  AND o.deleted_at IS NULL
  AND o.status != 'canceled'
  AND o.is_draft_order = false
GROUP BY o.customer_id
```

---

## Known Issues

| Issue | Solución |
|-------|----------|
| `order_summary.totals` puede estar desactualizado en ediciones de orden | Recalcular totales con `/admin/orders/:id` que fuerza un recalculo |
| `paid_total` no se actualiza si captura se hace fuera del flujo normal | Verificar `order_transaction` como fuente secundaria |
| Balance negativo inesperado | Usar entrada `credit` con `reference_type: 'adjustment'` para corrección manual |

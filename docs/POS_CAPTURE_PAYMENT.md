# POS_CAPTURE_PAYMENT — Recibir Pagos

| Campo | Detalle |
|-------|---------|
| **Módulo** | Capture Payment / Receive Payment |
| **Ruta POS** | `/capture-payment` |
| **QB Doc** | Receive Payment |
| **Última revisión** | 2026-03-06 |

---

## Descripción

El módulo Capture Payment permite al staff recibir un pago de un cliente y aplicarlo a una o más órdenes abiertas (on account). Soporta pagos parciales, múltiples facturas simultáneas, y créditos del cliente.

---

## Flujo Multi-Invoice

```
┌────────────────────────────────────────────┐
│ Receive Payment — Alejandro Vargas         │
│ Available credit: $300.00                  │
├────────────────────────────────────────────┤
│ Open Orders:                               │
│  ☑ Order #1089   $1,200.00  → Paying $1,000│
│  ☑ Order #1088     $850.00  → Paying  $850 │
│  ☐ Order #1087     $430.00                 │
├────────────────────────────────────────────┤
│ Payment Method:  [Credit Card ▾]           │
│ Amount Received: $1,850.00                 │
│ From Credit:     $  300.00                 │
├────────────────────────────────────────────┤
│ Total Applied:   $2,150.00                 │
│ Remaining:       $     0.00  → [Save as credit] │
└────────────────────────────────────────────┘
```

---

## API Sequence de Llamadas

```typescript
// 1. Para cada orden con monto de pago:
await fetch(`/admin/orders/${orderId}/payment-collections`, {
    method: 'POST',
    body: JSON.stringify({ amount: assignedAmount })
})
await fetch(`/admin/payments/${paymentId}/capture`, {
    method: 'POST',
    body: JSON.stringify({ amount: assignedAmount })
})

// 2. Registrar en QB:
await fetch('/admin/quickbooks/receive-payment', {
    method: 'POST',
    body: JSON.stringify({ orderId, amount: assignedAmount, paymentMethod })
})

// 3. Si hay crédito disponible del cliente → aplicar:
await fetch(`/admin/customers/${customerId}/credits/apply`, {
    method: 'POST',
    body: JSON.stringify({ order_id: orderId, amount: creditAmount })
})

// 4. Si sobra dinero → guardar como crédito:
await fetch(`/admin/customers/${customerId}/credits`, {
    method: 'POST',
    body: JSON.stringify({ amount: remainder, note: 'Overpayment — credit on account' })
})
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

### Endpoints Credit Ledger

```
GET    /admin/customers/:id/credits         Balance + historial completo
POST   /admin/customers/:id/credits         Agregar crédito (pago sin factura específica)
POST   /admin/customers/:id/credits/apply   Aplicar crédito a una orden específica
```

### Casos de Uso

| Situación | type | reference_type | amount |
|-----------|------|----------------|--------|
| Cheque $1,000 sin especificar orden | `credit` | `payment` | 1000.00 |
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
    { "id": "cred_...", "amount": 200.00, "type": "debit", "reference_id": "order_01XYZ" }
  ]
}
```

---

## Known Issues

| Issue | Fix |
|-------|-----|
| `/credits/apply` no captura pago en Medusa | El endpoint solo registra el debit. Llamar `capture_payment` en Medusa por separado |
| Balance negativo inesperado | Usar entrada `credit` con `reference_type: 'adjustment'` para corrección |
| Pago parcial no actualiza estado QB Invoice | Llamar `POST /admin/quickbooks/receive-payment` por cada pago aplicado |

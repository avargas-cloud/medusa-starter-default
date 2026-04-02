# Finance Payments -- Pagos, Transacciones y Captura
> **Tipo**: Technical Reference
> **Repo**: backend
> **Ultima verificacion**: 2026-04-02
> **Estado**: Current

---

## Que es y por que existe

El sistema de pagos de EcoPowerTech cubre dos canales completamente distintos:

- **Web (online):** El cliente paga con tarjeta via Authorize.Net. Medusa maneja el flujo nativo de payment collection. Los pagos se replican en `CustomerPayment` via subscriber.
- **POS (tienda):** Staff crea pagos manualmente (cash, check, ACH, Zelle, etc.). Los pagos se aplican a invoices de credito.

Ambos canales confluyen en el Finance Ledger (`CustomerPayment`) para un AR unificado por cliente.

---

## Flujos de Pago

### Flujo Web (Authorize.Net)

```
Cliente en checkout web
    |
POST /store/checkout-v2 (o /store/carts/:id/complete)
    |
Medusa PaymentCollection + Authorize.Net provider
    |
order.payment_captured event
    |
finance-payment-captured subscriber
    |
+-- CREATE CustomerPayment (source='web', locked_order_id, medusa_payment_synced=true)
+-- CREATE PaymentApplication (invoice_id=null, order_id)
+-- status='applied' inmediatamente
+-- EMIT QB sync si es order POS (via qb-order-subscriber)
```

El campo `locked_order_id` protege estos fondos -- no pueden aplicarse a otro invoice.

### Flujo POS -- Pago a Invoice

```
Staff recibe pago por invoice abierto
    |
POST /admin/finance/payments (o /admin/customer-payments)
    |
+-- CREATE CustomerPayment (source='pos', status='available' o 'applied')

Si se aplica inmediatamente al invoice:
POST /admin/finance/payments/:id/apply
    |
+-- CREATE PaymentApplication (invoice_id, amount_applied)
+-- UPDATE CustomerPayment.status
+-- UPDATE PosInvoice.amount_paid, balance_due, status
+-- EMIT 'pos.payment.applied' -> QB sync
```

### Flujo POS -- Deposito Flotante

```
Staff recibe deposito del cliente (sin asignar a invoice especifico)
    |
POST /admin/finance/payments
    |
+-- CREATE CustomerPayment (status='available')
-- Queda en pool disponible del cliente

Mas tarde, staff aplica:
POST /admin/finance/payments/:id/apply (body: { invoice_id })
    |
+-- CREATE PaymentApplication
+-- UPDATE status -> partially_applied / applied
```

### Flujo de Reembolso

```
Staff emite credit memo (devolucion)
    |
POST /admin/pos/credit_memos/:id/complete
    |
+-- CREATE CustomerPayment (type='credit_memo', status='refunded')
   -- Aparece en /admin/finance/qb-refunds/pending

Staff ejecuta Write Check en QB:
POST /admin/finance/qb-refunds/sync
    |
+-- CREATE pipeline row step='write_check'
+-- Bridge: POST /api/checks (Write Check en QB)
+-- Cuando confirmado: CustomerPayment.qb.status='yes'
+-- Activa refund_payment pipeline row
```

---

## Auto-Captura Web

El subscriber `auto-capture-web-payment.ts` captura automaticamente pagos de ordenes web que tienen autorizacion pero no captura manual. Esto evita autorizaciones que expiran.

---

## Metodos de Pago Soportados

### POS
| Metodo | Enum value | Notas |
|--------|-----------|-------|
| Efectivo | `cash` | |
| Cheque | `check` | `reference` = numero de cheque |
| Tarjeta (manual) | `card` | `reference` = last4 |
| ACH / Wire | `ach` | |
| Zelle | `zelle` | |
| Credito de cuenta | `credit_memo` | Aplicacion de un credit memo |
| Mixto | `mixed` | Multiple metodos en una sola transaccion |

### Web
| Proveedor | Enum value | Notas |
|-----------|-----------|-------|
| Authorize.Net | `authorize_net` | Proveedor principal |
| Stripe | `stripe` | Disponible pero no activo en produccion |

---

## Mapeo de Metodos en la API

El endpoint `POST /admin/customer-payments` acepta nombres de metodo mas amplios y los normaliza:

```
visa, mastercard, discover, amex, capital_one, debit_card -> 'card'
e_check, checking_account, transfer, wire_transfer -> 'ach'
paypal, money_order -> 'other'
credit -> 'credit_memo'
```

---

## Aplicacion de Pagos

### POST /admin/finance/payments/:id/apply

```json
{
    "invoice_id": "inv_...",
    "amount_applied": 50000,
    "order_id": "order_..."
}
```

- Valida que el pago no este `voided` o ya `applied` completamente
- Valida que `amount_applied <= available_balance`
- Si `amount_applied == remaining_balance`: status -> `applied`
- Si `amount_applied < remaining_balance`: status -> `partially_applied`

### Void de aplicacion

```
POST /admin/finance/applications/:id/void (body: { void_reason })
    |
+-- UPDATE PaymentApplication.voided_at, void_reason
+-- Recalcular CustomerPayment.status (puede volver a 'available' o 'partially_applied')
+-- Recalcular PosInvoice.amount_paid, balance_due, status
```

---

## Registro de Pagos en Medusa (registerMedusaPayment)

La funcion `registerMedusaPayment` en `src/api/admin/invoices/register-medusa-payment.ts` registra un pago POS en el modulo nativo de pagos de Medusa (PaymentCollection). Esto mantiene consistencia de datos entre el Finance module y Medusa core.

Se invoca automaticamente al crear un invoice con pago.

---

## QB Sync de Pagos

### pos.payment.created
Handler: `handlePosPaymentCreated`
- Recibe el CustomerPayment nuevo
- Crea un `ReceivePayment` en QB (credito sin aplicar) via bridge
- Escribe pipeline row step='payment'

### pos.payment.applied
Handler: `handlePosPaymentApplied`
- Busca el `qb_txn_id` del CustomerPayment (del pipeline confirmado)
- Aplica el payment al Invoice en QB via `POST /api/sync/enqueue` (receive-payment con invoiceId)
- Escribe pipeline row step='apply_payment'

### pos.payment.unapplied
Handler: `handlePosPaymentUnapplied`
- Revierte la aplicacion de pago en QB

### Sincronizacion asincrona

El `handlePosPaymentApplied` necesita el `qb_txn_id` del ReceivePayment en QB. Si el payment fue creado recientemente y el consolidator aun no lo confirmo, el handler espera (polling) hasta que el TxnID este disponible en `customer_payment.metadata.qb_txn_id`.

---

## Transacciones Especiales

### Sales Receipt (pago inmediato en POS)

Cuando se crea un invoice con pago inmediato (no a credito):
- En QB se crea un **Sales Receipt** (no Invoice + ReceivePayment)
- Handler: `handleSalesReceiptCreated`
- Pipeline step: `sales_receipt`

Esto es mas eficiente en QB porque un Sales Receipt combina invoice + pago en una sola transaccion.

### Write Check (reembolso a cliente)

Cuando se procesa un reembolso con impacto en QB:
- En QB se crea un **Write Check** (cheque de reembolso)
- Handler interno en el consolidator
- Pipeline step: `write_check`
- Despues de confirmado, se activa el `refund_payment` (ReceivePayment para cerrar el AR)

---

## API Routes

| Metodo | Path | Descripcion |
|--------|------|-------------|
| GET | `/admin/customer-payments` | Lista pagos (legacy) |
| POST | `/admin/customer-payments` | Crea pago |
| POST | `/admin/customer-payments/:id/apply` | Aplica pago a invoice |
| POST | `/admin/customer-payments/:id/refund` | Procesa reembolso |
| GET | `/admin/finance/payments` | Lista pagos (nuevo) |
| POST | `/admin/finance/payments` | Crea pago con secuencia + QB |
| GET | `/admin/finance/payments/:id` | Obtiene pago |
| POST | `/admin/finance/payments/:id/apply` | Aplica pago |
| POST | `/admin/finance/applications/:id/void` | Voidea aplicacion |
| GET | `/admin/finance/qb-refunds/pending` | Pending refunds para Write Check |
| POST | `/admin/finance/qb-refunds/sync` | Ejecuta Write Check en QB |
| POST | `/admin/finance/qb-refunds/:id/void` | Voidea reembolso |

---

## Archivos Clave

| Tipo | Ruta | Proposito |
|------|------|-----------|
| API customer-payments | `src/api/admin/customer-payments/` | Endpoints de pagos (legacy) |
| API finance/payments | `src/api/admin/finance/payments/` | Endpoints de pagos (nuevo) |
| API finance/applications | `src/api/admin/finance/applications/` | Void de aplicaciones |
| API qb-refunds | `src/api/admin/finance/qb-refunds/` | Reembolsos QB |
| Subscriber web | `src/subscribers/finance-payment-captured.ts` | Auto-crea CustomerPayment en web |
| Subscriber refund | `src/subscribers/finance-refund-created.ts` | Procesa refunds de web |
| Auto-captura | `src/subscribers/auto-capture-web-payment.ts` | Captura automatica |
| Handler payment | `src/lib/quickbooks/handlers/handle-pos-payment-created.ts` | QB ReceivePayment |
| Handler apply | `src/lib/quickbooks/handlers/handle-pos-payment-applied.ts` | QB apply payment |
| Handler unapply | `src/lib/quickbooks/handlers/handle-pos-payment-unapplied.ts` | QB unapply |
| Register Medusa | `src/api/admin/invoices/register-medusa-payment.ts` | Registro en Medusa PaymentModule |

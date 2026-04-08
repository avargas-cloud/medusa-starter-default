# Finance Payments -- Pagos, Transacciones y Captura
> **Tipo**: Technical Reference
> **Repo**: backend
> **Ultima verificacion**: 2026-04-08
> **Estado**: Current

---

## Que es y por que existe

El sistema de pagos de EcoPowerTech cubre tres canales:

- **Web (online):** El cliente paga con tarjeta via Authorize.Net. Medusa maneja el flujo nativo de payment collection. Los pagos se replican en `CustomerPayment` via subscriber.
- **POS (tienda):** Staff crea pagos manualmente (cash, check, ACH, Zelle, etc.) o captura via hardware (terminal Dejavoo P1) o envia link de pago al cliente.
- **BAMS / iPOS Pays:** Proveedor de pagos con tarjeta para el POS — dos modalidades: terminal fisico y link de pago remoto.

Los tres canales confluyen en el Finance Ledger (`CustomerPayment`) para un AR unificado por cliente.

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
| Metodo | Enum value | Captura | Notas |
|--------|-----------|---------|-------|
| Efectivo | `cash` | Manual | |
| Cheque | `check` | Manual | `reference` = numero de cheque |
| Tarjeta (manual) | `card` | Manual | `reference` = last4 |
| Tarjeta (terminal) | `card` | BAMS Terminal | Dejavoo P1 — ver seccion BAMS |
| Link de pago | `card` | BAMS Payment Link | Pago remoto online — ver seccion BAMS |
| ACH / Wire | `ach` | Manual | |
| Zelle | `zelle` | Manual | |
| Credito de cuenta | `credit_memo` | Automatico | Aplicacion de un credit memo |
| Mixto | `mixed` | Manual | Multiple metodos en una sola transaccion |

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

---

## BAMS / iPOS Pays — Integracion de Pagos con Tarjeta en POS

BAMS es el proveedor de pagos con tarjeta del POS. Expone dos modalidades de captura completamente distintas.

---

### Modalidad 1: Terminal Fisico (Dejavoo P1)

**Archivo POS:** `store-pos/app/api/bams/terminal/route.ts`
**API:** BAMS SPIn (Secure Payment Interface) — `https://spinpos.net/SPIn/cgi.html`
**TPN:** `BAMS_TERMINAL_TPN` (env var — TPN especifico del terminal P1)

#### Flujo completo

```
Staff selecciona "Terminal" como metodo de pago en POS
         |
Click "Send $X to Dejavoo Terminal"
  [componentes: CaptureDepositModal.tsx / PaymentSection.tsx]
         |
POST /api/bams/terminal { amountCents, referenceId, orderId, orderType, customerId }
         |
[Next.js API route — BLOQUEANTE hasta 3 minutos]
  buildSaleXml() → XML payload con TPN + AuthKey + amount
         |
POST https://spinpos.net/SPIn/cgi.html (body: "xml=<DataPacket>...")
  AbortSignal.timeout(180_000)
         |
[Terminal Dejavoo P1 muestra el monto — cliente toca/desliza tarjeta]
         |
Terminal responde con XML:
  Result: "Approved" | "Declined"
  TransactionID, CardType, Last4, AuthCode
         |
Si Declined → return { success: false, error: 'Payment declined' }
         |
Si Approved → registerPayment()
  1. getMedusaToken() (service account MEDUSA_WEBHOOK_EMAIL/PASSWORD)
  2. GET /admin/orders/{orderId} → obtiene customer_id, display_id, metadata
  3. POST /admin/finance/payments → crea CustomerPayment
       method: card (mapeado de cardType)
       reference: "VISA ···· 4242 | Auth: ABC123"
       notes: "In-store terminal payment via Dejavoo P1 — Ref: S-1337"
       metadata: { terminal_transaction_id, terminal_approval_code, ... }
  4. PATCH /admin/orders/{orderId} → actualiza metadata
       referential_deposit (acumulado)
       pos_payment_method, pos_payment_reference, pos_payment_amount
       pos_payment_date, terminal_transaction_id
  5. POST /api/pos/notes → escribe activity log (terminal_payment_captured)
         |
return { success: true, transactionId, cardType, last4, approvalCode, amountCents }
         |
[Frontend actualiza UI]
  setPaymentMethod, setAmountPaid, setNoPayment(false)
  invalidate queries: customer-balance, estimate, order, order-changes
  setCaptured(true) → pantalla de exito
```

#### Contextos de UI donde aparece el boton

| Componente | Contexto | Post-pago |
|-----------|---------|-----------|
| `CaptureDepositModal.tsx` | Captura deposito sobre un estimado/orden | Usuario luego crea invoice manualmente |
| `PaymentSection.tsx` (en `CompleteOrderModal`) | Ya dentro del flujo de creacion de invoice | Toast sugiere hacer click en "Create Invoice" |

#### Estado de Testing
> **PENDIENTE:** El boton fue implementado y la logica de registro en Medusa esta completa. Falta probar el request real al terminal Dejavoo P1 en la tienda fisica.

#### Pendientes de implementacion
> **TODO:** Tras la confirmacion del terminal, el boton debe auto-ejecutar "Create Invoice" seleccionando automaticamente el pago recien capturado, sin requerir click manual del staff.

---

### Modalidad 2: Link de Pago Remoto (iPOS Pays)

**Archivo POS:** `store-pos/app/api/bams/payment-link/route.ts`
**API:** iPOS Pays — `https://payment.ipospays.com/api/v1/external-payment-transaction`
**TPN:** `BAMS_TPN` (env var — TPN del link de pago, diferente al terminal)

#### Flujo completo

```
Staff abre BamsPaymentLinkModal desde un estimado
  → Ingresa monto + email del cliente
         |
POST /api/bams/payment-link { amount, customerEmail, customerName, referenceId, sendEmail }
         |
[Next.js API route]
  POST https://payment.ipospays.com/api/v1/external-payment-transaction
    body: { TPN, AuthToken, amount, referenceId, ... }
         |
iPOS Pays genera una URL de pago hosteada
  return { success: true, paymentUrl }
         |
Si sendEmail=true → Resend envia email al cliente con el link
         |
[Cliente recibe email / link — paga en su propio dispositivo]
         |
[ASINCRONO — cuando cliente completa el pago]
iPOS Pays hace POST al webhook configurado:
  POST /api/bams/webhook (URL publica del POS en Vercel)
    authHeader: BAMS_WEBHOOK_SECRET
         |
[Webhook handler — route.ts]
  Valida BAMS_WEBHOOK_SECRET
  Lee responseCode:
    200 → pago exitoso
    400 → fallido/rechazado
    401 → cancelado por cliente
    402 → rechazado por cliente
         |
  Si exitoso:
    1. getMedusaToken() (service account)
    2. Parsea referenceId "E-0042" → display_id=42
    3. GET /admin/orders?display_id=42 → encuentra la orden
    4. POST /admin/finance/payments → crea CustomerPayment
    5. PATCH /admin/orders/{id} → actualiza referential_deposit + metadata
    6. POST /api/pos/notes → activity log (online_payment_received)
```

#### Diferencias clave entre Terminal y Payment Link

| Aspecto | Terminal (Dejavoo P1) | Payment Link |
|---------|----------------------|--------------|
| TPN | `BAMS_TERMINAL_TPN` | `BAMS_TPN` |
| API URL | `spinpos.net/SPIn/cgi.html` | `ipospays.com/api/v1/...` |
| Blocking | Si (hasta 3 min) | No (async via webhook) |
| Confirmacion | Response inmediata del terminal | Webhook de iPOS Pays |
| Uso | Staff y cliente en tienda | Cliente remoto |
| Email | No aplica | Opcional via Resend |

---

### Variables de Entorno BAMS

| Variable | Alcance | Descripcion |
|----------|---------|-------------|
| `BAMS_TERMINAL_TPN` | POS server | TPN del terminal Dejavoo P1 |
| `BAMS_TERMINAL_AUTH_KEY` | POS server | Auth key del portal BAMS para ese TPN |
| `BAMS_TPN` | POS server | TPN del link de pago online |
| `BAMS_AUTH_TOKEN` | POS server | JWT del portal BAMS para link de pago |
| `BAMS_WEBHOOK_SECRET` | POS server | Secret para validar webhooks de iPOS Pays |
| `BAMS_TEMPLATE_ID` | POS server | ID de template de email de iPOS Pays |
| `MEDUSA_WEBHOOK_EMAIL` | POS server | Email de service account para registrar pagos |
| `MEDUSA_WEBHOOK_PASSWORD` | POS server | Password de service account |

---

### Archivos Clave BAMS

| Archivo | Proposito |
|---------|-----------|
| `store-pos/app/api/bams/terminal/route.ts` | SPIn API call + registro en Medusa (sincrono) |
| `store-pos/app/api/bams/payment-link/route.ts` | Genera link de pago iPOS Pays + envia email |
| `store-pos/app/api/bams/webhook/route.ts` | Recibe confirmacion de iPOS Pays (async) |
| `store-pos/components/pos/BamsPaymentLinkModal.tsx` | Modal para enviar link al cliente |
| `store-pos/components/pos/CaptureDepositModal.tsx` | Depositos + boton terminal |
| `store-pos/components/pos/complete-order/PaymentSection.tsx` | Seccion de pago en CompleteOrderModal |

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

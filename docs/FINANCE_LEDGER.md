# Finance Ledger -- Arquitectura
> **Tipo**: Technical Reference
> **Repo**: backend
> **Ultima verificacion**: 2026-04-02
> **Estado**: Current

---

## Que es y por que existe

El modulo **Finance** es el nucleo para gestionar el dinero de los clientes. Funciona como un **Libro Mayor Unificado (Single Ledger)**. Todo dinero que ingresa al sistema (web o POS) crea un registro en `CustomerPayment`. Esto permite cruzar creditos de web contra deudas de POS para el mismo cliente.

---

## Arquitectura

```
src/modules/finance/
+-- index.ts                          -- Registro del modulo (FINANCE_MODULE)
+-- service.ts                        -- FinanceModuleService (MedusaService)
+-- models/
|   +-- customer-payment.ts           -- Ledger entry principal
|   +-- payment-application.ts        -- Vinculo pago <-> factura
|   +-- qb-bank-account.ts            -- Cuentas bancarias QB para Write Check
+-- migrations/                       -- 9 migraciones hasta 2026-03-30
```

El servicio extiende `MedusaService` y expone CRUD estandar para los 3 modelos. La logica de negocio (numeros de secuencia, validaciones, QB sync) esta en las API routes.

---

## Modelos de Datos

### CustomerPayment

Representa cualquier movimiento de dinero asociado a un cliente.

```typescript
model.define('customer_payment', {
    id:                    model.id({ prefix: 'cpay' }).primaryKey(),
    display_id:            model.number().nullable(),   // identificador secuencial amigable
    customer_id:           model.text(),                // siempre requerido
    source:                model.enum(['web', 'pos']).default('pos'),
    type:                  model.enum(['payment', 'refund', 'credit_memo']).default('payment'),
    amount:                model.bigNumber(),           // en centavos (USD)
    currency:              model.text().default('usd'),
    method:                model.enum([
                               'cash', 'check', 'card', 'ach', 'zelle',
                               'credit_memo', 'stripe', 'authorize_net', 'other'
                           ]).default('other'),
    reference:             model.text().nullable(),     // check #, last4, charge ID, etc.
    status:                model.enum([
                               'available', 'partially_applied', 'applied',
                               'voided', 'refunded', 'partial_refunded'
                           ]).default('available'),
    medusa_payment_id:     model.text().nullable(),     // payment.id de Medusa
    medusa_refund_id:      model.text().nullable(),     // payment_refund.id si es refund mirror
    medusa_payment_synced: model.boolean().default(false), // true = registrado en Payment Module
    qb:                    model.json().nullable(),     // { status: 'yes'|'no'|'processing', check_txn_id? }
    locked_order_id:       model.text().nullable(),     // web: bloqueado a su orden
    received_at:           model.dateTime(),
    notes:                 model.text().nullable(),
    created_by:            model.text().nullable(),     // email del admin / "system"
    metadata:              model.json().nullable(),     // QB refs, contextos, etc.
    applications:          model.hasMany(() => PaymentApplication, { mappedBy: 'payment' }),
})
```

**Tipos por source:**
- `source='web'`: Creado por subscriber en `order.payment_captured`. Siempre tiene `locked_order_id`. `medusa_payment_synced=true` desde el inicio.
- `source='pos'`: Creado manualmente por staff. Puede quedar `available` (deposito flotante) o aplicarse inmediatamente a un invoice.

**Estados validos:**
- `available`: Dinero recibido, sin asignar. Solo POS payments pueden quedar aqui.
- `partially_applied`: Parte aplicada, remanente disponible.
- `applied`: Fondos agotados.
- `voided`: Cancelado antes de usarse.
- `refunded`: Monto total devuelto al cliente.
- `partial_refunded`: Devolucion parcial.

**Campo `qb`:**
```json
{ "status": "yes", "check_txn_id": "ABCD-1234" }
// status: 'yes' = Write Check procesado en QB
//         'no'  = pendiente de Write Check
//         'processing' = en proceso
```

### PaymentApplication

Documenta cuanto de un `CustomerPayment` se aplico a un `PosInvoice` especifico.

```typescript
model.define('payment_application', {
    id:             model.id({ prefix: 'papp' }).primaryKey(),
    payment:        model.belongsTo(() => CustomerPayment, { mappedBy: 'applications' }),
    invoice_id:     model.text().nullable(),   // null para web orders (no tienen PosInvoice)
    order_id:       model.text(),             // siempre set -- denormalizado para reportes AR
    amount_applied: model.bigNumber(),        // en centavos
    applied_at:     model.dateTime(),
    applied_by:     model.text().nullable(),
    voided_at:      model.dateTime().nullable(),
    void_reason:    model.text().nullable(),
    voided_by:      model.text().nullable(),
})
```

Una application voided devuelve `amount_applied` al balance disponible del `CustomerPayment`.

### QbBankAccount

Mapea cuentas bancarias de QuickBooks para el flujo de Write Check (reembolsos).

```typescript
model.define('qb_bank_account', {
    id:         model.id({ prefix: 'qbbank' }).primaryKey(),
    name:       model.text(),
    list_id:    model.text().unique(),  // QB ListID
    type:       model.enum(['Bank', 'CreditCard', 'OtherCurrentAsset']).default('Bank'),
    is_active:  model.boolean().default(true),
    is_default: model.boolean().default(false),
})
```

---

## Flujos de Trabajo

### Caso 1: Pago POS aplicado a un invoice

```
Staff recibe pago de $500
    |
POST /admin/customer-payments o /admin/finance/payments
    |
+-- CREATE CustomerPayment (amount=50000, status='available')
|
POST /admin/customer-payments/:id/apply o /admin/finance/payments/:id/apply
    |
+-- CREATE PaymentApplication (invoice_id, amount_applied=50000)
+-- UPDATE CustomerPayment.status -> 'applied'
+-- UPDATE PosInvoice.amount_paid, balance_due, status
+-- EMIT 'pos.payment.applied' -> QB sync (handlePosPaymentApplied)
```

### Caso 2: Deposito flotante (available balance)

```
Cliente deja cheque de $1,000 a cuenta
    |
POST /admin/customer-payments
    |
+-- CREATE CustomerPayment (status='available', source='pos')

Mas tarde, staff aplica a invoice:
    |
POST /admin/customer-payments/:id/apply
    |
+-- CREATE PaymentApplication
+-- UPDATE status -> 'partially_applied' o 'applied'
```

### Caso 3: Pago web (automatico)

```
Cliente compra en web con tarjeta
    |
order.payment_captured event
    |
finance-payment-captured subscriber
    |
+-- CREATE CustomerPayment (source='web', locked_order_id=order_id, medusa_payment_synced=true)
+-- CREATE PaymentApplication automatica (invoice_id=null, order_id)
+-- status='applied' inmediatamente
```

### Caso 4: Reembolso -> Write Check

```
Credit memo creado -> CustomerPayment.type='credit_memo', status='refunded'
    |
Aparece en /admin/finance/qb-refunds/pending
    |
Staff selecciona cuenta bancaria QB y ejecuta:
    |
POST /admin/finance/qb-refunds/sync (o similar)
    |
+-- WRITE pipeline row step='write_check'
+-- Bridge: POST /api/checks (Write Check en QB)
+-- Cuando confirmed: CustomerPayment.qb.status='yes'
+-- Activa refund_payment pipeline row
```

---

## Balance de Cliente

`GET /admin/finance/customers/:id/balance`

Calcula el balance neto del cliente:
```
balance = SUM(amount de CustomerPayment activos)
        - SUM(amount_applied de PaymentApplications activas)
```

Tambien incluye balance de PosInvoices abiertas (balance_due).

---

## API Routes

### /admin/customer-payments (legacy, sigue activa)

| Metodo | Path | Descripcion |
|--------|------|-------------|
| GET | `/admin/customer-payments` | Lista todos los pagos enriquecidos con customer info |
| POST | `/admin/customer-payments` | Crea pago standalone (status: available) |
| GET | `/admin/customer-payments/:id` | Obtiene pago especifico |
| POST | `/admin/customer-payments/:id/apply` | Aplica pago a invoice |
| POST | `/admin/customer-payments/:id/refund` | Procesa reembolso |

### /admin/finance/payments (nueva)

| Metodo | Path | Descripcion |
|--------|------|-------------|
| GET | `/admin/finance/payments` | Lista pagos (filtro por customer_id, status) |
| POST | `/admin/finance/payments` | Crea pago con numero secuencial + QB sync |
| GET | `/admin/finance/payments/:id` | Obtiene pago especifico |
| POST | `/admin/finance/payments/:id/apply` | Aplica pago |

### /admin/finance/applications

| Metodo | Path | Descripcion |
|--------|------|-------------|
| POST | `/admin/finance/applications/:id/void` | Voidea una aplicacion |

### /admin/finance/customers

| Metodo | Path | Descripcion |
|--------|------|-------------|
| GET | `/admin/finance/customers/:id/balance` | Balance neto del cliente |

### /admin/finance/qb-bank-accounts

| Metodo | Path | Descripcion |
|--------|------|-------------|
| GET | `/admin/finance/qb-bank-accounts` | Lista cuentas bancarias QB |
| POST | `/admin/finance/qb-bank-accounts` | Crea cuenta bancaria |
| GET | `/admin/finance/qb-bank-accounts/:id` | Obtiene cuenta |
| DELETE | `/admin/finance/qb-bank-accounts/:id` | Elimina cuenta |
| POST | `/admin/finance/qb-bank-accounts/sync` | Sincroniza cuentas desde QB |

### /admin/finance/qb-refunds

| Metodo | Path | Descripcion |
|--------|------|-------------|
| GET | `/admin/finance/qb-refunds/pending` | Pagos que necesitan Write Check |
| POST | `/admin/finance/qb-refunds/sync` | Procesa Write Check en QB |
| POST | `/admin/finance/qb-refunds/:id/void` | Voidea un reembolso |

### /admin/finance/sequences

| Metodo | Path | Descripcion |
|--------|------|-------------|
| GET | `/admin/finance/sequences` | Obtiene proximos numeros de secuencia |

---

## Archivos Clave

| Tipo | Ruta | Proposito |
|------|------|-----------|
| Modulo | `src/modules/finance/index.ts` | Registro (FINANCE_MODULE) |
| Service | `src/modules/finance/service.ts` | CRUD via MedusaService |
| CustomerPayment | `src/modules/finance/models/customer-payment.ts` | Modelo principal |
| PaymentApplication | `src/modules/finance/models/payment-application.ts` | Modelo de vinculo |
| QbBankAccount | `src/modules/finance/models/qb-bank-account.ts` | Cuentas bancarias QB |
| Subscriber web | `src/subscribers/finance-payment-captured.ts` | Crea CustomerPayment en web |
| Subscriber refund | `src/subscribers/finance-refund-created.ts` | Procesa refunds web |
| API customer-payments | `src/api/admin/customer-payments/` | Endpoints legacy |
| API finance | `src/api/admin/finance/` | Endpoints nuevos |

---

## Historial de Decisiones

- **Single Ledger:** Se eligio un ledger unificado en vez de dos sistemas separados (web/POS) porque los clientes B2B hacen compras en ambos canales y necesitan un estado de cuenta unico.
- **locked_order_id:** Los pagos web se bloquean a su orden para evitar que fondos de tarjeta de credito web se apliquen accidentalmente a facturas POS de otro periodo.
- **campo qb en CustomerPayment:** El campo `qb` es un JSONB que trackea el estado del Write Check en QB. Se uso un campo separado de `metadata` para diferenciarlo claramente de otros metadatos de contexto.
- **QbBankAccount como modelo:** Se modelo como entidad en vez de configuracion estativa para permitir multiple cuentas y cambio de cuenta por defecto sin deploy.

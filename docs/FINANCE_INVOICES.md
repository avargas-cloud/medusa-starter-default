# Finance Invoices -- Modulo POS Invoices
> **Tipo**: Technical Reference
> **Repo**: backend
> **Ultima verificacion**: 2026-04-15
> **Estado**: Current

---

## Que es y por que existe

El modulo `invoices` implementa la facturacion POS de EcoPowerTech. Cada invoice es un **snapshot inmutable** de los items despachados en un momento dado -- los cambios posteriores al order no modifican el invoice existente. Un order puede tener multiples invoices (uno por fulfillment).

**Las compras web NO generan PosInvoice** -- ese flujo usa el sistema nativo de Medusa.

---

## Arquitectura

```
src/modules/invoices/
+-- index.ts                          -- Registro (INVOICE_MODULE)
+-- service.ts                        -- InvoiceModuleService (MedusaService)
+-- models/
|   +-- pos-invoice.ts               -- Documento de factura
|   +-- pos-invoice-item.ts          -- Items snapshot
|   +-- invoice-payment.ts           -- Pagos directos del invoice (legacy)
|   +-- invoice-tracking.ts          -- Tracking de envio
+-- migrations/                       -- 7 migraciones hasta 2026-03-29
```

---

## Modelos de Datos

### PosInvoice

```typescript
model.define('pos_invoice', {
    id:               model.id().primaryKey(),
    invoice_number:   model.text(),            // INV-{order.display_id}-{seq}
    order_id:         model.text(),            // FK -> Medusa Order
    fulfillment_id:   model.text().nullable(), // FK -> Medusa Fulfillment
    customer_id:      model.text(),            // FK -> Medusa Customer
    status:           model.enum([
                          'draft', 'issued', 'partial', 'paid',
                          'voided', 'partially_refunded', 'refunded'
                      ]).default('issued'),
    subtotal:         model.bigNumber(),       // en centavos
    discount:         model.bigNumber().default(0),   // en centavos -- snapshot al momento de creacion
    shipping:         model.number().default(0),      // en centavos (numeric plano en DB)
    tax:              model.bigNumber(),
    untaxed_total:    model.bigNumber(),       // total - tax, pre-calculado para reportes
    total:            model.bigNumber(),
    amount_paid:      model.bigNumber(),
    balance_due:      model.bigNumber(),
    refunded_amount:  model.bigNumber().default(0),   // acumulado por credit memos (centavos)
    refunded_shipping: model.bigNumber().default(0),  // shipping refundido acumulado (centavos)
    payment_method:   model.enum(['cash', 'check', 'card', 'ach', 'credit', 'mixed']),
    issued_at:        model.dateTime().nullable(),
    paid_at:          model.dateTime().nullable(),
    voided_at:        model.dateTime().nullable(),
    void_reason:      model.text().nullable(),
    notes:            model.text().nullable(),
    created_by:       model.text().nullable(),
    shipping_address: model.json().nullable(), // snapshot de order.shipping_address en creacion
    metadata:         model.json().nullable(), // QB refs, etc.
    items:            model.hasMany(() => PosInvoiceItem, { mappedBy: 'invoice' }),
    tracking_links:   model.hasMany(() => InvoiceTracking, { mappedBy: 'invoice' }),
})
```

**Campo `discount`:** En centavos, snapshoteado en creacion. Para imprimir, usar `inv.discount / 100` -- **NO llamar `setDocument()` para print**.

**Campo `metadata`:** Contiene refs QB:
```json
{
    "qb_invoice_txn_id": "ABCD-1234",
    "qb_sync_status": "synced"
}
```

### PosInvoiceItem

Snapshot de los items al momento de despacho. Los cambios al order no afectan este snapshot.

```typescript
model.define('pos_invoice_item', {
    id:                model.id().primaryKey(),
    invoice:           model.belongsTo(() => PosInvoice, { mappedBy: 'items' }),
    variant_id:        model.text().nullable(),
    sku:               model.text().nullable(),
    description:       model.text(),
    quantity:          model.number(),
    refunded_quantity: model.number().default(0),  // acumulado por credit memos
    unit_price:        model.bigNumber(),           // en centavos
    total:             model.bigNumber(),           // en centavos
})
```

### InvoiceTracking

Informacion de tracking de envio. Al guardar un tracking, puede disparar email de notificacion.

```typescript
model.define('invoice_tracking', {
    id:              model.id().primaryKey(),
    invoice:         model.belongsTo(() => PosInvoice, { mappedBy: 'tracking_links' }),
    carrier:         model.text().nullable(),
    tracking_number: model.text(),
    tracking_url:    model.text().nullable(),
    shipped_at:      model.dateTime().nullable(),
    email_sent_at:   model.dateTime().nullable(),
})
```

### InvoicePayment (legacy)

```typescript
model.define('invoice_payment', {
    id:             model.id({ prefix: 'ipay' }).primaryKey(),
    invoice_id:     model.text(),
    amount:         model.bigNumber(),    // centavos
    payment_method: model.text(),
    paid_at:        model.dateTime().default(new Date()),
    notes:          model.text().nullable(),
    created_by:     model.text().nullable(),
})
```

---

## Ciclo de Vida del Invoice

```
draft      -- guardado pero no emitido
issued     -- emitido al cliente (status inicial al crear)
partial    -- pagado parcialmente
paid       -- pagado en su totalidad
voided     -- anulado (irreversible)
partially_refunded -- algun item devuelto via credit memo
refunded   -- devolucion total
```

---

## Flujos de Implementacion

### Creacion de Invoice (POST /admin/invoices)

```
Staff crea fulfillment en POS y asigna items
    |
POST /admin/invoices (body: order_id, items, subtotal, tax, total, payment_method, ...)
    |
+-- Generate invoice_number (INV-{order_display_id}-{seq})
+-- CREATE PosInvoice (status='issued')
+-- CREATE PosInvoiceItems (snapshot de items)
+-- Si payment_method != credit:
|   +-- CREATE CustomerPayment (source='pos', status='applied')
|   +-- CREATE PaymentApplication (invoice_id, amount_applied=total)
+-- skipSalesOrderPipelineRow(order_id)  -- SO ya no se necesita si hay invoice
+-- Direct-exec QB sync (bypass BullMQ):
    +-- Si pago inmediato: handleSalesReceiptCreated()
    +-- Si a credito: handleFulfillmentCreated()
    +-- Si pago POS: handlePosPaymentCreated()
    +-- Si pago aplicado: handlePosPaymentApplied()
```

### Void de Invoice (POST /admin/invoices/:id/void)

```
POST /admin/invoices/:id/void (body: void_reason)
    |
+-- Verificar que no esta ya voided
+-- SURGICAL FULFILLMENT REVERSAL:
|   +-- Fetch invoice items
|   +-- Fetch location del fulfillment
|   +-- Revertir inventario en QB/Medusa
+-- UPDATE PosInvoice.status = 'voided', voided_at = NOW()
+-- Void aplicaciones de pago (restore balance al CustomerPayment)
+-- Para pagos de tipo SR (Sales Receipt):
|   +-- ANTES: status = 'voided' (el dinero desaparecia)
|   +-- AHORA:  status = 'available' (el dinero queda como credito disponible)
|   +-- Limpia flags de metadata: elimina is_sales_receipt_payment, qb_source, qb_txn_id
|   +-- Setea qb_sync_status = 'pending'
|   +-- Actualiza reference al document_number del order (order.metadata.document_number)
|   +-- Dispara handlePosPaymentCreated() async (200ms delay, fire & forget)
|       para crear un nuevo ReceivePayment en QB con el monto liberado
+-- Recalcular order status
+-- EMIT 'pos.invoice.voided' -> QB sync (handleInvoiceVoided)
```

**Inventario:** El void hace una reversion quirurgica del fulfillment -- devuelve stock a la ubicacion original. Esto usa raw SQL para evitar un bug de Medusa con arrays vacios de DML.

**Pagos SR al void:** El monto del pago SR no se destruye -- se convierte en credito disponible (`status: 'available'`) en el `CustomerPayment`. Esto permite re-aplicarlo a un nuevo invoice sin re-cobrar al cliente.

### Correccion de Tax (POST /admin/invoices/:id/update-tax)

Solo disponible para invoices de tipo **QB Invoice** (pago a credito). Los Sales Receipt tienen el tax bloqueado.

```
POST /admin/invoices/:id/update-tax (body: { taxMode: 'florida' | 'exempt' })
    |
+-- Verificar que invoice no esta voided (400 si voided)
+-- Verificar que invoice es tipo QB Invoice, no Sales Receipt
|   +-- Si es Sales Receipt: 422 con code SALES_RECEIPT_TAX_LOCKED
+-- Recalcular impuestos:
|   +-- florida: newTax = Math.round(subtotal * 0.07)
|   +-- exempt:  newTax = 0
|   +-- newTotal = subtotal + shipping - discount + newTax
|   +-- newUntaxedTotal = newTotal - newTax
+-- UPDATE pos_invoice: total, tax, untaxed_total, balance_due, amount_paid, status
+-- Si el nuevo total es menor que el monto ya aplicado:
|   +-- Clampear payment_application.amount_applied al nuevo total
|   +-- Convertir el exceso en credito disponible en customer_payment
+-- Disparar updateInvoiceInQb() async -> QB Invoice MOD
    +-- QbSyncLogger: operation='invoice', eventType='invoice.tax_updated',
        triggeredBy='manual'
```

**Archivo:** `src/api/admin/invoices/[id]/update-tax/route.ts`

---

## API Routes

| Metodo | Path | Descripcion |
|--------|------|-------------|
| GET | `/admin/invoices` | Lista invoices (filtro por order_id, customer_id, status) |
| POST | `/admin/invoices` | Crea invoice + QB sync direct-exec |
| GET | `/admin/invoices/:id` | Obtiene invoice con items + tracking |
| POST | `/admin/invoices/:id/void` | Voidea invoice + reversion de inventario |
| POST | `/admin/invoices/:id/update-tax` | Corrige tax (florida/exempt) en QB Invoice; bloqueado en SR y voided |
| GET | `/admin/invoices/:id/payments` | Lista pagos del invoice |
| POST | `/admin/invoices/:id/tracking` | Agrega tracking de envio |

---

## Numeracion

El formato del numero de invoice es: `INV-{order.display_id}-{seq}` donde `seq` es un contador secuencial por orden (primer invoice es -1, segundo -2, etc.).

Los numeros de secuencia globales (PAY-XXXX, CM-XXXXX) se gestionan en `/admin/finance/sequences`.

---

## QB Sync

Al crear un invoice:
- Pago inmediato (cash/check/card) -> crea **Sales Receipt** en QB
- A credito -> crea **Invoice** en QB, luego **Receive Payment** cuando se aplique

Al void un invoice:
- Emite evento `pos.invoice.voided` -> `handleInvoiceVoided` -> void del documento QB correspondiente
- Si el invoice tenia un pago SR, ese pago se libera como credito disponible y se crea un nuevo ReceivePayment en QB via `handlePosPaymentCreated` (async, fire & forget)

Al corregir tax de un invoice QB Invoice:
- `updateInvoiceInQb()` async -> MOD del Invoice en QB Desktop
- Registrado en `QbSyncLogger` (operation=`invoice`, eventType=`invoice.tax_updated`, triggeredBy=`manual`)

---

## Archivos Clave

| Tipo | Ruta | Proposito |
|------|------|-----------|
| Modulo | `src/modules/invoices/index.ts` | Registro (INVOICE_MODULE) |
| Service | `src/modules/invoices/service.ts` | CRUD via MedusaService |
| PosInvoice model | `src/modules/invoices/models/pos-invoice.ts` | Modelo principal |
| PosInvoiceItem model | `src/modules/invoices/models/pos-invoice-item.ts` | Items snapshot |
| InvoiceTracking model | `src/modules/invoices/models/invoice-tracking.ts` | Tracking de envio |
| InvoicePayment model | `src/modules/invoices/models/invoice-payment.ts` | Pagos directos legacy |
| API list/create | `src/api/admin/invoices/route.ts` | GET + POST |
| API void | `src/api/admin/invoices/[id]/void/route.ts` | Void + inventario reversal |
| API update-tax | `src/api/admin/invoices/[id]/update-tax/route.ts` | Correccion de tax en QB Invoice |
| API payments | `src/api/admin/invoices/[id]/payments/route.ts` | Pagos del invoice |
| API tracking | `src/api/admin/invoices/[id]/tracking/route.ts` | Tracking de envio |
| Handler void | `src/lib/quickbooks/handlers/handle-invoice-voided.ts` | QB void |
| Handler fulfillment | `src/lib/quickbooks/handlers/handle-fulfillment-created.ts` | QB invoice |
| Handler sales receipt | `src/lib/quickbooks/handlers/handle-sales-receipt-created.ts` | QB sales receipt |

---

## Reglas Criticas

- **Invoices son read-only despues de emitidos.** No modificar items ni totales -- crear credit memo para ajustes. **Excepcion:** el tax puede corregirse en invoices de tipo QB Invoice via `POST /admin/invoices/:id/update-tax`.
- **Sales Receipt invoices tienen tax inmutable.** El endpoint `update-tax` devuelve 422 con `SALES_RECEIPT_TAX_LOCKED` si se intenta cambiar el tax de un SR invoice.
- **El campo `discount` es un snapshot en centavos.** Para imprimir: `inv.discount / 100`. No llamar `setDocument()` para print.
- **El void es irreversible.** Verificar con el usuario antes de ejecutar.
- **Pagos SR al void se liberan, no se destruyen.** El monto queda como `status: 'available'` en `CustomerPayment` para re-aplicarse a un nuevo invoice.
- **Direct-exec para QB sync.** El event bus puede perder eventos POS. El route invoca los handlers directamente.
- **Raw SQL para fetch de items en void.** Medusa ORM tiene un bug con arrays vacios en DML. El void usa `pool.query()` directamente.

---

## Historial de Decisiones

- **Snapshot inmutable:** Se eligio snapshot al momento de creacion para que el historial de facturas sea auditablemente correcto aunque el order cambie despues.
- **Direct-exec QB:** El outbox de BullMQ en Medusa v2 puede perder eventos bajo carga. Los handlers QB se invocan directamente desde el route para garantizar la sincronizacion.
- **Void quirurgico de inventario:** Se necesita revertir exactamente los items del invoice, no todos los items del order. Por eso se usan los `pos_invoice_item` como fuente de verdad para el reversal.

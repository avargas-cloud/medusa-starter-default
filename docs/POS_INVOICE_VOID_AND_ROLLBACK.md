# Guía Definitiva: Void Invoices & Surgical Rollback en el ecosistema POS de Medusa v2

**Last Updated:** 2026-03-29

Esta guía está redactada específicamente para desarrolladores que no tengan experiencia profunda en **Medusa v2**. Explica, paso por paso, cómo funciona el sistema de `VOID` (Anulación) de facturas en nuestro ecosistema de POS (Punto de Venta) y por qué se tuvieron que implementar patrones técnicos muy estrictos para resolver la desconexión logística y financiera que ocurre al intentar revertir órdenes.

---

## 1. El Problema Base (¿Por qué no usar el Void nativo?)

En el flujo regular del e-commerce moderno:
1. El cliente paga en línea (Order `pending`).
2. El personal empaqueta la orden (Order `fulfilled`).
3. El paquete se envía o se entrega (Order `delivered`).

Sin embargo, en el mostrador del **POS en la tienda física**, todos estos pasos ocurren de forma simultánea. Cuando el vendedor presiona el botón de **Complete Order**, el sistema automáticamente:
- Descuenta el dinero (Crea el `PaymentApplication` conectando un depósito con el Invoice).
- Remueve el stock físico del inventario.
- Fija las entidades maestras `order_item` en estado interno `fulfilled` y `delivered`.

Si existe un error de mostrador (se escaneó 1 ítem extra por accidente), **Medusa no tiene un botón mágico "Undo"**. Peor aún, las órdenes que ya pasaron al estado "Delivered" están herméticamente selladas contra modificaciones o cancelaciones estándar (para evitar corrupciones de envío logístico).

Para solucionar esto, desarrollamos el `Surgical Rollback`. Al anular un Invoice a través del Frontend, nuestro Endpoint especializado **fuerza** la re-apertura logística atacando directo a la base de datos (PostgreSQL), devolviendo el dinero orgánicamente y reiniciando el stock para que la factura pueda rehacerse desde 0.

---

## 2. Credit Memo Void & Rollback

### Credit Memo Void Overview

When a credit memo is voided via `POST /admin/pos/credit_memos/:id/void`:

1. **Inventory Reversal**
   - Subtracts the restocked quantities from inventory (reverses the restock from CM complete)
   - Calls `adjustInventory` with negative quantities

2. **QB Void** (if `qb_txn_id` exists, async, non-blocking via IIFE)
   - Calls `voidCreditMemoInQb(qb_txn_id, qb_edit_sequence)`
   - Writes pipeline row: `step='void_credit_memo', status='submitted'`
   - Return format: `{ success: true, data: QbAsyncResult }` (fixed 2026-03-29)

3. **Finance Ledger Void**
   - Marks associated `CustomerPayment` (type `credit_memo`) as `voided` via `financeService.updateCustomerPayments`
   - Sets `voided_at` timestamp
   - UI displays as reversal line in ledger

4. **PosInvoice Restore**
   - Subtracts refunded amounts: `refunded_amount -= cm.refunded_amount`
   - Subtracts refunded shipping: `refunded_shipping -= cm.refunded_shipping`
   - Auto-recalculates `status`:
     - If now `amount_paid >= total` → `paid`
     - If `amount_paid > 0` → `partial`
     - Otherwise → back to previous state (e.g., `issued`)

5. **PosInvoiceItem Restore** (per item, matched by SKU)
   - Subtracts refunded quantity: `refunded_quantity -= cm_item.quantity`
   - Returns value to the maximum refundable amount

6. **Mark CM as Voided**
   - Sets `credit_memo.status = 'voided'`
   - Sets `credit_memo.voided_at = NOW()`

### Example Void Scenario

```
Before CM void:
  Invoice: paid=$500, total=$500, refunded_amount=$200 (from CM)
  Item A: quantity=10, refunded_quantity=2 (from CM)
  CM: status=completed, refunded_amount=$200
  Finance: CustomerPayment (type: credit_memo) with status=applied

After CM void:
  Invoice: paid=$500, total=$500, refunded_amount=$0 (restored)
  Item A: quantity=10, refunded_quantity=0 (restored)
  CM: status=voided, voided_at=NOW()
  Finance: CustomerPayment marked voided with voided_at
  QB: Credit Memo void operation in pipeline (fire-and-forget)
```

---

## 3. QB Bridge Void Behavior

Cuando una factura POS se anula mediante `POST /admin/invoices/{id}/void`, el backend realiza una operación llamada `TxnVoidRq` (DELETE request) al QB Bridge. Esto es exactamente el comportamiento **nativo de QuickBooks Desktop**.

### Comportamiento Correcto del QB Void

En QuickBooks Desktop, cuando se anula una transacción (Txn):
1. **Todas las cantidades de items se establecen a 0** (zeroed out).
2. **El total de la transacción se establece a $0.00**.
3. **La transacción sigue visible en los reportes** pero se marca como voided.
4. **Los reportes de ingresos y antigüedad de AR (Accounts Receivable) automáticamente excluyen transacciones voided**.

### Comportamiento POS en PostgreSQL

Cuando el endpoint `POST /admin/invoices/{id}/void` se ejecuta:
1. **Campos monetarios en `pos_invoice`:** Se establecen a 0
   - `subtotal = 0`
   - `discount = 0`
   - `shipping = 0`
   - `tax = 0`
   - `total = 0`
   - `balance_due = 0`
   - `amount_paid = 0` (devuelve el dinero al cliente)

2. **Campos de items en `pos_invoice_item`:** Se establecen a 0
   - `unit_price = 0`
   - `total = 0` (para cada item)

3. **Status:** Se marca como `status = 'voided'` y se captura `voided_at = NOW()`

4. **Reversión de relaciones:** Los `PaymentApplication` vinculados se marcan con `voided_at` y el dinero se retorna al perfil del cliente.

### Razón Técnica

El QB Bridge implementa `TxnVoidRq` que es la operación nativa de QB Desktop. Esto garantiza que:
- El POS y QB permanecen sincronizados bit-a-bit.
- No hay necesidad de lógica custom para "eliminar" o "revertir" en QB.
- Los reportes automáticamente excluyen voided transactions.

**Conclusión:** Una factura voided con $0.00 es contablemente correcta. Cuando se imprime, muestra todos los valores como $0.00.

---

## 4. Invoice Void — Algoritmo Paso-a-Paso

**Ruta:** `backend/src/api/admin/invoices/[id]/void/route.ts`

### A. Extracción en Bruto (Raw SQL vs ORM)

A veces el ORM nativo de Medusa deshidrata relaciones profundas como `.items`. Para no depender, instanciamos directamente la conexión de PostgreSQL (`getDbPool`) y extraemos los ítems de factura (`pos_invoice_item`) usando el ID actual de la factura.

### B. Fallback String Matching

Medusa es estricto en el uso de internal IDs (`variant_id`). Sin embargo, en Invoices copiados o draft orders, algunas APIs omiten este ID. El script realiza una comprobación redundante uniendo por `sku`:

```typescript
let orderItem = orderItems.find((oi: any) => oi.variant_id === posItem.variant_id)
if (!orderItem) {
    // FALLBACK CLAVE: Buscar por SKU nativo si falla el map ID.
    orderItem = orderItems.find((oi: any) => oi.variant_sku === posItem.sku)
}
```

### C. Bypass de Restricciones "Delivered"

Al encontrar la concordancia, aplicamos el martillo. Bypaseamos los chequeos restrictivos de la API superior y descontamos `fulfilled_quantity` mediante un comando RAW:

```sql
UPDATE order_item
SET fulfilled_quantity = GREATEST(COALESCE(fulfilled_quantity, 0) - $1, 0),
    delivered_quantity = GREATEST(COALESCE(delivered_quantity, 0) - $1, 0)
WHERE id = $2
```

### D. Regresar Stock e Iniciar Reservaciones

Físicamente, Medusa v2 abstrae el inventario fuera de las variantes maestras. Utilizamos `inventoryService.adjustInventory` apuntando al `inventory_item_id` y al `location_id` principal.

Al regresar a anaquel, la orden (ahora no facturada y no enviada) perdería el nexo lógico de separación del stock en la tienda. Solucionamos eso re-reservando (Allocating):

```typescript
await createReservationsWorkflow(req.scope).run({
    input: {
        return_items: activeInvoiceItems.map((item: any) => ({
            id:         item.order_item_id, // Vincula nuevamente al orden
            quantity:   item.quantity,
            location_id: fulfillmentLocationId,
            item_id:    item.inventory_item_id
        }))
    }
})
```

### E. Desenlace Financiero y DML Payload Quirks

Por último el script debe desligar los fondos del pago para que queden disponibles en el perfil del Customer.

**Medusa v2 Documented Behaviors**:
1. Los filtros sobre fechas vacías (`voided_at: null`) no suelen funcionar en APIs customizadas por su abstracción DML. El script descarga TODAS las aplicaciones y las filtra en memoria (`.filter(a => !a.voided_at)`).
2. Los métodos `updatePosInvoices` y `updateCustomerPayments` EN MEDUSA V2 **deben agrupar todo el payload dentro de un solo objeto explícito**, incluyendo la ID. (No como el estándar `{ id }, { status }`).

```typescript
// Forzando cero contable para reflejar "Voids Matemáticos"
await invoiceService.updatePosInvoices({
    id,
    amount_paid: 0,
    subtotal:    0,
    tax:         0,
    total:       0,
    balance_due: 0,
    status:     'voided', // Marca como voided en panel de control
    voided_at:  new Date(),
})
```

---

## 5. Frontend Visual "Tracer Ledger"

Los desarrolladores asumen usualmente que las filas con `voided_at` en la base de datos deben ser ignoradas y borradas de la Interfaz Visual. Sin embargo, para la contabilidad, el dinero que se retira y se regresa **debe quedar registrado visualmente**.

**Archivo:** `ecopowertech-store-pos/components/pos/payments/CreditStatement.tsx`

La estrategia es interceptar `apps` (todas las transacciones del depósito), construir una lista paralela (`ledgerLines`) e insertar objetos **Sintéticos Multicolumna**:

```tsx
const ledgerLines: any[] = []
allApps.forEach((app: any) => {
    // Línea real:
    ledgerLines.push({
        id: app.id,
        type: 'application',
        date: app.applied_at,
        changeAmt: Number(app.amount_applied) // Reduce el balance (Resta)
    })

    // Si la DB tiene `voided_at`, creamos artificialmente una Línea Reversal
    if (app.voided_at) {
        ledgerLines.push({
            id: app.id + '_void',
            type: 'void',
            date: app.voided_at,
            changeAmt: -Number(app.amount_applied) // Vuelve a Sumar (Matemática Reversa)
        })
    }
})
```

Ese bucle en la UI se asegura que el contador trace a la perfección los depósitos iniciales, su pago a Invoices y, de haber errores humanos, las restituciones explícitas registradas con `Reversal - Invoice N` en letras rojas hasta devolver a `$0.00`.

---

## 6. Void Confirmation Modal

**Component:** `ecopowertech-store-pos/components/pos/VoidDocumentModal.tsx`

To prevent accidental voids of important financial documents, the frontend enforces confirmation via:

### 1. Document Type Identification

Modal accepts document type: `'Invoice' | 'Credit Memo' | 'Sales Receipt' | 'Estimate' | 'Sales Order'`

Displays different guidance text per document type.

### 2. Confirmation Input

- User must type **`VOID`** (all caps) to proceed
- Field is case-sensitive and required
- Button remains disabled until correct text is entered

### 3. Warning Bullet Points

**For Invoice specifically:**
- "All invoice amounts will be reversed"
- "Inventory will be returned to stock"
- "QB sync will void the invoice"
- "Associated payments will be marked voided"

**For Credit Memo specifically:**
- "All refunded amounts will be reversed"
- "Inventory will be returned to stock"
- "QB sync will void the credit memo (if synced)"
- "Associated refund credit will be marked as voided"

### 4. UI Integration

The Returns page and Invoice page both use `VoidDocumentModal`:

```typescript
// In Credit Memo detail page:
<VoidDocumentModal
    isOpen={showVoidConfirm}
    documentType="Credit Memo"
    onConfirm={() => handleVoidCreditMemo(creditMemo.id)}
    onCancel={() => setShowVoidConfirm(false)}
/>

// In Invoice detail page:
<VoidDocumentModal
    isOpen={showVoidConfirm}
    documentType="Invoice"
    onConfirm={() => handleVoidInvoice(invoice.id)}
    onCancel={() => setShowVoidConfirm(false)}
/>
```

---

## 7. Archivos Clave en el Repositorio

Si necesitas editar, expandir o debuggear el proceso de Void, estos son los archivos absolutos donde ocurre la magia en la aplicación `ecopowertech-workspace`:

| Entorno | Archivo Clave | Propósito Principal |
|---------|-----------------|---------------------|
| **Backend** | `backend/src/api/admin/invoices/[id]/void/route.ts` | El cerebro de la operación. Ejecuta SQL crudo y APIs nativas de DML para anular la orden entera. |
| **Backend** | `backend/src/api/admin/pos/credit_memos/[id]/void/route.ts` | CM void logic with inventory reversal and finance ledger update |
| **Backend** | `backend/src/lib/quickbooks/client/credit-memos.ts` | voidCreditMemoInQb with fixed return format |
| **Backend** | `backend/src/modules/finance/models/payment-application.ts` | Modelo que une depósitos matemáticos (`CustomerPayment`) a Invoices específicos. |
| **Frontend** | `ecopowertech-store-pos/components/pos/payments/CreditStatement.tsx` | El componente del UI que reconstruye la historia visual de la transferencia de dinero y voids. |
| **Frontend** | `ecopowertech-store-pos/components/pos/VoidDocumentModal.tsx` | Confirmation modal for safe void operations |
| **Frontend** | `ecopowertech-store-pos/app/(pos)/invoices/[id]/page.tsx` | Renderiza la factura visual. Alberga el botón de acción global de `Void`. |

---

## 8. Pipeline Tracking for Voids

All void operations write to `qb_order_pipeline` with full tracking:

- `void_invoice`: triggered by `POST /admin/invoices/:id/void`
- `void_credit_memo`: triggered by `POST /admin/pos/credit_memos/:id/void`
- `void_sales_receipt`: triggered by invoice void handler / POS cancellation
- `void_sales_order`: triggered by `handle-order-canceled.ts` (order cancel event)

Each void row captures:
- `medusa_ref_number` (e.g., INV-1234, CM-567)
- `qb_ref_number` (QB-assigned reference)
- `qb_txn_id` (QB transaction ID being voided)
- Full status lifecycle: `submitted` → `confirmed` or `failed`
- Error messages for debugging

See [QB_PIPELINE_ARCHITECTURE.md](./QB_PIPELINE_ARCHITECTURE.md) for complete void tracking documentation.

---

## 9. Integration Points

### Backend → QB Bridge

Void operations are non-blocking (fire-and-forget):
- Endpoint returns 200 OK immediately
- Background IIFE sends void to QB Bridge via `setTimeout`
- Pipeline row tracks async confirmation
- Consolidator polls every 2 minutes for status

### Frontend → Backend

Void endpoints require confirmation modal:
- User types "VOID" (case-sensitive)
- Button disabled until exact match
- On confirm, POST to void endpoint
- Toast notification on success/failure

### Finance → Inventory

Void operations coordinate:
1. **Finance first:** Mark `CustomerPayment` as voided
2. **Inventory second:** Restock quantities
3. **QB last:** Fire-and-forget void to QB Bridge
4. **PosInvoice:** Update refund tracking fields

---

## 10. Recent Bug Fixes & Enhancements

### voidCreditMemoInQb Return Format Fix (2026-03-29)

**Issue:** Function returned `QbAsyncResult` directly without wrapping in standard envelope.

**Fix:** Now returns `{ success: true, data: QbAsyncResult }`

**Impact:** Void confirmations correctly logged as successful.

### Intelligent Void Routing (2026-03-29)

**Enhancement:** `POST /admin/pos/sync` endpoint auto-detects voided documents and routes intelligently:

```typescript
if (type === 'credit_memo' && status === 'voided' && qb_txn_id) {
    // Auto-route to void handler
    await voidCreditMemoInQb(qb_txn_id, qb_edit_sequence)
}
```

**Benefit:** Users no longer receive "Only completed CMs can be synced" error.

---

**Last Updated:** 2026-03-29
**Version:** 2.0 — Complete void architecture with CM support and pipeline tracking

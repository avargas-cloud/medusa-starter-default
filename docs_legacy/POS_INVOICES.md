# POS Invoices — Architecture & Technical Documentation

**Last Updated:** 2026-03-29

Este documento detalla la arquitectura, flujo de datos y decisiones de diseño del módulo de **Invoices** dentro de la aplicación EcoPowerTech Store POS (`/app/(pos)/invoices`).

A diferencia de los Estimates y Orders, que interactúan fuertemente con las APIs nativas de Draft Orders y Orders de Medusa v2, las **Invoices (Facturas)** operan bajo un modelo de datos Custom (`PosInvoice`) construido sobre el framework de Medusa.

---

## 1. Naturaleza y Ciclo de Vida del Invoice

Un `PosInvoice` es un registro inmutable (estático) generado a partir de una orden de Medusa en estado avanzado (cuando ya se ha despachado o cobrado mercadería).

### Regla de Creación

- **Fulfillment Requirement:** Las facturas están estrechamente ligadas a la entrega. El listado general de `/invoices` filtra nativamente y **solo muestra** aquellas órdenes donde `fulfillment_status` esté en `['fulfilled', 'shipped', 'delivered']`.
- **Relación Cardinal:**
  - 1 Medusa Order → Múltiples Fulfillments → Múltiples `PosInvoice` (Una factura por cada despacho parcial, aunque lo típico es 1:1).

### Ciclo de Estados (`InvoiceStatus`)

1. `draft` — Factura creada pero sin emitir al cliente.
2. `issued` — Factura emitida (esperando pagos).
3. `partial` — Factura con pagos parciales (ej. Abonos).
4. `paid` — Factura cobrada en su totalidad (`balance_due === 0`).
5. `partially_refunded` — Factura con devoluciones parciales (vía Credit Memo).
6. `refunded` — Factura completamente reembolsada.
7. `voided` — Factura anulada (ej. devolución o error de digitación).

---

## 2. Modelo de Datos Custom (`PosInvoice`)

Dado que Medusa v2 no posee una entidad nativa "Invoice" B2B compleja por defecto, se definió un data model ad-hoc en el backend (`backend/src/modules/invoices/models/pos-invoice.ts`):

- **ID y Secuencia:** Usa un prefijo auto-generado legible humanamente: `INV-{order.display_id}-{seq}`.
- **Snapshot de Seguridad:** A diferencia de las Órdenes donde cambiar el Address actualiza toda la orden, el `PosInvoice` toma un snapshot inmutable del `shipping_address`, `items`, y `subtotals` en el momento preciso de la creación. Esto garantiza la integridad contable sin importar si la orden original sufre mutaciones de metadatos más adelante.
- **Pagos y Tracking Links:** Incorpora relaciones nativas 1:N hacia `InvoicePayment` (registrando abonos parciales, fechas y métodos) y `InvoiceTracking` (URL y Guías de envío por Courier).

### PosInvoice TypeScript Interface

El interface `PosInvoice` en `ecopowertech-store-pos/lib/invoices.ts` incluye campos para rastrear devoluciones:

```typescript
export interface PosInvoice {
    id:                 string
    order_id:           string
    invoice_number:     string
    fulfillment_id?:    string
    status:             InvoiceStatus      // draft | issued | partial | paid | partially_refunded | refunded | voided
    subtotal:           number             // cents
    discount:           number             // cents
    shipping:           number             // cents
    tax:                number             // cents
    total:              number             // cents
    amount_paid:        number             // cents
    balance_due:        number             // cents
    refunded_amount:    number             // cents (cumulative amount refunded via credit memos)
    refunded_shipping:  number             // cents (cumulative shipping refunded)
    payment_method?:    string             // 'cash' | 'check' | 'card' | 'ach' | 'credit' | 'mixed'
    issued_at?:         string | null
    voided_at?:         string | null
    // ... other fields
}
```

**Campos de Devolución:**
1. **`refunded_amount`** — Cantidad total reembolsada vía notas de crédito (en centavos), default 0
2. **`refunded_shipping`** — Envío reembolsado (en centavos), default 0
3. **Status enum extendido:** Ahora incluye `'partially_refunded'` (parcialmente reembolsada) y `'refunded'` (completamente reembolsada) además de los existentes `['draft', 'issued', 'partial', 'paid', 'voided']`

---

## 2.5 PosInvoiceItem — Refunded Quantity Tracking

El modelo `PosInvoiceItem` ahora incluye un campo para rastrear cuántas unidades han sido reembolsadas:

```typescript
interface PosInvoiceItem {
    id:                    string
    invoice_id:            string
    order_item_id?:        string
    variant_id?:           string
    sku:                   string
    description:           string
    quantity:              number           // Cantidad original facturada
    refunded_quantity:     number           // Cantidad reembolsada (default 0)
    unit_price:            number           // cents
    total:                 number           // cents
    // ... other fields
}
```

**Propósito:** Cuando se crea una nota de crédito (Credit Memo), el UI usa `refunded_quantity` para validar que la cantidad siendo reembolsada no exceda `(quantity - refunded_quantity)`. Esto previene sobre-reembolsos.

**Actualización de `refunded_quantity`:**
- On CM complete: `refunded_quantity += cm_item.quantity` (para el item con SKU coincidente)
- On CM void: `refunded_quantity -= cm_item.quantity` (restaura el valor anterior)

---

## 3. Credit Memo Complete Flow

**Ruta:** `POST /admin/pos/credit_memos/:id/complete`

1. **Inventory Restock** — Cada item devuelto se re-añade al inventario
2. **QuickBooks Sync** (background, non-blocking via fire-and-forget IIFE)
   - Crea `CreditMemoAddRq` en QB
   - Escribe fila de pipeline: `step='credit_memo', status='submitted'`
3. **Medusa Native Refund**
   - `refundPayment({ payment_id, amount })` — amount en dólares (major units)
   - Crea una transacción de reembolso nativa
4. **Update PosInvoice**
   - `refunded_amount += cm.refunded_amount` (suma total cumulativa)
   - `refunded_shipping += cm.refunded_shipping`
   - Auto-recalcula `status`:
     - Si `amount_paid > balance_due` → `partially_refunded`
     - Si `amount_paid >= total` (fully refunded) → `refunded`
5. **Update PosInvoiceItem** (por cada item)
   - `refunded_quantity += cm_item.quantity` (match por SKU)
6. **Finance Ledger Entry**
   - Crea `CustomerPayment` de tipo `credit_memo` con `qb_source: 'sales_receipt'` metadata cuando aplica
   - Status: `available` o `applied`
7. **QB Pipeline Row** — `step='credit_memo', status='submitted'` (tracked for async confirmation)

---

## 4. Credit Memo Void Flow

**Ruta:** `POST /admin/pos/credit_memos/:id/void`

1. **Inventory Reversal** — Resta las cantidades que fueron reabastecidas
2. **QB Void** (background, if `qb_txn_id` exists, non-blocking)
   - Llama `voidCreditMemoInQb(qb_txn_id, qb_edit_sequence)`
   - Writes pipeline row: `step='void_credit_memo', status='submitted'`
3. **Finance Ledger Void**
   - Marca associated `CustomerPayment` (type `credit_memo`) como `voided` vía `financeService.updateCustomerPayments`
4. **PosInvoice Restore**
   - `refunded_amount -= cm.refunded_amount` (reverse cumulative)
   - `refunded_shipping -= cm.refunded_shipping`
   - Auto-recalcula `status` (back to `paid`, `partial`, or `issued`)
5. **PosInvoiceItem Restore** (por cada item)
   - `refunded_quantity -= cm_item.quantity` (restore previous value)
6. **Mark CM** — `status = 'voided'` con `voided_at = NOW()`

---

## 5. Safe Invoice Print Snapshot (draftCache Approach)

Cuando el usuario abre una factura y hace clic en "Print", el frontend debe generar un PDF que refleje exactamente el estado de la factura en la base de datos — **sin modificar** el documento activo ni marcar `isDirty`.

### Flujo de `openPrintPage()`

```typescript
// ecopowertech-store-pos/app/(pos)/invoices/[id]/page.tsx
async function openPrintPage() {
    // 1. Construir un snapshot completo de la factura (inv es PosInvoice de la DB)
    const invoiceMeta = {
        _print_subtotal: inv.subtotal,        // Injected from DB
        _print_discount: inv.discount,        // Read directly from DB (NOT derived)
        _print_shipping: inv.shipping,        // Injected from DB
        _print_tax: inv.tax,                  // Injected from DB
        _print_total: inv.total,              // Injected from DB
        _print_amount_paid: inv.amount_paid,  // Injected from DB
        _print_balance_due: inv.balance_due,  // Injected from DB
    }

    // 2. Inyectar el snapshot en draftCache (Zustand store)
    // NO toca el documento activo; NO cambia isDirty
    setDraftCache(prev => ({
        ...prev,
        [`print_invoice_${inv.id}`]: invoiceMeta
    }))

    // 3. Navegar a la página de print con la plantilla
    router.push(`/print/[templateId]?inv=${inv.id}`)
}
```

### Razón del Enfoque `draftCache`

**Antes (problema):** El endpoint de print intenta recalcular los totales dinámicamente desde el orden vivo, lo cual puede producir valores que no coinciden con el snapshot guardado en postgres si la orden ha sido modificada desde la facturación.

**Ahora (solución):** Los totales se **inyectan directamente desde la base de datos** vía metadatos, garantizando que:
1. El PDF impreso refleja el estado contable exacto guardado en postgres.
2. No se modifica el documento activo en `posStore`.
3. `isDirty` permanece sin cambios (no activa "Save pending").
4. Se evitan recalculos dinámicos que pueden producir discrepancias de centavos.

### Handling de Invoices Voided

Las facturas anuladas (`status === 'voided'`) **sí pueden imprimirse**:
- Todos sus valores en la DB se establecen a $0.00 (subtotal, discount, shipping, tax, total, balance_due).
- El PDF impreso mostrará todos estos valores como $0.00.
- Esto es correcto desde el punto de vista contable: un Invoice voided es un documento nulo sin valor.

---

## 6. UI Layout & Shared Context (Read-Only)

El diseño visual de la vista individual de Invoice (`/invoices/:orderId`) hereda la filosofía de 1080p estricto ("No-Scroll") utilizada en Estimates y Orders.

### Reutilización de `posStore`

A pesar de ser una página de facturas, la aplicación **reutiliza el mismo `useOrder(id)` hook** importado desde Orders. Esto significa que:
1. La página de Invoices carga la Orden de Medusa completa en el `posStore`.
2. Reutiliza exactamente los mismos componentes UI masivos (`LineItemsTable`, `OrderSummary`, `ShippingSection`).
3. **Restricción de Acciones:** A nivel de interfaz, el Toolbar desactiva las capacidades de edición de productos por contexto. Los items no pueden alterarse.
4. **Guardado de Metadatos:** El único evento de guardado permitido en la vista de Invoices es el parcheo (`PATCH`) de los metadatos de la orden padre (ej. Notas internas, Terms, Lead Time, P.O).
5. **Retro-Compatibilidad Agnóstica:** Debido a variables evolutivas, el inicializador global (`useOrderData.ts`) intentará buscar claves agnósticas (como `lead_time`) y si no existen, consumirá automáticamente cualquier metadato arrastrado bajo el prefijo legacy `estimate_lead_time`. Esto consolida Invoices históricas sin scripts de migración.

### Read-Only Enforcement

**Arquitectura:** La página de factura es completamente de lectura. Las secciones `ShippingSection`, `PromotionsSection`, y `NoteArea` son **siempre de solo lectura**:
- **ShippingSection**: La propiedad `onOpenModal` se pasa como `undefined`, deshabilitando cualquier diálogo modal de edición de envío.
- **PromotionsSection** y **NoteArea**: Se aplica `pointer-events-none opacity-60` en su contenedor, deshabilita visualmente cualquier interacción.
- **NoteArea component**: Se fuerza `isReadOnly={true}` para bloquear ediciones de notas.

**Justificación:** Un Invoice es un snapshot inmutable de una factura emitida. No debe permitirse cambios en envío, promociones o notas después de su creación. El único cambio permitido es el metadata de la orden padre vía `PATCH`.

### Expanded Items Modal

El componente `InvoiceItemsExpandedModal.tsx` proporciona una vista full-screen (92vw × 90vh) de los items facturados en un portal modal:
- **Encabezado:** Muestra "Read-only — exact invoice snapshot" para reforzar la inmutabilidad.
- **Contenido:** Renderiza `LineItemsTable` con `itemsOverride` apuntando a los items exactos de la factura capturada.
- **Pie de página:** Muestra los totales de factura (subtotal, discount, shipping, tax, balance_due) inyectados desde el snapshot de la factura en la base de datos.

Este componente no permite ediciones. Solo visualiza el state de la factura en el momento exacto de su emisión.

---

## 7. Unsaved Changes Guard & Print Firewall

**Regla de Guardado Habilitado (Save Button):**
Como ocurre unificadamente en Estimates y Orders, el botón de "Save" en `DocumentToolbar` **siempre estará habilitado**, dando la opción al comerciante de forzar un guardado. La propiedad `isDirty` tiene un comportamiento **únicamente visual** (naranja/ámbar) para alertar al operador que su vista actual difiere de la base de datos de Invoices.

Al compartir el componente base `DocumentToolbar.tsx` que orquesta la cabecera gris de los Documentos del POS, toda la vista de Invoice hereda automáticamente el mismo Firewall de impresiones integrado:
- Si un operador de caja edita una Nota, cambia un Término de Pago (Metadata), o adjunta algún valor flotante, la propiedad `isDirty` enciende el warning naranja en el botón de Save y el documento actual.
- Los botones adjuntos de **Print** y **Email** interceptarán cualquier intento de click mediante una alerta roja de Sonner (`toast.error`), exigiendo que primero se haga clic en Save de todas formas antes de poder enviar un PDF que no posea los últimos cambios capturados en las casillas.
- De igual forma que en Estimates, el campo de promociones renderizará estéticamente un string vacío (`''`) al imprimirse en caso de no contener descuentos, mejorando las métricas de marketing y evitando discusiones con los clientes visualizando la palabra "None".

---

## 8. Virtual Row Notes & Paginación

### Virtual Row Notes

Al igual que Estimates y Orders, los Invoices heredan la solución anti-overflow de las notas largas al momento de Imprimir/Exportar a PDF.
- Cualquier contenido en `doc.note` no se renderiza en un bloque estático en la plantilla. En su lugar, el `BlockRenderer` intercepta este metadato, crea una "fila virtual de ítem" con el identificador `**_NOTE_**`, y fuerza a la tabla CSS a asignar un bloque que abarque el 100% del ancho.
- Si la invoice contiene cientos de renglones de términos comerciales, la tabla sencillamente paginará todo el grupo hacia una segunda (o tercera) página sin cortar el texto ni romper las márgenes.

---

## 9. Exact Medusa v2 Math & Rounding Rules

The Medusa v2 calculation engine does NOT apply discounts and taxes globally to the summed cart total. It accumulates them strictly **line-by-line using integer cents**.

To achieve 100% parity between the POS frontend and the Medusa backend, the following algorithm **must** be used inside the POS state (`posStore.ts` and `computeEffectivePrice` payload builders):

1. **Calculate Cents:** All calculations must convert the base unit price to cents first (`Math.round(price * 100)`).
2. **Line Discounts (Unit-Level Rounding):** Line discounts apply directly to the unit price in cents. Round the result of `(unitPriceCents * discountRate)`, then multiply by `quantity`. Calculate `lineAfterLineDiscountCents`.
3. **Order Discounts (Line-Level Rounding):** The total global order discount (e.g. 5%) is applied proportionally to each item's `lineAfterLineDiscountCents` total. Calculate `Math.round(lineAfterLineDiscountCents * orderDiscountRate)`. Accumulate all these rounded values to get the global `orderDiscountTotalCents`.
4. **Tax Calculation (Aggregate Level):** Tax is applied implicitly on the aggregate taxable total after all discounts are deducted. `taxableAmountCents = afterLineDiscountsSubtotalCents - orderDiscountTotalCents`. Then `Math.round(taxableAmountCents * taxRate)`.
5. **Divisor:** Sum the final cents and divide by `100` at the very end to yield the exact POS display values and payload targets.

Failure to follow this exact order of rounding (or using floating-point `toFixed()` mid-calculation) will lead to 1-2 cent discrepancies against the Medusa backend.

---

## 10. Direct Execution Pattern (QuickBooks Sync)

**Decisión Arquitectónica:**
Previamente, el endpoint `POST /admin/invoices` delegaba la creación de la factura en QuickBooks al Bus de Eventos de Medusa (BullMQ) lanzando `order.fulfillment_created`. Sin embargo, debido a intermitencias graves en entornos Vercel/Railway donde BullMQ descartaba ("dropped") eventos críticos silenciosamente, se cambió a un patrón de **Direct Execution**.

1. Tras crear el registro nativo de fulfillment y factura en Postgres, el endpoint **no espera a Redis**.
2. Dispara inmediatamente la función `handleFulfillmentCreated()` envolviéndola en un `setTimeout(..., 100)` para no bloquear el retorno HTTP 200 a la interfaz del POS.
3. El proceso de fondo (Background Thread) asíncrono se encarga de crear el Invoice en QB y aplicar cualquier pago previo, garantizando un 100% de éxito («Fire and Forget» seguro).
4. El Subscriber global `qb-order-subscriber.ts` fue modificado para **ignorar explícitamente** cualquier evento `order.fulfillment_created` de órdenes que contengan `metadata.pos_created === true`, protegiendo el sistema contra facturación duplicada en QuickBooks.

---

## 11. Partial Fulfillments (Surgical Line Extraction)

**Decisión Arquitectónica:**
Previamente, emitir una factura POS ocasionaba que el Bridge de QuickBooks convirtiera ciegamente **toda la Orden de Venta (Sales Order)** en un Invoice, sin importar si el cliente se estaba llevando solo el 10% de la mercancía.

Para resolver esto y soportar flujos B2B reales (Despachos Parciales o Backorders):
1. **Inyección Estricta del `fulfillment_id`:** El endpoint interno envía explícitamente el UUID del `Fulfillment` de Medusa originado en la interfaz de usuario al QB Bridge (`fulfillmentId`).
2. **Iteración Quirúrgica:** Dentro del QB Bridge (`invoiceBuilder`), en lugar de mapear el vector `order.items` general, el motor ahora interroga el array encapsulado `fulfillment.items`.
3. **Mapeo Cuantitativo Reversivo:** De cada item despachado, lee la cantidad exacta (`item.quantity`) levantada por el operario, y cruza esta ID con las filas originales para extraer el precio unitario y descuentos proporcionales.
4. **QuickBooks Resultante:** Invoice (Factura) generada en QuickBooks refleja de manera impecable y exacta **solamente los SKUs empacados y despachados** en esa ronda particular. El balance restante queda flotando vivo dentro del Sales Order de QB aguardando el próximo Pick & Pack (próxima Factura parcial).

---

## 12. Dashboard de Invoices (`/invoices`)

**Archivo:** `ecopowertech-store-pos/app/(pos)/invoices/page.tsx`

### Columnas de la Tabla

| Columna | Fuente |
|---------|--------|
| Invoice # | `inv.invoice_number` (prefijo `INV-{display_id}-{seq}`). Ícono `Receipt`. Sin bold. |
| QB Ref # | `metadata.qb_invoice.ref_number` (o `qb_invoices[-1].ref_number`). Batch-fetched desde la orden padre. |
| Date | `inv.issued_at` → fallback `inv.created_at` |
| Customer | `order.customer.first_name + last_name` (batch-fetch) |
| Company | `order.customer.company_name` (batch-fetch) |
| Email | `order.customer.email` → fallback `order.email` (batch-fetch) |
| Status | `inv.status` — badge: `draft`=gris, `issued`=azul, `partial`=ámbar, `paid`=verde, `partially_refunded`=naranja, `refunded`=purpura, `voided`=rojo |
| Payment | `inv.payment_method` (`cash`, `check`, `card`, `ach`, `credit`, `mixed`) |
| Total | `inv.total / 100` en dólares (verde) |
| Balance | `inv.balance_due / 100` — verde si pagado, ámbar si pendiente, `—` si voided |
| QB Sync | Ícono: ✅ `Check` verde (`qb txn_id` presente), ❌ `X` rojo (no sincronizado). Columna centrada. |

### Estrategia de Datos (2-Query Batch)

1. **Query principal:** `GET /admin/invoices` — retorna todos los `PosInvoice`.
2. **Query secundaria (batch):** `GET /admin/orders?id[]=...&fields=id,metadata,email,+customer.*&limit=100`
   - Extrae QB metadata y datos del cliente en un solo request por lote de `order_id` únicos.
   - Produce un mapa `orderId → { ref, synced, customerName, company, email }`.
   - `staleTime: 0` — siempre se re-fetcha al montar para datos frescos.

### Sort (client-side)

| Opción | Descripción |
|--------|-------------|
| `date_desc` | Date (Newest) — **default** |
| `date_asc` | Date (Oldest) |
| `total_desc` | Total (High → Low) |
| `total_asc` | Total (Low → High) |
| `invoice_desc` | Invoice # (Desc) |
| `invoice_asc` | Invoice # (Asc) |
| `balance_desc` | Balance (Highest) |

### Navegación al abrir un Invoice

Click en fila → `Link href={'/invoices/${inv.order_id}'}` → carga la vista de detalle de la orden referenciada.

---

## 13. Recent Fixes & Enhancements

### Multi-Payments & Store Credits en el UI de Invoices

**Problema:**
Previamente la tabla principal de Invoice List y la vista detallada Invoice Receipt intentaban deducir el "Payment Method" asumiendo que un Invoice recibía un sólo pago global, lo cual fallaba si el cliente usaba 50% Cash y 50% Store Credit. Adicionalmente, el `CompleteOrderModal` permitía ingresar montos aleatorios superiores a la deuda en "Cash" causando desajustes contables.

**Solución Implementada:**
1. **Recorte Dinámico de Inputs (Cap):** Las barras de Cash / Card de todos los UI limits (CompleteOrder, CapturePayment) ahora están limitadas lógicamente por un `requiredCashCents`. Si la orden totaliza $1000 y el usuario selecciona $200 de crédito a favor, las cajas limitarán la escritura de montos externos a máximo $800, y los botones de "%" calcularán base a los $800 restantes.
2. **Display Compuesto por Transactions:**
   - Si un Invoice recibe fondos de más de 1 fuente, la columna de listado `/invoices` ahora renderizará `Mixed` u `Other` en el badge de Payments para protegerse.
   - En la vista individual `[/id]`, el array de `payment_applications` se mapea renderizando renglones detallados de "Store Credit Application - ID", así como "Deposit Application" en verde antes de totalizar el gran Total.
   - Al estar unificados bajo un `transaction_id`, el Invoice puede navegar hacia el recibo transaccional de `/transactions/:id` detallando el origen genésico de los fondos y en cuales otras facturas impactaron dichos fondos al mismo tiempo.

### invoicedQuantity Staleness After Invoice Creation

**Problema:** Cuando se creaba un nuevo invoice desde `CompleteOrderModal`, la propiedad `invoicedQuantity` en la tabla de items se quedaba en 0 para todos los items a pesar de que la factura se hubiera creado correctamente. La página seguía mostrando "Available: X" en lugar de actualizar a "Invoiced: X" después de crear la factura.

**Causa:** En `useOrderData.ts`, el hook de hidratación que calcula `invoicedQuantity` no incluía `invoicesData` en su dependency array. Cuando los datos de facturas llegaban del servidor, el effect no se re-ejecutaba, dejando los cálculos estancados.

**Solución:** Se agregó `invoicesData` al array de dependencias del useEffect:
```typescript
// ecopowertech-store-pos/app/(pos)/orders/[id]/hooks/useOrderData.ts
useEffect(() => {
    // ... hydration logic that computes invoicedQuantity ...
}, [order?.id, invoicesData])  // ← Added invoicesData
```

**Resultado:** Después de crear un invoice, la tabla de items se actualiza automáticamente mostrando las cantidades facturadas correctas.

### Eliminación del Cálculo Dinámico en Invoices

**Problema:** En el componente `OrderSummary.tsx` dentro de `InvoicePage.tsx`, el total, subtotal e impuesto se derivaban de reducciones matemáticas asumiendo descuentos. Ocasionalmente esto producía errores flotantes que sumaban `/ 100` ocasionando facturas visuales de $85.64 cuando postgres y QuickBooks dictaban $85.63.

**Solución:** Los Facturadores de lectura (`InvoicePage`) tienen terminantemente prohibido calcular cosas matemáticas. Todo se renderiza directamente mapeando la llave base desde `activeInvoice.tax`, `activeInvoice.total` y `activeInvoice.subtotal` alojados estáticos en postgres tras la ejecución perfecta nativa oficial de Medusa v2.

### Insignia "DELIVERED" estricta por Fulfillment ID

**Problema:** Las etiquetas de envío carecían de distinción visual rápida en facturas que ya habían egresado de almacén. Típicamente el POS marcaba que una factura estaba "Pending Fulfillment" basándose erróneamente en el paraguas total de la orden principal.

**Solución Implementada:** La variable local `isInvoiceFulfilled` se actualizó para ser agresivamente directa al ID base:
1. Realiza una búsqueda dentro del array de la orden extraído `order.order?.fulfillments?.find((f: any) => f.id === activeInvoice.fulfillment_id)`.
2. Revisa sus timestamps nativas `shipped_at`, `delivered_at`, ó si contiene trazas array dentro de la propiedad `labels` (Guías por Transportista).
3. Dependiendo de los datos, el badge renderizado en el UI será `"DELIVERED"` (color morado fuerte) ó `"PENDING FULFILLMENT"` para ayudar de un vistazo al representante de ventas.

### ShippingSection Prop Made Optional

**Cambio:** La propiedad `onOpenModal` del componente `ShippingSection` cambió de requerida a opcional (`onOpenModal?: () => void`).

**Razón:** En la página de invoices (read-only), no hay modal de edición de envío. Pasar `onOpenModal={undefined}` ahora es válido en lugar de requerir una función dummy.

**Ubicación:** `ecopowertech-store-pos/components/pos/ShippingSection.tsx`

---

## Files Reference

```
backend/src/
  api/admin/
    invoices/
      route.ts                GET list, POST create
      [id]/
        void/route.ts         POST void invoice
  modules/
    invoices/
      models/pos-invoice.ts
      models/pos-invoice-item.ts
  lib/quickbooks/
    client/credit-memos.ts    Credit memo operations

ecopowertech-store-pos/
  app/(pos)/invoices/
    page.tsx                  List page
    [id]/page.tsx             Detail page (orchestrator)
  components/pos/
    InvoiceItemsExpandedModal.tsx
    OrderSummary.tsx
    ShippingSection.tsx
  lib/invoices.ts             Shared types + API helpers
```

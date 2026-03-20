# POS Invoices - Architecture & Technical Documentation

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
1. `draft`: Factura creada pero sin emitir al cliente.
2. `issued`: Factura emitida (esperando pagos).
3. `partial`: Factura con pagos parciales (ej. Abonos).
4. `paid`: Factura cobrada en su totalidad (`balance_due === 0`).
5. `voided`: Factura anulada (ej. devolución o error de digitación).

---

## 2. Modelo de Datos Custom (`PosInvoice`)

Dado que Medusa v2 no posee una entidad nativa "Invoice" B2B compleja por defecto, se definió un data model ad-hoc en el backend (`backend/src/modules/invoices/models/pos-invoice.ts`):

- **ID y Secuencia:** Usa un prefijo auto-generado legible humanamente: `INV-{order.display_id}-{seq}`.
- **Snapshot de Seguridad:** A diferencia de las Órdenes donde cambiar el Address actualiza toda la orden, el `PosInvoice` toma un snapshot inmutable del `shipping_address`, `items`, y `subtotals` en el momento preciso de la creación. Esto garantiza la integridad contable sin importar si la orden original sufre mutaciones de metadatos más adelante.
- **Pagos y Tracking Links:** Incorpora relaciones nativas 1:N hacia `InvoicePayment` (registrando abonos parciales, fechas y métodos) y `InvoiceTracking` (URL y Guías de envío por Courier).

---

## 3. UI Layout & Shared Context (Read-Only)

El diseño visual de la vista individual de Invoice (`/invoices/:orderId`) hereda la filosofía de 1080p estricto ("No-Scroll") utilizada en Estimates y Orders.

### Reutilización de `posStore`
A pesar de ser una página de facturas, la aplicación **reutiliza el mismo `useOrder(id)` hook** importado desde Orders. Esto significa que:
1. La página de Invoices carga la Orden de Medusa completa en el `posStore`.
2. Reutiliza exactamente los mismos componentes UI masivos (`LineItemsTable`, `OrderSummary`, `ShippingSection`).
3. **Restricción de Acciones:** A nivel de interfaz, el Toolbar desactiva las capacidades de edición de productos por contexto. Los items no pueden alterarse.
4. **Guardado de Metadatos:** El único evento de guardado permitido en la vista de Invoices es el parcheo (`PATCH`) de los metadatos de la orden padre (ej. Notas internas, Terms, Lead Time, P.O).
5. **Retro-Compatibilidad Agnóstica:** Debido a variables evolutivas, el inicializador global (`useOrderData.ts`) intentará buscar claves agnósticas (como `lead_time`) y si no existen, consumirá automáticamente cualquier metadato arrastrado bajo el prefijo legacy `estimate_lead_time`. Esto consolida Invoices históricas sin scripts de migración.

---

## 4. Notas Temporales, Guardias de Impresión y Paginación

### Virtual Row Notes
Al igual que Estimates y Orders, los Invoices heredan la solución anti-overflow de las notas largas al momento de Imprimir/Exportar a PDF. 
- Cualquier contenido en `doc.note` no se renderiza en un bloque estático en la plantilla. En su lugar, el `BlockRenderer` intercepta este metadato, crea una "fila virtual de ítem" con el identificador `**_NOTE_**`, y fuerza a la tabla CSS a asignar un bloque que abarque el 100% del ancho. 
- Si la invoice contiene cientos de renglones de términos comerciales, la tabla sencillamente paginará todo el grupo hacia una segunda (o tercera) página sin cortar el texto ni romper las márgenes.

### Unsaved Changes Guard

**Regla de Guardado Habilitado (Save Button):**
Como ocurre unificadamente en Estimates y Orders, el botón de "Save" en `DocumentToolbar` **siempre estará habilitado**, dando la opción al comerciante de forzar un guardado. La propiedad `isDirty` tiene un comportamiento **únicamente visual** (naranja/ámbar) para alertar al operador que su vista actual difiere de la base de datos de Invoices. 

Al compartir el componente base `DocumentToolbar.tsx` que orquesta la cabecera gris de los Documentos del POS, toda la vista de Invoice hereda automáticamente el mismo Firewall de impresiones integrado en Marzo 2026:
- Si un operador de caja edita una Nota, cambia un Término de Pago (Metadata), o adjunta algún valor flotante, la propiedad `isDirty` enciende el warning naranja en el botón de Save y el documento actual.
- Los botones adjuntos de **Print** y **Email** interceptarán cualquier intento de click mediante una alerta roja de Sonner (`toast.error`), exigiendo que primero se haga clic en Save de todas formas antes de poder enviar un PDF que no posea los últimos cambios capturados en las casillas.
- De igual forma que en Estimates, el campo de promociones renderizará estéticamente un string vacío (`''`) al imprimirse en caso de no contener descuentos, mejorando las métricas de marketing y evitando discusiones con los clientes visualizando la palabra "None".

---

## 5. Exact Medusa v2 Math & Rounding Rules (Parity fix)

The Medusa v2 calculation engine does NOT apply discounts and taxes globally to the summed cart total. It accumulates them strictly **line-by-line using integer cents**.

To achieve 100% parity between the POS frontend and the Medusa backend, the following algorithm **must** be used inside the POS state (`posStore.ts` and `computeEffectivePrice` payload builders):

1. **Calculate Cents:** All calculations must convert the base unit price to cents first (`Math.round(price * 100)`).
2. **Line Discounts (Unit-Level Rounding):** Line discounts apply directly to the unit price in cents. Round the result of `(unitPriceCents * discountRate)`, then multiply by `quantity`. Calculate `lineAfterLineDiscountCents`.
3. **Order Discounts (Line-Level Rounding):** The total global order discount (e.g. 5%) is applied proportionally to each item's `lineAfterLineDiscountCents` total. Calculate `Math.round(lineAfterLineDiscountCents * orderDiscountRate)`. Accumulate all these rounded values to get the global `orderDiscountTotalCents`.
4. **Tax Calculation (Aggregate Level):** Tax is applied implicitly on the aggregate taxable total after all discounts are deducted. `taxableAmountCents = afterLineDiscountsSubtotalCents - orderDiscountTotalCents`. Then `Math.round(taxableAmountCents * taxRate)`.
5. **Divisor:** Sum the final cents and divide by `100` at the very end to yield the exact POS display values and payload targets.

Failure to follow this exact order of rounding (or using floating-point `toFixed()` mid-calculation) will lead to 1-2 cent discrepancies against the Medusa backend.

---

## 6. Endpoints de Soporte (`lib/invoices.ts`)

La interacción entre el Store POS y la base de datos para la generación de PDFs y abonos de las Facturas usa llamadas directas usando la layer `medusaFetch`:

- `GET /admin/invoices?order_id={id}`: Retorna el arreglo de facturas atadas a una órden específica.
- `POST /admin/invoices`: Genera una nueva factura tomando el current payload de items y subtotales.
- `POST /admin/invoices/{id}/payments`: Permite registrar un abono parcial (ej. $50 Cash, $200 Card), actualizando el `amount_paid` y `balance_due` matemáticamente en el servidor y estampándolo en la tirilla u hoja PDF de Invoices en tiempo real.
- `POST /admin/invoices/{id}/void`: Destruye el balance y marca el snapshot como inválido.

---

## 7. Dashboard de Invoices (`/invoices`)

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
| Status | `inv.status` — badge: `draft`=gris, `issued`=azul, `partial`=ámbar, `paid`=verde, `voided`=rojo |
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

## Changelog — Marzo 20, 2026

### Multi-Payments y Store Credits en el UI de Invoices

**Problema:**
Previamente la tabla principal de Invoice List y la vista detallada Invoice Receipt intentaban deducir el "Payment Method" asumiendo que un Invoice recibía un sólo pago global, lo cual fallaba si el cliente usaba 50% Cash y 50% Store Credit. Adicionalmente, el `CompleteOrderModal` permitía ingresar montos aleatorios superiores a la deuda en "Cash" causando desajustes contables.

**Solución Implementada:**
1. **Recorte Dinámico de Inputs (Cap):** Las barras de Cash / Card de todos los UI limits (CompleteOrder, CapturePayment) ahora están limitadas lógicamente por un `requiredCashCents`. Si la orden totaliza $1000 y el usuario selecciona $200 de crédito a favor, las cajas limitarán la escritura de montos externos a máximo $800, y los botones de "%" calcularán base a los $800 restantes. 
2. **Display Compuesto por Transactions:**
   - Si un Invoice recibe fondos de más de 1 fuente, la columna de listado `/invoices` ahora renderizará `Mixed` u `Other` en el badge de Payments para protegerse.
   - En la vista individual `[/id]`, el array de `payment_applications` se mapea renderizando renglones detallados de "Store Credit Application - ID", así como "Deposit Application" en verde antes de totalizar el gran Total.
   - Al estar unificados bajo un `transaction_id`, el Invoice puede navegar hacia el recibo transaccional de `/transactions/:id` detallando el origen genésico de los fondos y en cuales otras facturas impactaron dichos fondos al mismo tiempo.

---

## Changelog — Marzo 18, 2026

### Nueva estructura de columnas en `/invoices`

**Antes:** Invoice # | QB Ref # | Order # | Date | Status | Payment | Items | Total | Balance | QB Sync

**Ahora:** Invoice # | QB Ref # | Date | Customer | Company | Email | Status | Payment | Total | Balance | QB Sync

**Cambios:**
- ✅ Añadidas columnas **Customer**, **Company**, **Email** (datos del order padre via batch-fetch)
- ❌ Eliminada columna **Order #** (formato UUID no human-friendly)
- ❌ Eliminada columna **Items** (recuento de ítems no relevante a nivel lista)
- `font-semibold` removido del Invoice # (ahora solo `font-mono`)
- QB Sync usa íconos `Check`/`X` (Lucide) en lugar de texto `Yes`/`No`

### Navegación al detalle al crear Invoice

Al completar una orden y generar un invoice desde el `CompleteOrderModal`, el `onSuccess` callback ahora recibe el invoice creado y navega automáticamente a `/invoices/${invoice.order_id}`.

```ts
onSuccess={(invoice) => {
    setCompleteOrderModalOpen(false)
    refetchInvoices()
    order.router.push(`/invoices/${invoice.order_id}`)
}}
```

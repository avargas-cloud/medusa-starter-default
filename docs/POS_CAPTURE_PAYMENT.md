# POS_CAPTURE_PAYMENT — Recibir Pagos y Aplicar Créditos

| Campo | Detalle |
|-------|---------|
| **Módulo** | Capture Payment / Receive Payment |
| **Componente principal** | `components/pos/CapturePaymentModal.tsx` |
| **Página standalone** | `app/(pos)/payments/new/page.tsx` |
| **Última revisión** | 2026-03-20 |

---

## Evolución de Arquitectura (Marzo 2026)

El módulo de recepción de pagos fue reescrito para abandonar la antigua tabla aislada `customer_credit_ledger` y unificarse bajo la entidad universal `CustomerPayment` (Módulo de Finanzas). Hoy en día, **un "Pagar" o "Recibir Abono" puede derivar en múltiples transacciones simultáneas**, orquestadas cuidadosamente por el Frontend y agrupadas backend-side por un `transaction_id`.

## Contexto Dual: Orders vs. Invoices

El `CapturePaymentModal` en el POS ya no es genérico. Se bifurca rígidamente en dos flujos según desde dónde se invoque:

### 1. Contexto de Invoice (`invoiceId` presente)
Cuando el usuario presiona "Payment" desde una Factura específica (`/invoices/[id]`):
- **Objetivo:** Salgar/Liquidar el `balance_due` exacto de la factura.
- El usuario puede **mezclar** fondos: tomar $50 de un Store Credit existente, y poner $150 de una Tarjeta de Crédito nueva.
- **Acciones Backend:**
  - Para los créditos usados: Múltiples lllamadas a `POST /admin/finance/payments/:credit_id/apply` (pasando `invoice_id`).
  - Para el efectivo/tarjeta: Una llamada a `POST /admin/invoices/:invoice_id/payments` para crear y asentar el abono directo a la factura.
  - Todas estas llamadas comparten el mismo `metadata.transaction_id`, formando una "Transaction" consolidada.

### 2. Contexto de Order (`orderId` presente, SIN `invoiceId`)
Cuando el usuario presiona "Receive Payment" desde una Orden en vuelo (ej. un Sales Order que aún no se ha despachado ni facturado):
- **Objetivo:** Recibir un **Depósito Genérico** (Downpayment) que vivirá como saldo a favor del cliente hasta que las facturas nazcan.
- El Modal **oculta** la zona de "Aplicar Store Credits", porque no se puede aplicar un crédito viejo a un depósito sin factura. Solo habilita cobrar dinero físico (Cash/Card/ACH).
- **Acciones Backend:**
  - Una llamada a `POST /admin/finance/payments` para crear un nuevo `CustomerPayment` con `status: 'available'`.
  - Este depósito quedará en la cuenta del cliente esperando ser aplicado a los Invoices que nazcan eventualmente cuando el staff "Fulfill Items".

---

## Layout del Modal de Pagos (Invoice Mode)

Cuando el modal opera contra un Invoice, dibuja un Layout Split-Screen masivo:

### Columna Izquierda (New Payment Method)
- **Recorte Automático (Capping):** La caja de monto (`$`) vigila permanentemente los créditos que elijas. Si la deuda es $500, y eliges usar $100 de crédito viejo, la caja de monto de tarjeta **se limita matemáticamente a $400**.
- **Presets de Porcentaje:** Botones rápidos de "25%", "50%", "Full" que calculan automáticamente sobre la porción descubierta de la deuda.
- **Métodos nativos:** Cash, Visa, Amex, ACH, Zelle, Check, etc.
- Referencias (`1234` last digits, check number, etc).

### Columna Derecha (Store Credit Selection)
- Esta columna lanza un `useQuery` de React contra `GET /admin/finance/payments?customer_id=...&status[]=available&status[]=partially_applied`.
- Dibuja una **Data Table** con todos los abonos huérfanos del cliente.
- El cajero hace click en los *Checkboxes* de cada crédito. 
- Al seleccionar uno, el sistema arrastra secuencialmente saldo de ese crédito hasta saciar el `balance_due` del Invoice. Si el crédito es más grande que la factura, el sistema deduce y alerta que sobrará saldo disponible.

---

## Modalidad Standalone (`/payments/new`)

La ruta solitaria de "New Payment" (accesible desde el Ticker verde global o el Sidebar) ya no apunta órdenes. Permite:
1. Buscar ágilmente a un cliente mediante MeiliSearch.
2. Ingresar un monto "Crudo" que el cliente entrega (ej. Cheque de $10,000 en ventanilla).
3. Genera un `CustomerPayment` con estado `available`.
4. Deriva al usuario a la vista de Recibo Transaccional `/transactions/:id` listando el cheque recibido.

---

## Flujo Lógico Transaccional (`handleCapture`)

El pseudocódigo simplificado pero estrictamente veraz de lo que ocurre al presionar `Capture`:

```typescript
const transactionId = newDocId('txn_')

const transactionMetadata = {
   transaction_id: transactionId,
   transaction_type: 'checkout_event',
   origin_pos: true,
}

// 1. Array Promise — Agota todos los Store Credits seleccionados 
await Promise.all(
   selectedCredits.map(credit => 
       medusaFetch(`/admin/finance/payments/${credit.payment_id}/apply`, {
           method: 'POST',
           body: {
               invoice_id: invoiceId,
               amount: credit.amount_to_consume,
               metadata: transactionMetadata
           }
       })
   )
)

// 2. Ejecuta el salto "New Money" si hace falta efectivo o tarjeta
if (requiredNewMoney > 0) {
   if (invoiceId) {
       // Salda la factura directo
       await medusaFetch(`/admin/invoices/${invoiceId}/payments`, {
           method: 'POST',
           body: {
               amount: requiredNewMoney,
               method: selectedMethod,
               metadata: transactionMetadata
           }
       })
   } else {
       // Generic deposit aleteando
       await medusaFetch(`/admin/finance/payments`, {
           method: 'POST',
           body: {
               customer_id: customerId,
               amount: requiredNewMoney,
               status: 'available',
               metadata: transactionMetadata
           }
       })
   }
}
```

## Known Issues Resueltos en Marzo 20
- **Fuga Contable de Efectivo:** El usuario ya no puede escribir manualmente más dinero en efectivo del que debe la factura, logrando que los contadores no tengan que revertir desbarajustes manuales en el Checkout.
- **Piso de Créditos Nulos:** Se prohibió arranchar créditos de montos nulos ($0) hacia un Invoice, limpiando los payloads 400 Bad Request.
- **Doble Origen de Pagos:** Se migró exitosamente del `customer_credit_ledger` al estándar de ERP universal (Facturas cruzadas con Depósitos) previniendo esquemas Ponzis en los saldos.

# Guía Definitiva: Void Invoices & Surgical Rollback en el ecosistema POS de Medusa v2

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

## 2. Archivos Clave en el Repositorio

Si necesitas editar, expandir o debuggear el proceso de Void, estos son los archivos absolutos donde ocurre la magia en la aplicación `ecopowertech-workspace`:

| Entorno | Archivo Clave | Propósito Principal |
|---------|-----------------|---------------------|
| **Backend** | `backend/src/api/admin/invoices/[id]/void/route.ts` | El cerebro de la operación. Ejecuta SQL crudo y APIs nativas de DML para anular la orden entera. |
| **Backend** | `backend/src/modules/finance/models/payment-application.ts` | Modelo que une depósitos matemáticos (`CustomerPayment`) a Invoices específicos. |
| **Frontend** | `ecopowertech-store-pos/components/pos/payments/CreditStatement.tsx` | El componente del UI que reconstruye la historia visual de la transferencia de dinero. |
| **Frontend** | `ecopowertech-store-pos/app/(pos)/invoices/[id]/page.tsx` | Renderiza la factura visual. Alberga el botón de acción global de `Void`. |

---

## 3. Algoritmo Paso-a-Paso del Endpoint (Backend)

Ruta: `backend/src/api/admin/invoices/[id]/void/route.ts`

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

### E. Desenlace Financiero y "DML Payload Quirks"
Por último el script debe desligar los fondos del pago para que queden disponibles en el perfil del Customer.

**Medusa v2 Bug Documentado**: 
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

## 4. Frontend Visual "Tracer Ledger"

Los desarrolladores asumen usualmente que las filas con `voided_at` en la base de datos deben ser ignoradas y borradas de la Interfaz Visual. Sin embargo, para la contabilidad, el dinero que se retira y se regresa **debe quedar registrado visualmente**.

Archivo: `ecopowertech-store-pos/components/pos/payments/CreditStatement.tsx`

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

# Checkout Currency & Display Fixes

## Fecha
2026-02-24

## Resumen

Cuatro bugs relacionados fueron identificados y corregidos en el flujo de checkout/cart:
1. Shipping mostrado como $3,499 en Medusa Admin (precio en centavos en vez de dólares)
2. Authorize.net cobraba $0.77 en vez de $76.76 (dividir dólares por 100)
3. Order Detail page mostraba total $77.81 (double-counting de shipping tax)
4. Cart drawer no abría al agregar el primer item a un carrito vacío

---

## Bug 1: Shipping Price en Admin — $3,499 en vez de $34.99

### Causa
`calculatePrice` en ambos providers retornaba el valor en **centavos** (como lo guarda la BD),
pero Medusa espera que `calculatePrice` retorne **dólares**.

### Archivos
- `backend/src/modules/ground-shipping/service.ts`
- `backend/src/modules/ups-ground-shipping/service.ts`

### Fix
```typescript
// ❌ Antes: retornaba centavos directamente
return { calculated_amount: priceCents, ... }  // 3499 → Medusa admin: $3,499

// ✅ Después: divide por 100 para retornar dólares
const priceDollars = priceCents / 100
return { calculated_amount: priceDollars, ... }  // 34.99 → Medusa admin: $34.99
```

---

## Bug 2: Authorize.net cobraba $0.77 en vez de $76.76

### Causa
El servicio de Authorize.net dividía el `amount` de la sesión de pago por 100, asumiendo que
era centavos. En Medusa v2, **todos los montos son dólares** (ej. `76.7618`).

Resultado: `76.7618 / 100 = $0.7676 ≈ $0.77` ❌

### Archivo
`backend/src/modules/authorize-net/service.ts` — métodos `capturePayment` y `refundPayment`

### Fix
```typescript
// ❌ Antes: dividía por 100 asumiendo centavos
const amountDollars = (amountSource / 100).toFixed(2)  // $0.77

// ✅ Después: usa el valor directamente (ya es dólares)
const amountDollars = Number(amountSource).toFixed(2)  // $76.76
```

### Regla general
> En Medusa v2, los campos `cart.total`, `cart.shipping_subtotal`, `cart.tax_total`,
> y `payment_session.data.amount` son siempre en **dólares**.
> Authorize.net también espera dólares. **No dividir por 100.**

---

## Bug 3: Authoritative Cart Total — listCarts vs Store API

### Causa
`cartModule.listCarts()` retornaba totales stale (antes de aplicar shipping).

### Fix
Reemplazado con llamada al Store API después de aplicar el shipping:
```typescript
const res = await fetch(`${MEDUSA_BACKEND_URL}/store/carts/${cartId}`, {
  headers: { 'x-publishable-api-key': PUBLISHABLE_API_KEY }
})
const { cart: cartData } = await res.json()
// cartData.total es el total autoritativo en dólares (ej. 76.7618)
```

### Archivo
`backend/src/api/store/fast-checkout/route.ts`

---

## Bug 4: Order Detail — Total $77.81 en vez de $76.76

### Causa
La página de Order Detail usaba `order.shipping_total` ($16.04 = base + shipping tax),
mientras que `order.tax_total` ($5.02) **ya incluye** el tax del shipping → double count de $1.05.

```
$56.75 + $16.04 + $5.02 = $77.81  ❌  (double-count del shipping tax — era el bug)
$56.75 + $14.99 + $5.02 = $76.76  ✅  (fórmula correcta cuando shipping sí era gravado)
```

> ⚠️ **Nota 2026-03-06:** Los valores anteriores ($5.02 tax) reflejan la configuración
> cuando el shipping estaba gravado al 7%. Desde 2026-03-06, el shipping está exento:
> `tax_total` solo cubre items. Ejemplo actual: $56.75 + $14.99 + $3.97 = $75.71

### Fix
```typescript
// ❌ Antes
const shippingDollars = Number(order.shipping_total || 0)  // $16.04

// ✅ Después
const shippingDollars = Number(order.shipping_subtotal ?? order.shipping_total ?? 0)  // $14.99
const totalDollars = Number(order.total || 0)  // desde Medusa directamente
```

### Archivos
- `frontend/src/components/account/OrderDetail.tsx`
- `frontend/src/pages/api/customers/order-details.ts` — agregado `shipping_subtotal` a `DETAIL_FIELDS`

### Referencia: shipping_subtotal vs shipping_total

| Campo | Valor (2026-02-24) | Qué incluye |
|-------|-------|-------------|
| `shipping_subtotal` | $14.99 | Solo el costo base del envío |
| `shipping_total` | $16.04 | Base + shipping tax ($1.05 @ 7% FL) |

> ⚠️ **Actualización 2026-03-06:** El shipping ya NO está gravado. Desde esa fecha,
> `shipping_total = shipping_subtotal` (ambos = $14.99). El `tax_total` cubre solo items.
> Siempre mostrar `shipping_subtotal` en la UI. Shipping exento por `tax_rate_rule`.

---

## Bug 5: Cart Drawer no abría al primer item

### Causa
El evento `ept:cart-updated` (que abre el drawer) solo se disparaba en el branch
`else if (previousCart)` del optimistic update — que no se ejecuta cuando el cart está vacío.

### Fix
```typescript
// cartStore.ts — después de que apiAddToCart tiene éxito:
if (!product.silent && !previousCart) {
  // Cart estaba vacío — disparar aquí ya que el optimistic branch fue saltado
  window.dispatchEvent(new CustomEvent('ept:cart-updated', { detail: { action: 'add' } }));
}
```

### Archivo
`frontend/src/features/cart/stores/cartStore.ts`

---

## Checkout Display Logic (CheckoutLayout.tsx)

La pantalla de checkout calcula y muestra los totales client-side usando `checkoutStore`,
ya que `medusaCart` puede no estar disponible hasta que fast-checkout termina.

### Tax en FL (Actualizado 2026-03-06: Shipping Exento)

Florida aplica 7% de tax sobre **items solamente** — shipping excluido del tax base:

```typescript
// CheckoutLayout.tsx (actualizado 2026-03-06):
const FL_TAX_RATE = 0.07
const taxableBase = subtotal   // shipping NO entra en la base
const tax = taxableBase * FL_TAX_RATE
```

Backend: `tax_rate_rule` atado a `product_type` únicamente. Shipping methods = $0 tax.
See `CHECKOUT_PAYMENT_IMPLEMENTATION_GUIDE.md` → "Florida Tax" section.

---

## Bug 6: Promotion Discount Inflated on Draft Orders (2026-03-13)

### Síntoma
`google-review` 5% aparecía como $18.60 en Medusa admin pero el POS calculaba $17.38
(diferencia siempre = factor de ~1.07 = FL tax rate).

### Causa raíz
`addDraftOrderPromotionWorkflow` crea `ITEM_ADJUSTMENTS_REPLACE` actions que al confirmarse
**añaden** nuevos `order_line_item_adjustment` records sin soft-delete los anteriores.
Después de múltiples `apply-existing`, cada item acumula N adjustment records.
Medusa suma TODOS al calcular `discount_total`, inflando el valor mostrado.

```
Ejemplo: 4000K item ($46.13) tenía 4 adjustment records:
  $2.5625 + $2.5625 + $2.5625 + $2.3065 = $10.00 (¡debería ser solo $2.3065!)
```

### Regla general - Promotions en Draft Orders
> - Las promotions se aplican sobre `item.subtotal = unit_price × quantity` (pre-tax)
> - `is_tax_inclusive: false` (todos los promotions del POS deben tenerlo así)
> - Cada `apply-existing` acumula adjustments → siempre limpiar después de confirmar

### Fix (2026-03-13)
1. **`apply-existing/route.ts` Step 5**: después de `confirmDraftOrderEditWorkflow`,
   soft-delete los adjustment records duplicados manteniendo solo el más reciente por item.
2. **`pos-discount/route.ts`**: `is_tax_inclusive: false` en `createPromotionsWorkflow`.
3. **`apply-existing/route.ts` Step 0**: asegura `is_tax_inclusive: false` antes de aplicar.

### Archivos
- `backend/src/api/admin/pos-discount/apply-existing/route.ts`
- `backend/src/api/admin/pos-discount/route.ts`

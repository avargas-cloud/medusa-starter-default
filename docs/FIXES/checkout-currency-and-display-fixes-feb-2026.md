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
$56.75 + $16.04 + $5.02 = $77.81  ❌  (shipping tax contado dos veces)
$56.75 + $14.99 + $5.02 = $76.76  ✅  (shipping_subtotal sin tax)
```

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

| Campo | Valor | Qué incluye |
|-------|-------|-------------|
| `shipping_subtotal` | $14.99 | Solo el costo base del envío |
| `shipping_total` | $16.04 | Base + shipping tax ($1.05 @ 7% FL) |

Siempre mostrar `shipping_subtotal` en la UI. `tax_total` ya cubre el tax del shipping.

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

### Tax en FL (F.S. 212.02)
Florida aplica 7% de tax sobre **items + shipping**:
```typescript
const FL_TAX_RATE = 0.07
const taxableBase = subtotal + shippingCost  // shipping incluido en la base
const tax = taxableBase * FL_TAX_RATE
```

Esto coincide con el cálculo de Medusa backend (configurado por tax region `us-fl`).

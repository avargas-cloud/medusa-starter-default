# MEDUSA_AMOUNTS — Guía Definitiva de Montos

> **La fuente de verdad para todos los montos ($$$) en el sistema EcoPowerTech.**
> Consulta este documento ANTES de escribir cualquier línea que toque precios, totales, subtotales o cantidades monetarias.

---

## La Regla de Oro: TODO en DÓLARES

**Medusa v2 almacena y devuelve TODOS los montos en DÓLARES (float).**

| Monto real | Representación en Medusa |
|-----------|--------------------------|
| $1.41 | `1.41` |
| $51.00 | `51` o `51.0` |
| $273.99 | `273.99` |
| $0.00 | `0` |
| $100.00 | `100` |

---

## Resumen Rápido por Zona

| Zona | Formato | Ejemplo de $273.99 | Notas |
|------|---------|-------------------|-------|
| **DB `price.amount`** | DÓLARES (numeric) | `273.99` | Lo que insertas = lo que ves |
| **Admin API (read)** | DÓLARES (float) | `273.99` | `/admin/orders`, `/admin/draft-orders` |
| **Admin API (write)** | DÓLARES (float) | `{ unit_price: 273.99 }` | Siempre dólares |
| **Store API (read)** | DÓLARES (float) | `273.99` | `/store/carts`, `/store/orders` |
| **Store API (write)** | DÓLARES (float) | `{ unit_price: 273.99 }` | Igual |
| **QB Bridge (input)** | DÓLARES (float) | `{ price: 273.99 }` | Backend → bridge |
| **QB QBXML (output)** | DÓLARES (decimal) | `<Amount>273.99</Amount>` | QB Desktop recibe ✅ |
| **Payment Gateway** | **CENTAVOS** (integer) | `27399` | ⚠️ ÚNICA excepción — Authorize.net, Stripe |
| **POS Frontend** | Usar `formatMoney()` | `formatMoney(273.99)` → `$273.99` | No dividir por 100 |

---

## ⚠️ Única Excepción: Payment Gateway

El único lugar donde se convierten dólares a centavos es para el **gateway de pago**:

```ts
// fast-checkout/route.ts
const storeTotalDollars = cartData.total          // 273.99 (dólares — Admin/Store API)
const amountCents = Math.round(storeTotalDollars * 100)  // 27399 (centavos — para Authorize.net)
```

**En ningún otro lugar se debe multiplicar × 100 o dividir ÷ 100.**

---

## Admin API — Lee en DÓLARES

```ts
// GET /admin/orders/:id
{
  total:          273.99,  // $273.99
  subtotal:       250.00,  // $250.00
  tax_total:       23.99,  // $23.99
  shipping_total:   0.00,  // $0.00
  items: [{
    unit_price:   273.99,  // $273.99 por unidad
    quantity:          1,
  }]
}
```

**Regla de conversión:**
```ts
// ✅ Para MOSTRAR en UI:
formatMoney(order.total)          // 273.99 → "$273.99"

// ✅ Para CALCULAR:
const lineTotal = item.unit_price * item.quantity   // 273.99 * 2 = 547.98

// ❌ NUNCA:
order.total / 100                 // → $2.74 (INCORRECTO — 100x menos)
formatMoney(order.total / 100)    // → "$2.74" (INCORRECTO)
```

---

## Admin API — Escribe en DÓLARES

```ts
// POST /admin/draft-orders
{
  items: [{
    unit_price: 273.99,  // $273.99 — en dólares
    quantity: 2,
  }]
}
```

---

## QuickBooks Bridge — Recibe DÓLARES

```ts
// Backend → QB Bridge
{
  items: [{
    price: 273.99,     // ✅ DÓLARES — QB interpreta como $273.99
    quantity: 2,
    // ❌ NO enviar 27399 — QB interpretaría $27,399
  }]
}

// QB QBXML output:
// <Amount>547.98</Amount>   (price * qty en dólares)
```

---

## `formatMoney()` — Úsala con todos los montos del API

```ts
// lib/utils.ts — ya corregida
export function formatMoney(amount: number, currency = 'USD'): string {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
        minimumFractionDigits: 2,
    }).format(amount)   // sin dividir por 100
}
```

**Úsala con CUALQUIER monto del Admin o Store API:**
```ts
formatMoney(order.total)              // ✅ "$273.99"
formatMoney(item.unit_price)          // ✅ "$51.00"
formatMoney(order.tax_total)          // ✅ "$23.99"
formatMoney(item.unit_price * qty)    // ✅ "$547.98"
```

---

## Base de Datos — `price.amount`

```sql
-- ✅ CORRECTO — $273.99 en dólares
INSERT INTO price (amount, currency_code) VALUES (273.99, 'usd');

-- Verificar precios:
SELECT amount, amount AS dollars, currency_code
FROM price
WHERE currency_code = 'usd'
ORDER BY amount DESC;
```

---

## Fórmulas de Conversión

```ts
// Admin/Store API → Display (no conversion needed)
formatMoney(273.99)                      // "$273.99" ✅

// Para calcular totales de línea:
const lineTotal = unit_price * quantity   // 273.99 * 2 = 547.98

// Para el payment gateway ÚNICAMENTE:
const cents = Math.round(dollars * 100)   // 273.99 → 27399
```

---

## Checklist Anti-Bug

- [ ] **¿Estás mostrando un monto?** → `formatMoney(amount)` — sin dividir
- [ ] **¿Estás mandando a QB bridge?** → Dólares directamente — sin multiplicar
- [ ] **¿Estás mandando al payment gateway?** → `Math.round(amount * 100)` — única conversión válida
- [ ] **¿Ves precios 100x pequeños?** → Tienes un `/100` de más
- [ ] **¿QB muestra precios 100x grandes?** → Tienes un `*100` de más

---

## Ejemplo Completo: Flujo de Venta POS

```
DB price.amount:        273.99          ($273.99 — dólares)
                           ↓
Admin API responde:     unit_price = 273.99
                           ↓
POS muestra:            formatMoney(273.99) = "$273.99"  ✅
                           ↓  (sin conversión)
QB Bridge recibe:       price = 273.99
                           ↓
QB QBXML:               <Amount>273.99</Amount>          ✅
QB Desktop muestra:     $273.99                          ✅
                           ↓  (* 100 — solo para gateway)
Payment gateway:        amount = 27399 centavos          ✅
Cargo en tarjeta:       $273.99                          ✅
```

---

*Última actualización: 2026-03-06*
*Corrección: Admin API devuelve DÓLARES — no centavos. formatMoney ya no divide por 100.*

# Dev — Medusa Amounts
> **Tipo**: Technical Reference
> **Repo**: backend
> **Ultima verificacion**: 2026-04-02
> **Estado**: Current

> La fuente de verdad para todos los montos ($$$) en el sistema EcoPowerTech.
> Consulta este documento ANTES de escribir cualquier linea que toque precios, totales, subtotales o cantidades monetarias.

---

## La Regla de Oro: TODO en DOLARES

**Medusa v2 almacena y devuelve TODOS los montos en DOLARES (float).**

| Monto real | Representacion en Medusa |
|-----------|--------------------------|
| $1.41 | `1.41` |
| $51.00 | `51` o `51.0` |
| $273.99 | `273.99` |
| $0.00 | `0` |

---

## Resumen Rapido por Zona

| Zona | Formato | Ejemplo de $273.99 | Notas |
|------|---------|-------------------|-------|
| **DB `price.amount`** | DOLARES (numeric) | `273.99` | Lo que insertas = lo que ves |
| **Admin API (read)** | DOLARES (float) | `273.99` | `/admin/orders`, `/admin/draft-orders` |
| **Admin API (write)** | DOLARES (float) | `{ unit_price: 273.99 }` | Siempre dolares |
| **Store API (read)** | DOLARES (float) | `273.99` | `/store/carts`, `/store/orders` |
| **Store API (write)** | DOLARES (float) | `{ unit_price: 273.99 }` | Igual |
| **QB Bridge (input)** | DOLARES (float) | `{ price: 273.99 }` | Backend → bridge |
| **QB QBXML (output)** | DOLARES (decimal) | `<Amount>273.99</Amount>` | QB Desktop recibe correcto |
| **shipping_settings table** | **CENTAVOS** (integer) | `27399` | UNICA excepcion no-gateway |
| **Payment Gateway** | **CENTAVOS** (integer) | `27399` | Authorize.net, Stripe |
| **POS Frontend** | Usar `formatMoney()` | `formatMoney(273.99)` → `$273.99` | No dividir por 100 |

---

## Excepciones (donde SI se usan centavos)

### 1. Payment Gateway (Authorize.Net, Stripe)

```typescript
// fast-checkout/route.ts
const storeTotalDollars = cartData.total           // 273.99 (dolares)
const amountCents = Math.round(storeTotalDollars * 100)  // 27399 (centavos)
```

### 2. Tabla shipping_settings

Los campos `free_shipping_minimum`, `regular_ground_shipping_price`, y `long_item_ground_shipping_price` estan en **centavos**. Esta es la unica tabla custom del sistema que usa centavos.

```typescript
// ground-shipping/service.ts
const priceCents = settings.regular_ground_shipping_price  // 1499 (centavos)
const priceDollars = priceCents / 100                      // 14.99 (dolares)
// calculatePrice debe retornar dolares
return { calculated_amount: priceDollars, ... }
```

**En ningun otro lugar se debe multiplicar x100 o dividir /100.**

---

## Admin API — Lee en DOLARES

```typescript
// GET /admin/orders/:id
{
  total:          273.99,  // $273.99
  subtotal:       250.00,  // $250.00
  tax_total:       23.99,  // $23.99
  shipping_total:   0.00,
  items: [{
    unit_price:   273.99,  // $273.99 por unidad
    quantity:          1,
  }]
}

// ✓ Para mostrar en UI:
formatMoney(order.total)           // 273.99 → "$273.99"

// ✓ Para calcular:
const lineTotal = item.unit_price * item.quantity  // 273.99 * 2 = 547.98

// ✗ NUNCA:
order.total / 100                  // → $2.74 (INCORRECTO — 100x menos)
```

---

## QuickBooks Bridge — Recibe DOLARES

```typescript
// Backend → QB Bridge
{
  items: [{
    price: 273.99,     // ✓ DOLARES — QB interpreta como $273.99
    quantity: 2,
    // ✗ NO enviar 27399 — QB interpretaria $27,399
  }]
}

// QB QBXML output:
// <Amount>547.98</Amount>   (price * qty en dolares)
```

---

## formatMoney() — Usar con todos los montos del API

```typescript
// lib/utils.ts
export function formatMoney(amount: number, currency = 'USD'): string {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
        minimumFractionDigits: 2,
    }).format(amount)   // SIN dividir por 100
}

// Uso correcto:
formatMoney(order.total)              // ✓ "$273.99"
formatMoney(item.unit_price)          // ✓ "$51.00"
formatMoney(item.unit_price * qty)    // ✓ "$547.98"
```

---

## Base de Datos

```sql
-- ✓ CORRECTO — $273.99 en dolares
INSERT INTO price (amount, currency_code) VALUES (273.99, 'usd');

-- Verificar precios:
SELECT amount, currency_code FROM price WHERE currency_code = 'usd' ORDER BY amount DESC;
```

---

## Flujo Completo de Venta POS

```
DB price.amount:        273.99          ($273.99 — dolares)
                           |
Admin API responde:     unit_price = 273.99
                           |
POS muestra:            formatMoney(273.99) = "$273.99"  ✓
                           | (sin conversion)
QB Bridge recibe:       price = 273.99
                           |
QB QBXML:               <Amount>273.99</Amount>          ✓
QB Desktop muestra:     $273.99                          ✓
                           | (* 100 — solo para gateway)
Payment gateway:        amount = 27399 centavos          ✓
Cargo en tarjeta:       $273.99                          ✓
```

---

## Checklist Anti-Bug

- [ ] Mostrando un monto? → `formatMoney(amount)` sin dividir
- [ ] Mandando a QB bridge? → Dolares directamente, sin multiplicar
- [ ] Mandando al payment gateway? → `Math.round(amount * 100)` — unica conversion valida
- [ ] Ves precios 100x pequeños? → Tienes un `/100` de mas
- [ ] QB muestra precios 100x grandes? → Tienes un `*100` de mas
- [ ] Comparando con shipping_settings? → Esos son centavos — converter o comparar en la misma unidad

---

## Historial de Decisiones

- **2026-03-06:** Confirmado que Admin API devuelve DOLARES (no centavos). `formatMoney()` corregida para no dividir por 100. Correccion critica — antes de esta fecha el codigo incorrecto mostraba precios 100x menores.
- **shipping_settings en centavos**: Decision de diseño original. La tabla esta en centavos por conveniencia con calculos de comparacion de enteros. Los providers de shipping convierten a dolares antes de retornar `calculated_amount`.

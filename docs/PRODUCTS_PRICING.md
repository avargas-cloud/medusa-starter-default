# Products — Pricing System
> **Tipo**: Technical Reference
> **Repo**: backend
> **Última verificación**: 2026-04-02
> **Estado**: ✅ Current

---

## ¿Qué es y por qué existe?

Documenta el sistema de precios de productos en Medusa v2, incluyendo:
- Cómo leer precios desde el frontend (campo correcto, unidades, region context)
- El endpoint custom `/store/products/:id/prices-and-stock` para pricing dinámico con soporte wholesale
- Cómo configurar Price Lists y Customer Groups para precios por segmento
- El sistema de columnas dinámicas en Inventory Advanced

---

## CRÍTICO: Medusa v2 usa Major Units (Dólares)

| Versión | Representación de $10.00 |
|---------|--------------------------|
| v1 | `1000` (centavos) |
| **v2** | **`10`** (dólares) |

**NO dividas por 100 en v2.** Todo el código heredado de v1 que divide por 100 está roto.

---

## Arquitectura

### Esquema de precios en DB

```
product_variant
  └─► product_variant_price_set (junction)
       └─► price_set
            └─► price (múltiples filas)
                 ├─ WHERE price_list_id IS NULL     → Retail (precio base)
                 └─► WHERE price_list_id IN (list)  → Precio de lista (wholesale, etc.)
```

### Contexto de precios

Los precios calculados requieren **region_id** en el contexto. Sin este parámetro no hay `calculated_price`.

El módulo de pricing calcula en tiempo real usando `pricingModule.calculatePrices({ id: priceSetIds }, { context: pricingContext })` donde el contexto incluye `currency_code`, `region_id`, y opcionalmente `customer_group_id`.

---

## Leer Precios desde el Frontend (Store API)

### Producto individual

```typescript
const { product } = await fetch(
  `${MEDUSA_URL}/store/products/${productId}?region_id=${regionId}`,
  { headers: { 'x-publishable-api-key': PUBLISHABLE_KEY } }
).then(r => r.json())

// ✅ Campo correcto — ya en dólares
const price = variant.calculated_price.calculated_amount
const originalPrice = variant.calculated_price.original_amount
const currency = variant.calculated_price.currency_code
```

### Estructura del objeto `calculated_price`

```typescript
{
  calculated_amount: 43.48,           // Precio final (en dólares, con descuentos)
  original_amount: 43.48,             // Precio antes de descuentos
  currency_code: "usd",
  is_calculated_price_tax_inclusive: false,
  calculated_price: {
    money_amount_id: "...",           // ID interno
    // ... más detalles
  }
}
```

### Imágenes del producto

```typescript
// ✅ Campo correcto en Medusa v2
product.thumbnail          // URL de imagen principal
product.images[].url       // Array de imágenes adicionales
```

---

## Endpoint Dinámico: `/store/products/:id/prices-and-stock`

**Archivo:** `src/api/store/products/[id]/prices-and-stock/route.ts`

Este endpoint custom calcula precios en tiempo real incluyendo soporte para pricing wholesale basado en el customer group del usuario autenticado.

### Autenticación

Configurado con `authenticate("customer", ["session", "bearer"], { allowUnauthenticated: true })`:
- Guests: reciben precio retail
- Clientes autenticados con grupo Wholesale: reciben precio wholesale

**El frontend DEBE enviar Bearer token** para que wholesale funcione:

```typescript
const token = localStorage.getItem('medusa_auth_token')
const headers = { 'x-publishable-api-key': apiKey }
if (token) headers['Authorization'] = `Bearer ${token}`

const response = await fetch(`${backendUrl}/store/products/${productId}/prices-and-stock`, {
    headers,
    credentials: 'include'
})
```

### Lógica de pricing

1. Construye contexto base: `{ currency_code: "usd", region_id: "..." }`
2. Si `ENABLE_DYNAMIC_PRICING !== 'false'` y hay customerId: añade `customer_group_id` al contexto
3. Lee `store.metadata.non_wholesale_prefixes` para excluir SKUs con esos prefijos de wholesale (e.g., `["LEG"]`)
4. Llama a `pricingModule.calculatePrices` con el contexto completo

### Respuesta

```json
{
  "product_id": "prod_01xxx",
  "is_wholesale_customer": false,
  "variants": [
    {
      "variant_id": "variant_01xxx",
      "price": {
        "amount": 60.99,
        "formatted": "$60.99"
      },
      "inventory": {
        "available": 29,
        "in_stock": true
      }
    }
  ]
}
```

### Nota sobre SKUs legacy `LEG`

Productos con SKU prefijo `LEG` están **excluidos intencionalmente** de las listas de precios Wholesale. Si debugging precios y ves que un precio no cambia para un cliente B2B, verifica si el SKU empieza con `LEG`.

---

## Configurar Pricing por Segmento (Admin Setup)

### Paso 1: Crear Customer Groups

1. Medusa Admin → **Customers** → **Groups** → **Create Group**
2. Crear grupo `"Wholesale"` con description adecuada
3. Grupo "Retail" es opcional — customers sin grupo reciben precio default

### Paso 2: Crear Price Lists

1. **Pricing** → **Price Lists** → **Create Price List**
2. Configurar:
   - **Type**: `Override` (reemplaza precio default)
   - **Status**: `Active`
   - **Rule**: Customer Group = Wholesale
3. Agregar precios por variante (e.g., Retail $60.99 → Wholesale $45.99)

### Paso 3: Asignar Customers a Groups

En la página de cada customer, asignarlo al grupo "Wholesale".

### Resultado esperado

| Usuario | Precio mostrado |
|---------|----------------|
| Anónimo | $60.99 (retail) |
| `retail@test.com` (sin grupo) | $60.99 (retail) |
| `wholesale@test.com` (grupo Wholesale) | $45.99 (wholesale) |

---

## Columnas de Precio en Inventory Advanced

Ver `SEARCH_SYNC_ARCHITECTURE.md` → sección Inventory para detalles sobre `pricesByList` y la feature flag `ENABLE_DYNAMIC_PRICING`.

En resumen:
- `ENABLE_DYNAMIC_PRICING=true` → columnas dinámicas por price list en tabla de inventory
- `ENABLE_DYNAMIC_PRICING=false` → solo columna Retail Price
- El precio retail = máximo precio USD por variante (price_list_id IS NULL en la query)
- Fallback: si variante no tiene precio en un price list, muestra el retail en gris/italic

---

## Componente Frontend: ProductDynamicPricing

**Ruta:** `frontend/src/components/product/ProductDynamicPricing.tsx`

React component que hace fetch a `/store/products/:id/prices-and-stock` con skeleton loader:

```tsx
<ProductDynamicPricing
    client:load
    productId={product.id}
    showInventory={true}
/>
```

El componente:
- Muestra skeleton mientras carga
- Detecta rango de precios (min-max si hay variantes con precios diferentes)
- No divide por 100 — ya en dólares

---

## Reglas Críticas

1. **NO dividir por 100** — Medusa v2 usa major units (dólares)
2. **Siempre incluir `region_id`** en llamadas al Store API — sin él no hay `calculated_price`
3. **Usar `calculated_amount`**, no `amount` — `amount` es el precio bruto sin contexto
4. **Bearer token para wholesale** — las session cookies no son suficientes en todos los entornos
5. **`ENABLE_DYNAMIC_PRICING` requiere restart** para tomar efecto
6. **SKUs `LEG` excluidos de wholesale** — comportamiento intencional, no es bug
7. **Fetch-Merge-Write para metadata** — nunca sobrescribir metadata completa del producto

---

## Archivos Clave

| Tipo | Ruta Completa | Propósito |
|------|---------------|-----------|
| Store endpoint | `backend/src/api/store/products/[id]/prices-and-stock/route.ts` | Pricing dinámico con soporte wholesale |
| Store endpoint | `backend/src/api/store/products/[id]/with-prices/route.ts` | Endpoint alternativo con images + prices |
| Middleware auth | `backend/src/api/middlewares.ts` | Configura `allowUnauthenticated: true` para el endpoint |
| Feature flags | `backend/src/api/admin/config/features/route.ts` | `GET /admin/config/features` — expone `ENABLE_DYNAMIC_PRICING` y price lists |
| Frontend component | `frontend/src/components/product/ProductDynamicPricing.tsx` | Componente React con skeleton |
| Scripts | `backend/src/scripts/verify/verify-wholesale-pricing.ts` | Verificar pricing wholesale |
| Scripts | `backend/src/scripts/verify/verify-price-list-assignments.ts` | Verificar asignaciones de price lists |
| Scripts | `backend/src/scripts/verify/verify-customer-group.ts` | Verificar customer groups |

---

## Historial de Decisiones

| Fecha | Decisión | Razón |
|-------|----------|-------|
| 2026-02-01 | Endpoint `/prices-and-stock` en lugar de usar la Store API nativa | La Store API nativa no expone inventory ni permite lógica wholesale custom sin mucho trabajo |
| 2026-02-01 | `allowUnauthenticated: true` en el middleware del endpoint | Guests también necesitan ver precios; la autenticación es opcional para wholesale |
| 2026-02-10 | Bearer token además de session cookies | Session cookies no funcionan en todos los entornos, especialmente en dev con diferentes puertos |
| ~2026-01 | `non_wholesale_prefixes` en `store.metadata` | Externalizar la config de qué SKUs excluir de wholesale sin hardcodear |
| ~2026-02 | `ENABLE_DYNAMIC_PRICING` env flag | Permite desactivar columnas wholesale en entornos donde no aplica |

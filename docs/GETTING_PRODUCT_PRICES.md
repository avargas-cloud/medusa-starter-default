# Cómo Obtener Precios de Productos en Medusa v2

## ⚠️ IMPORTANTE: Medusa v2 usa Major Units (Dólares)
- **v1**: $10.00 se guardaba como `1000` (centavos)
- **v2**: $10.00 se guarda como `10` (dólares)
- **NO dividas por 100** en v2

---

## Para el FRONTEND (Storefront)

### Opción 1: Producto Individual

```javascript
const BACKEND_URL = import.meta.env.PUBLIC_MEDUSA_BACKEND_URL
const API_KEY = import.meta.env.PUBLIC_MEDUSA_PUBLISHABLE_KEY
const PRODUCT_ID = 'product_01XXX'
const REGION_ID = 'reg_01XXX'  // IMPORTANTE: Necesitas la región

const response = await fetch(
  `${BACKEND_URL}/store/products/${PRODUCT_ID}?regcuid=${REGION_ID}`,
  {
    headers: {
      'x-publishable-api-key': API_KEY
    }
  }
)

const { product } = await response.json()

// Acceder a precios CALCULADOS (con impuestos)
product.variants.forEach(variant => {
  const calculatedPrice = variant.calculated_price.calculated_amount  // Ya en dólares
  const originalPrice = variant.calculated_price.original_amount      // Antes de descuentos
  
  console.log({
    title: variant.title,
    sku: variant.sku,
    price: `$${calculatedPrice.toFixed(2)}`,           // NO dividir por 100
    originalPrice: `$${originalPrice.toFixed(2)}`
  })
})
```

### Opción 2: Usando SDK (Recomendado)

```javascript
import { sdk } from "./lib/sdk"  // Tu cliente Medusa SDK

async function getProductWithPrices(productId, regionId) {
  const { product } = await sdk.store.product.retrieve(
    productId,
    { region_id: regionId }  // CRÍTICO para calcular precios
  )
  
  return product.variants.map(variant => ({
    id: variant.id,
    title: variant.title,
    sku: variant.sku,
    price: variant.calculated_price.calculated_amount,  // En dólares
    currency: variant.calculated_price.currency_code
  }))
}

// Uso
const prices = await getProductWithPrices('product_01XXX', 'reg_01XXX')
```

### Opción 3: Múltiples Productos (Lista/Categoría)

```javascript
const response = await fetch(
  `${BACKEND_URL}/store/products?region_id=${REGION_ID}&id[]=${productId1}&id[]=${productId2}`,
  {
    headers: {
      'x-publishable-api-key': API_KEY
    }
  }
)

const { products } = await response.json()

products.forEach(product => {
  product.variants.forEach(variant => {
    console.log(`${variant.title}: $${variant.calculated_price.calculated_amount}`)
  })
})
```

---

## Ejemplo Completo: Componente Astro

```astro
---
// pages/product/[id].astro
const { id } = Astro.params
const regionId = 'reg_01KFKKNZQQS9RXDQX0JMVVK9HF'  // Tu región USD

const response = await fetch(
  `${import.meta.env.PUBLIC_MEDUSA_BACKEND_URL}/store/products/${id}?region_id=${regionId}`,
  {
    headers: {
      'x-publishable-api-key': import.meta.env.PUBLIC_MEDUSA_PUBLISHABLE_KEY
    }
  }
)

const { product } = await response.json()
---

<div>
  <h1>{product.title}</h1>
  
  {product.variants.map(variant => (
    <div class="variant">
      <h3>{variant.title}</h3>
      <p>SKU: {variant.sku}</p>
      <p class="price">
        ${variant.calculated_price.calculated_amount.toFixed(2)} 
        {variant.calculated_price.currency_code.toUpperCase()}
      </p>
      
      {variant.calculated_price.original_amount > variant.calculated_price.calculated_amount && (
        <p class="original-price">
          Original: ${variant.calculated_price.original_amount.toFixed(2)}
        </p>
      )}
    </div>
  ))}
</div>
```

---

## Variables de Entorno Necesarias

```env
# .env (Frontend)
PUBLIC_MEDUSA_BACKEND_URL=http://localhost:9000
PUBLIC_MEDUSA_PUBLISHABLE_KEY=pk_01KFKKNZQQS9RXDQX0JMVVK9HF
```

---

## Estructura del Objeto `calculated_price`

```typescript
{
  calculated_amount: 43.48,           // Precio final (con impuestos si aplica)
  original_amount: 43.48,             // Precio antes de descuentos
  currency_code: "usd",               // Moneda
  is_calculated_price_tax_inclusive: false,
  calculated_price: {
    money_amount_id: "...",
    // ... más detalles
  }
}
```

---

## ⚠️ Errores Comunes

### ❌ NO HAGAS ESTO:
```javascript
// INCORRECTO - No dividir por 100 en v2
const price = variant.calculated_price.calculated_amount / 100  // ❌
```

### ✅ CORRECTO:
```javascript
// CORRECTO - Ya está en dólares
const price = variant.calculated_price.calculated_amount  // ✅
```

### ❌ NO OLVIDES LA REGIÓN:
```javascript
// INCORRECTO - Sin region_id no habrá calculated_price
fetch(`/store/products/${id}`)  // ❌

// CORRECTO - Siempre incluye region_id
fetch(`/store/products/${id}?region_id=${regionId}`)  // ✅
```

---

## Para el Equipo Frontend

**Checklist**:
- [ ] Obtener `region_id` del contexto del usuario
- [ ] Incluir `region_id` en TODAS las llamadas a productos
- [ ] Usar `variant.calculated_price.calculated_amount` directamente
- [ ] NO dividir por 100
- [ ] Formatear con `.toFixed(2)` para mostrar 2 decimales

**Contacto**: Si necesitas ayuda, pregunta por el endpoint `/store/categories/:id/products-with-filters` que ya incluye precios calculados.

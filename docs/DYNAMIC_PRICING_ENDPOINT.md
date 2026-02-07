# Cómo Implementar Precios Dinámicos en Páginas de Producto

**Guía Paso a Paso para Nuevos Desarrolladores**  
**Última actualización**: 2026-02-07

---

## ¿Qué vamos a lograr?

Al final de esta guía, tendrás:
- ✅ Una página de producto que carga **super rápido** (HTML estático)
- ✅ Precios que **siempre están actualizados** (fetch dinámico)
- ✅ **Cache Redis** que hace todo 20x más rápido
- ✅ UI bonita con **skeleton loader** mientras carga

---

## Parte 1: Crear el Endpoint en el Backend

### Paso 1: Crear el archivo del endpoint

Crea este archivo:
```
backend/src/api/store/products/[id]/prices-and-stock/route.ts
```

### Paso 2: Copiar el código completo

```typescript
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { getCacheManager } from "../../../../../lib/cache-manager"

/**
 * Endpoint ligero para obtener SOLO precios e inventario
 * Diseñado para hidratación client-side de páginas SSG
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    try {
        const { id } = req.params

        // 🔥 PASO 1: Revisar si está en cache
        const cacheKey = `product:${id}:prices-stock`
        const cacheService = req.scope.resolve("cache")
        const cacheManager = getCacheManager(cacheService)

        const cached = await cacheManager.get<any>(cacheKey)
        if (cached) {
            console.log(`[PRICES-STOCK] 🎯 Cache HIT: ${cacheKey}`)
            return res.json(cached)
        }

        console.log(`[PRICES-STOCK] ❌ Cache MISS: ${cacheKey}`)
        
        // 🔥 PASO 2: Si no está en cache, buscar en la BD
        const knex = req.scope.resolve("__pg_connection__")

        // Obtener precios de variants
        const prices = await knex("price")
            .select(
                "price.amount",
                "price.currency_code",
                "product_variant_price_set.variant_id",
                "product_variant.title as variant_title",
                "product_variant.sku"
            )
            .join("product_variant_price_set", "price.price_set_id", "product_variant_price_set.price_set_id")
            .join("product_variant", "product_variant_price_set.variant_id", "product_variant.id")
            .where("product_variant.product_id", id)
            .where("price.currency_code", "usd")
            .whereNull("price.deleted_at")
            .whereNull("product_variant.deleted_at")

        // Obtener inventario
        const inventory = await knex("inventory_level")
            .select(
                "inventory_level.stocked_quantity",
                "inventory_level.incoming_quantity",
                "inventory_level.reserved_quantity",
                "product_variant_inventory_item.variant_id"
            )
            .join("product_variant_inventory_item", "inventory_level.inventory_item_id", "product_variant_inventory_item.inventory_item_id")
            .join("product_variant", "product_variant_inventory_item.variant_id", "product_variant.id")
            .where("product_variant.product_id", id)
            .whereNull("inventory_level.deleted_at")
            .whereNull("product_variant.deleted_at")

        // 🔥 PASO 3: Combinar precios e inventario
        const variantData = prices.map(p => {
            const inv = inventory.find(i => i.variant_id === p.variant_id)
            const availableQuantity = inv
                ? (inv.stocked_quantity || 0) - (inv.reserved_quantity || 0)
                : 0

            return {
                variant_id: p.variant_id,
                sku: p.sku,
                title: p.variant_title,
                price: {
                    amount: p.amount,
                    currency_code: p.currency_code,
                    // ⚠️ IMPORTANTE: Medusa v2 guarda precios como decimales, NO dividir por 100
                    formatted: `$${parseFloat(p.amount).toFixed(2)}`
                },
                inventory: {
                    available: availableQuantity,
                    stocked: inv?.stocked_quantity || 0,
                    incoming: inv?.incoming_quantity || 0,
                    reserved: inv?.reserved_quantity || 0,
                    in_stock: availableQuantity > 0
                }
            }
        })

        const responseData = {
            product_id: id,
            variants: variantData,
            timestamp: new Date().toISOString()
        }

        // 🔥 PASO 4: Guardar en cache por 5 minutos
        await cacheManager.set(cacheKey, responseData, 300)
        console.log(`[PRICES-STOCK] 💾 Guardado en cache: ${cacheKey}`)

        return res.json(responseData)

    } catch (error: any) {
        console.error("[PRICES-STOCK] ❌ Error:", error.message)
        return res.status(500).json({
            error: "Error al obtener precios",
            message: error.message
        })
    }
}
```

### Paso 3: Verifica que funcione

```bash
# Reemplaza "product_01XXX" con un ID real de tu tienda
curl -H "x-publishable-api-key: TU_API_KEY" \\
  "http://localhost:9000/store/products/product_01XXX/prices-and-stock"
```

**Deberías ver**:
```json
{
  "product_id": "product_01XXX",
  "variants": [
    {
      "price": {
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

✅ **Si ves eso, el endpoint funciona!**

---

## Parte 2: Crear el Componente React en el Frontend

### Paso 1: Crear el archivo del componente

Crea este archivo:
```
frontend/src/components/product/ProductDynamicPricing.tsx
```

### Paso 2: Copiar el código completo

```tsx
import React, { useEffect, useState } from 'react'

interface PricingData {
    product_id: string
    variants: Array<{
        variant_id: string
        price: {
            amount: string
            formatted: string
        }
        inventory: {
            available: number
            in_stock: boolean
        }
    }>
    timestamp: string
}

interface Props {
    productId: string
    showInventory?: boolean
    className?: string
}

export default function ProductDynamicPricing({ 
    productId, 
    showInventory = false,
    className = "" 
}: Props) {
    const [data, setData] = useState<PricingData | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(false)

    useEffect(() => {
        const fetchPricing = async () => {
            try {
                // Configuración del endpoint
                const backendUrl = (import.meta.env.PUBLIC_MEDUSA_BACKEND_URL || 'http://localhost:9000').replace(/\\/+$/, '')
                const apiKey = import.meta.env.PUBLIC_PUBLISHABLE_API_KEY

                // Hacer el fetch
                const response = await fetch(
                    `${backendUrl}/store/products/${productId}/prices-and-stock`,
                    {
                        headers: {
                            'x-publishable-api-key': apiKey,
                            'Content-Type': 'application/json'
                        },
                        credentials: 'include'
                    }
                )

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`)
                }

                const result = await response.json()
                setData(result)
                setLoading(false)
            } catch (err) {
                console.error('Error fetching pricing:', err)
                setError(true)
                setLoading(false)
            }
        }

        fetchPricing()
    }, [productId])

    // Mientras carga: Mostrar skeleton
    if (loading) {
        return (
            <div className={`pricing-skeleton ${className}`}>
                <div className="h-10 w-32 bg-slate-700 animate-pulse rounded"></div>
            </div>
        )
    }

    // Si hubo error
    if (error) {
        return (
            <div className={`pricing-error ${className}`}>
                <span className="text-red-600">Precio no disponible</span>
            </div>
        )
    }

    if (!data || data.variants.length === 0) {
        return null
    }

    // Calcular rango de precios (si hay diferentes precios)
    const prices = data.variants.map(v => parseFloat(v.price.amount.toString()))
    const minPrice = Math.min(...prices)
    const maxPrice = Math.max(...prices)
    const hasPriceRange = minPrice !== maxPrice

    const formatPrice = (amount: number) => `$${amount.toFixed(2)}`
    const priceDisplay = hasPriceRange 
        ? `${formatPrice(minPrice)} - ${formatPrice(maxPrice)}`
        : formatPrice(minPrice)

    return (
        <div className={`product-dynamic-pricing ${className}`}>
            {/* Precio en verde */}
            <div className="price-container">
                <span className="price text-3xl font-bold text-green-600">
                    {priceDisplay}
                </span>
                <span className="currency text-sm text-gray-400 ml-1">USD</span>
            </div>

            {/* Número de opciones */}
            {data.variants.length > 1 && (
                <div className="variant-count">
                    <span className="text-sm text-gray-400">
                        {data.variants.length} options available
                    </span>
                </div>
            )}

            {/* Stock está comentado - descomentar cuando se apruebe */}
            {/* {showInventory && (
                <div className="inventory-container mt-2">
                    <span className="text-green-700">
                        In Stock ({totalStock} available)
                    </span>
                </div>
            )} */}
        </div>
    )
}
```

### Paso 3: Agregar variables de entorno

En `frontend/.env`:
```env
PUBLIC_MEDUSA_BACKEND_URL=http://localhost:9000
PUBLIC_PUBLISHABLE_API_KEY=pk_tu_clave_aqui
```

---

## Parte 3: Usar el Componente en tu Página de Producto

### Paso 1: Importar el componente

En `frontend/src/components/product/ProductSummaryMedusa.astro`:

```astro
---
import ProductDynamicPricing from "./ProductDynamicPricing"
// ... otros imports
---

<div class="product-summary">
    <h1>{product.title}</h1>
    
    <!-- Precio dinámico con client:load para hidratación -->
    <div class="price-container mb-2">
        <ProductDynamicPricing 
            client:load
            productId={product.id}
            showInventory={true}
            className=""
        />
    </div>
    
    <!-- Resto del componente... -->
</div>
```

### Paso 2: ¡Listo! Pruébalo

1. Abre una página de producto en tu navegador
2. Deberías ver:
   - Un skeleton gris (1-2 segundos)
   - Luego el precio en **VERDE**
   - "3 options available" (si tiene múltiples variants)

---

## Cómo Funciona (Explicado Simple)

### Flujo Completo:

```
1. Usuario visita /product/led-strip
   ↓
2. Astro genera HTML estático (RÁPIDO - 50ms)
   ↓
3. HTML se muestra al usuario (con skeleton)
   ↓
4. React component se "monta" en el navegador
   ↓
5. Component hace fetch() a /prices-and-stock
   ↓
6. Backend revisa Redis cache
   ├─ SI ESTÁ EN CACHE → Devuelve en 10ms ⚡
   └─ NO ESTÁ → Query a BD (40ms) + guardar en cache
   ↓
7. Component muestra el precio REAL en verde
```

### Ventajas:

- **Página carga RÁPIDO** (HTML estático)
- **Precio SIEMPRE actualizado** (fetch dinámico)
- **Servidor no se sobrecarga** (cache Redis)
- **Funciona con SSG Y SSR** (mismo código)

---

## Solución de Problemas

### ❌ Error: "400 Bad Request"

**Causa**: Falta el API key

**Solución**:
```bash
# Verifica que existe
cat frontend/.env | grep PUBLIC_PUBLISHABLE_API_KEY

# Si no existe, agrégalo
echo "PUBLIC_PUBLISHABLE_API_KEY=pk_tu_clave" >> frontend/.env
```

### ❌ El precio no aparece (skeleton infinito)

**Causa**: El fetch falla

**Solución**:
1. Abre DevTools → Console
2. Busca errores en rojo
3. Verifica que el endpoint responde:
```bash
curl http://localhost:9000/store/products/PRODUCT_ID/prices-and-stock
```

### ❌ El precio aparece pero tarda mucho

**Causa**: Cache no está funcionando

**Solución**:
1. Verifica Redis:
```bash
redis-cli ping
# Debería responder: PONG
```

2. Ve los logs del backend:
```bash
# Deberías ver "Cache HIT" en requests subsecuentes
tail -f logs/backend.log | grep PRICES-STOCK
```

---

## Próximos Pasos

### Para mostrar el stock:

1. Abre `ProductDynamicPricing.tsx`
2. Descomenta las líneas del inventario (líneas 110-120)
3. Listo!

### Para usar SSG (páginas estáticas):

En tu página de producto (`[handle].astro`):
```astro
---
export const prerender = true  // Esto genera HTML estático

export async function getStaticPaths() {
    // Retorna lista de productos a pre-renderizar
    return [
        { params: { handle: 'led-strip-1' }},
        { params: { handle: 'led-strip-2' }}
    ]
}
---
```

**El precio dinámico seguirá funcionando!** 🎯

---

## Resumen

✅ **Creaste** un endpoint backend ultra-rápido con cache  
✅ **Creaste** un component React que hace fetch dinámico  
✅ **Integraste** el component en tu página de producto  
✅ **Lograste** páginas rápidas con precios siempre actualizados

**Tiempo total**: ~30 minutos siguiendo esta guía 🚀

---

## ¿Necesitas Ayuda?

Si algo no funciona:
1. Revisa la sección "Solución de Problemas" arriba
2. Verifica los logs del backend
3. Revisa la consola del navegador (DevTools)

**Documentación relacionada**:
- [GETTING_PRODUCT_PRICES.md](./GETTING_PRODUCT_PRICES.md) - Guía general de precios
- [Backend API Spec](./backend_api_spec.md) - Referencia completa de APIs

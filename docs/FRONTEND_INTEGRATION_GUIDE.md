# Frontend Integration Guide - Medusa v2 Backend

**Para:** Agente Frontend / Desarrollador Frontend  
**De:** Equipo Backend  
**Fecha:** 2026-01-28  
**Backend:** Medusa v2 (Railway Production)

---

## 🎯 Tu Misión

Crear el frontend (storefront) para EcoPowerTech que se conecte a nuestro backend Medusa v2 headless.

---

## 📡 Backend Endpoints

### Entorno Local (Development)
```
Backend API: http://localhost:9000
Admin UI: http://localhost:9000/app
MeiliSearch: https://meilisearch-production-1237.up.railway.app
```

### Entorno Producción
```
Backend API: https://medusa-starter-default-production-b69e.up.railway.app
Admin UI: https://medusa-starter-default-production-b69e.up.railway.app/app
MeiliSearch: https://meilisearch-production-1237.up.railway.app
```

### Credenciales que Necesitas

```env
# .env.local (en tu proyecto frontend)
NEXT_PUBLIC_MEDUSA_BACKEND_URL=http://localhost:9000
NEXT_PUBLIC_PUBLISHABLE_API_KEY=pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3

# Para búsqueda avanzada (MeiliSearch)
NEXT_PUBLIC_MEILISEARCH_HOST=https://meilisearch-production-1237.up.railway.app
NEXT_PUBLIC_MEILISEARCH_KEY=4d98acf90f2bb0a094763d9481d58de9455a10bba9f9452579d7b12e2d3ca1fe
```

---

## 🔐 Autenticación - Dual Login

El backend soporta **2 métodos de login para CLIENTES**:

### Método 1: Email/Password (Tradicional)

```typescript
// Login con email/password
const response = await fetch('http://localhost:9000/store/auth', {
  method: 'POST',
  credentials: 'include',  // ← CRÍTICO para cookies
  headers: {
    'Content-Type': 'application/json',
    'x-publishable-api-key': 'pk_519e7f66680afc4ab0136ce701a7f6d1e8df2b8fc48a29b7a55616a05cb5b5f3'
  },
  body: JSON.stringify({
    email: 'customer@example.com',
    password: 'password123'
  })
})

// Response incluye cookie de sesión automáticamente
const { customer } = await response.json()
```

### Método 2: Google OAuth (Nuevo!)

```typescript
// Componente de Login
export function GoogleLoginButton() {
  const handleLogin = () => {
    // Redirige a backend OAuth endpoint
    window.location.href = 'http://localhost:9000/store/auth/google'
  }
  
  return (
    <button onClick={handleLogin}>
      🔐 Sign in with Google
    </button>
  )
}

// Flujo automático:
// 1. Usuario hace click → Redirige a Google
// 2. Usuario acepta → Google redirige a backend
// 3. Backend crea customer → Redirige a /account (tu frontend)
// 4. Cookie de sesión ya está activa
```

**Callback URLs configurados:**
- Success: `http://localhost:3000/account`
- Failure: `http://localhost:3000/login`

**IMPORTANTE:** Todas las requests que requieran autenticación deben incluir:
```typescript
credentials: 'include'  // Para enviar cookies de sesión
```

---

## 🛍️ Estructura de Productos

Nuestros productos tienen **variantes dinámicas** (no estándar de Medusa):

```typescript
interface Product {
  id: string
  title: string
  description: string
  handle: string  // slug para URLs
  thumbnail: string
  images: ProductImage[]
  
  // Metadata especial (EcoPowerTech)
  metadata: {
    category?: string
    brand?: string
    manufacturer?: string
    warranty?: string
    specifications?: Record<string, any>
  }
  
  // Variantes son dinámicas (configurables)
  variants: ProductVariant[]
}

interface ProductVariant {
  id: string
  title: string
  sku: string
  inventory_quantity: number
  
  // Precios pueden variar por Customer Group
  prices: {
    amount: number
    currency_code: 'USD'
  }[]
  
  // Opciones personalizables
  options: {
    option_id: string
    value: string  // Ej: "Red", "Large", "220V"
  }[]
}
```

### Product Attributes & Attribute Sets

Los productos tienen **atributos dinámicos** organizados en **grupos (Attribute Sets)**:

![Product Attributes Example](/home/alejo/.gemini/antigravity/brain/00654e84-b8e4-4d68-b3b5-76d651fb93bf/uploaded_media_1769622980837.png)

#### Estructura de Datos

```typescript
interface AttributeSet {
  id: string
  handle: string  // e.g., "electrical-characteristics"
  title: string   // e.g., "Electrical Characteristics"
  attributes: AttributeKey[]
}

interface AttributeKey {
  id: string
  handle: string  // e.g., "power-consumption"
  label: string   // e.g., "Power Consumption"
  options: string[] | null  // Valores permitidos (opcional)
  attribute_set: AttributeSet  // Grupo al que pertenece
  values: AttributeValue[]
}

interface AttributeValue {
  id: string
  value: string  // e.g., "50W"
  attribute_key: AttributeKey
}

// En el producto
interface ProductWithAttributes {
  id: string
  title: string
  // ... otros campos
  
  // Link directo a valores de atributos
  attribute_values: AttributeValue[]
}
```

#### Obtener Atributos de un Producto

**Opción 1: Query con expansión (RECOMENDADO)**

```typescript
const response = await fetch(
  'http://localhost:9000/store/products/prod_123?fields=*attribute_values,*attribute_values.attribute_key,*attribute_values.attribute_key.attribute_set',
  {
    headers: {
      'x-publishable-api-key': 'pk_...'
    }
  }
)

const { product } = await response.json()

// product.attribute_values contiene:
// [
//   {
//     id: "attval_1",
//     value: "50W",
//     attribute_key: {
//       handle: "power-consumption",
//       label: "Power Consumption",
//       attribute_set: {
//         handle: "electrical-characteristics",
//         title: "Electrical Characteristics"
//       }
//     }
//   },
//   ...
// ]
```

**Opción 2: Endpoint custom (más simple)**

```typescript
// Backend expone endpoint simplificado
GET /store/products/:id/attributes

// Response agrupado automáticamente
{
  "Electrical Characteristics": {
    "Power Consumption": "50W",
    "Connection": "JST Plug",
    "Controllable By": "Any 24VDC Dimmer",
    "Dimmable": "Yes"
  },
  "Lighting Characteristics": {
    "Color Options": "3000K, 4000K, 6000K",
    "Luminous Flux": "235-274 lm/ft",
    "Beam Angle": "120°",
    "Chip Type": "COB"
  },
  "Physical Characteristics": {
    "PCB Finish": "White",
    "Cuttable Length": "1 inch, Anywhere!",
    "Length": "16.4'",
    "Width": "0.32\""
  }
}
```

#### Renderizar Atributos Agrupados (UI Component)

```tsx
// AdditionalInformation.tsx
import { AttributeValue } from '@medusajs/types'

interface AttributeGroup {
  title: string
  attributes: Record<string, string>
}

export function AdditionalInformation({ 
  attributeValues 
}: { 
  attributeValues: AttributeValue[] 
}) {
  // Agrupar por attribute_set
  const grouped = attributeValues.reduce((acc, attrVal) => {
    const setTitle = attrVal.attribute_key.attribute_set?.title || 'Other Specifications'
    const label = attrVal.attribute_key.label
    
    if (!acc[setTitle]) {
      acc[setTitle] = {}
    }
    acc[setTitle][label] = attrVal.value
    
    return acc
  }, {} as Record<string, Record<string, string>>)
  
  return (
    <div className="additional-info">
      <h2>Additional Information</h2>
      
      <div className="attribute-groups">
        {Object.entries(grouped).map(([groupTitle, attrs]) => (
          <div key={groupTitle} className="attribute-group">
            <h3>{groupTitle}</h3>
            
            <div className="attributes-grid">
              {Object.entries(attrs).map(([label, value]) => (
                <div key={label} className="attribute-row">
                  <span className="attribute-label">{label}</span>
                  <span className="attribute-value">{value}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
```

#### Ejemplo de CSS para Layout Similar a Screenshot

```css
.additional-info {
  margin-top: 3rem;
  padding: 2rem;
  background: #0a0f1a;
}

.additional-info h2 {
  color: white;
  margin-bottom: 2rem;
}

.attribute-groups {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 2rem;
}

.attribute-group {
  background: #0f1419;
  border-radius: 8px;
  padding: 1.5rem;
}

.attribute-group h3 {
  color: #3b82f6;
  font-size: 0.875rem;
  text-transform: uppercase;
  margin-bottom: 1rem;
  font-weight: 600;
}

.attributes-grid {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.attribute-row {
  display: flex;
  justify-content: space-between;
  padding: 0.5rem 0;
  border-bottom: 1px solid #1a1f2e;
}

.attribute-row:last-child {
  border-bottom: none;
}

.attribute-label {
  color: #9ca3af;
  font-size: 0.875rem;
}

.attribute-value {
  color: white;
  font-weight: 500;
  text-align: right;
  font-size: 0.875rem;
}
```

#### Búsqueda por Atributos (MeiliSearch)

Los atributos están indexados en MeiliSearch:

```typescript
// Buscar productos por atributo específico
const results = await client.index('products').search('', {
  filter: [
    'attributes.power-consumption = "50W"',
    'attributes.dimmable = "Yes"'
  ]
})

// Faceted search por atributos
const results = await client.index('products').search('LED strip', {
  facets: [
    'attributes.color-options',
    'attributes.ip-rating',
    'attributes.chip-type'
  ]
})
```


---

## 📦 Endpoints Principales que Usarás

### 1. Listar Productos

```typescript
// Sin búsqueda (básico)
GET /store/products
Headers: {
  'x-publishable-api-key': 'pk_...'
}

// Con búsqueda (MeiliSearch - RECOMENDADO)
import { MeiliSearch } from 'meilisearch'

const client = new MeiliSearch({
  host: 'https://meilisearch-production-1237.up.railway.app',
  apiKey: '4d98acf90f2bb0a094763d9481d58de9455a10bba9f9452579d7b12e2d3ca1fe'
})

const results = await client.index('products').search('solar panel', {
  filter: 'category = "Solar Panels"',
  limit: 20,
  facets: ['category', 'brand', 'price']
})
```

**Por qué usar MeiliSearch:**
- ✅ 10-50x más rápido que `/store/products?q=...`
- ✅ Typo tolerance ("solr panal" → "solar panel")
- ✅ Faceted search (filtros por categoría, marca, precio)
- ✅ Real-time sync (auto-actualiza cuando cambian productos)

### 2. Obtener Producto Individual

```typescript
GET /store/products/:id
// O por handle
GET /store/products/handle/:handle

// Ejemplo
const response = await fetch(
  'http://localhost:9000/store/products/prod_abc123',
  {
    headers: {
      'x-publishable-api-key': 'pk_...'
    }
  }
)
```

### 3. Carrito (Cart)

```typescript
// Crear carrito
POST /store/carts
Body: { region_id: "reg_01..." }  // Opcional

// Agregar item
POST /store/carts/:id/line-items
Body: {
  variant_id: "variant_abc",
  quantity: 2
}

// Obtener carrito
GET /store/carts/:id

// Actualizar cantidad
POST /store/carts/:id/line-items/:line_id
Body: { quantity: 5 }

// Eliminar item
DELETE /store/carts/:id/line-items/:line_id

// Completar carrito (iniciar checkout)
POST /store/carts/:id/payment-sessions
```

**NOTA:** El cart_id debe guardarse en localStorage o cookies del cliente.

### 4. Checkout

```typescript
// Agregar dirección de envío
POST /store/carts/:id/shipping-address
Body: {
  first_name: "John",
  last_name: "Doe",
  address_1: "123 Main St",
  city: "Miami",
  country_code: "us",
  postal_code: "33101"
}

// Seleccionar método de envío
POST /store/carts/:id/shipping-methods
Body: {
  option_id: "so_123"
}

// Completar orden
POST /store/carts/:id/complete

// Response incluye Order ID
```

### 5. Customer (Usuario Logueado)

```typescript
// Obtener perfil
GET /store/customers/me
Headers: {
  'x-publishable-api-key': 'pk_...'
}
Credentials: include  // ← Cookie de sesión

// Actualizar perfil
POST /store/customers/me
Body: {
  first_name: "Jane",
  last_name: "Doe",
  phone: "+1234567890"
}

// Órdenes del customer
GET /store/customers/me/orders

// Logout
DELETE /store/auth
```

---

## 🎨 Recomendaciones de Stack

### Opción 1: Next.js (Recomendado por Medusa)

```bash
# Starter oficial
npx create-next-app@latest -e https://github.com/medusajs/nextjs-starter-medusa

# Ya incluye:
- Medusa JS SDK
- Autenticación
- Carrito
- Checkout
- Product pages
```

### Opción 2: Astro (Máximo Performance)

```bash
npm create astro@latest

# Ventajas:
- SSG (HTML estático) para productos
- SSR para carrito/checkout
- 50-100ms TTFB
- Lighthouse 100
```

### Opción 3: React + Vite (SPA)

```bash
npm create vite@latest -- --template react-ts

# Ventajas:
- Simple
- Rápido desarrollo
- No SEO necesario
```

---

## 📚 SDK de Medusa (Recomendado)

```typescript
// Instalar
npm install @medusajs/js-sdk

// Configurar
import Medusa from "@medusajs/js-sdk"

const medusa = new Medusa({
  baseUrl: process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL,
  publishableApiKey: process.env.NEXT_PUBLIC_PUBLISHABLE_API_KEY,
})

// Usar
const { products } = await medusa.store.product.list()
const { customer } = await medusa.store.customer.retrieve()
const { cart } = await medusa.store.cart.create()
```

**El SDK maneja:**
- ✅ Headers automáticamente
- ✅ Cookies de sesión
- ✅ TypeScript types
- ✅ Error handling

---

## 🔍 Búsqueda con MeiliSearch (IMPORTANTE)

El backend tiene **sync automático** a MeiliSearch. Úsalo para:

### Productos (Index: `products`)

```typescript
import { MeiliSearch } from 'meilisearch'

const client = new MeiliSearch({
  host: process.env.NEXT_PUBLIC_MEILISEARCH_HOST,
  apiKey: process.env.NEXT_PUBLIC_MEILISEARCH_KEY
})

// Búsqueda simple
const results = await client.index('products').search('solar')

// Búsqueda con filtros
const results = await client.index('products').search('panel', {
  filter: [
    'category = "Solar Panels"',
    'price < 1000'
  ],
  facets: ['category', 'brand'],
  limit: 20,
  offset: 0
})

// Autocomplete
const suggestions = await client.index('products').search(query, {
  limit: 5,
  attributesToRetrieve: ['title', 'thumbnail']
})
```

### Customers (Index: `customers`)

```typescript
// Búsqueda de clientes (si tienes admin features)
const customers = await client.index('customers').search('john@example.com')
```

### Inventory (Index: `inventory`)

```typescript
// Verificar stock disponible
const inventory = await client.index('inventory').search('', {
  filter: 'quantity > 0'
})
```

---

## 🎯 Features Clave del Backend

### 1. Customer Groups (Precios Personalizados)

Los clientes pueden estar en grupos (Wholesale, Retail, VIP):

```typescript
// El precio que ves depende del customer group
const { product } = await medusa.store.product.retrieve('prod_123')

// Si customer está logueado y es "Wholesale":
product.variants[0].prices  // Muestra precio wholesale

// Si es guest o "Retail":
product.variants[0].prices  // Muestra precio público
```

**Frontend debe:**
- Mostrar "Login to see wholesale prices" si no está logueado
- Refrescar precios después de login

### 2. Metadata Enriquecida (QuickBooks)

Muchos customers tienen metadata extra:

```typescript
interface Customer {
  id: string
  email: string
  first_name: string
  last_name: string
  
  metadata: {
    qb_customer_id?: string      // ID en QuickBooks
    qb_full_name?: string         // Nombre completo
    qb_price_level?: string       // Nivel de precio
    qb_secondary_email?: string   // Email alternativo
    qb_billing_address?: Address
    qb_shipping_addresses?: Address[]
  }
}
```

**Úsalo para:**
- Pre-llenar formularios de checkout
- Mostrar múltiples addresses
- Sincronizar con QuickBooks

### 3. Inventory Real-Time

El inventario se sincroniza cada 5 minutos con QuickBooks:

```typescript
// Siempre verifica stock antes de checkout
const { variant } = await medusa.store.productVariant.retrieve(id)

if (variant.inventory_quantity < requestedQuantity) {
  // Mostrar "Out of Stock" o "Only X remaining"
}
```

---

## 🚀 Performance Tips

### 1. SSG para Páginas de Producto (Astro/Next.js)

```typescript
// Genera HTML estático en build time
export async function getStaticProps({ params }) {
  const { product } = await medusa.store.product.retrieve(params.id)
  
  return {
    props: { product },
    revalidate: 300  // Re-genera cada 5 min
  }
}
```

**Resultado:** Páginas cargan en 50-100ms

### 2. Client-Side Data Dinámico

```tsx
// HTML estático (SSG)
<ProductPage product={product} />

// Datos dinámicos (cliente)
<ProductPrice 
  client:load 
  variantId={product.variants[0].id} 
/>
<StockStatus 
  client:visible 
  variantId={product.variants[0].id} 
/>
```

### 3. Prefetch en Hover

```typescript
// Prefetch product data cuando usuario hace hover
<Link 
  href={`/products/${product.handle}`}
  onMouseEnter={() => prefetchProduct(product.id)}
>
  {product.title}
</Link>
```

---

## ⚠️ Gotchas Importantes

### 1. CORS

El backend tiene CORS configurado para:
```
http://localhost:3000
http://localhost:4321  # Astro default
```

**Si usas otro puerto, avísame para agregarlo.**

### 2. Cookies de Sesión

**CRÍTICO:**
```typescript
// SIEMPRE incluir en fetch
fetch(url, {
  credentials: 'include'  // ← SIN ESTO NO HAY SESIÓN
})
```

### 3. Publishable API Key

**SIEMPRE incluir:**
```typescript
headers: {
  'x-publishable-api-key': 'pk_...'
}
```

### 4. Region

Medusa requiere regions para precio/envío:
```typescript
// Crear cart con region
const { cart } = await medusa.store.cart.create({
  region_id: 'reg_01...'  // Obtener de /store/regions
})
```

---

## 📋 Checklist de Integración

- [ ] Instalar Medusa SDK o configurar fetch client
- [ ] Configurar environment variables
- [ ] Implementar producto listing (con MeiliSearch)
- [ ] Implementar página de producto individual
- [ ] Implementar carrito (create, update, delete items)
- [ ] Implementar login dual (email/password + Google OAuth)
- [ ] Implementar checkout flow
- [ ] Implementar customer profile
- [ ] Implementar order history
- [ ] Implementar búsqueda (MeiliSearch)
- [ ] Tests en local (http://localhost:9000)
- [ ] Deploy a staging
- [ ] Update URLs a producción

---

## 🆘 Soporte

**Si algo no funciona:**

1. **Verifica backend está corriendo:** http://localhost:9000/health
2. **Revisa network tab:** ¿Headers correctos? ¿Credentials: include?
3. **Logs del backend:** Revisa Railway logs
4. **MeiliSearch:** https://meilisearch-production-1237.up.railway.app/health

**Contacto:** Equipo Backend (me)

---

## 📚 Recursos

- **Medusa Docs:** https://docs.medusajs.com
- **JS SDK Docs:** https://docs.medusajs.com/resources/js-sdk
- **MeiliSearch Docs:** https://www.meilisearch.com/docs
- **Next.js Starter:** https://github.com/medusajs/nextjs-starter-medusa
- **Backend Docs (local):** `/docs` folder

---

**¡Éxito con el frontend! 🚀**

**Última actualización:** 2026-01-28

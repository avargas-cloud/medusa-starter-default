---
**Purpose:** Guide for frontend developers on how to access and display the `long_description` field on product pages — the API endpoint, response field name, and rendering considerations for rich HTML content.

**Solves:** The `long_description` field is stored in `product.metadata.long_description` and requires special handling: it contains HTML markup that must be rendered as innerHTML, not plain text. Frontend developers were confused about where to find the field and how to render it safely.

**Expected Result:** Product detail pages display the full long description with correct HTML formatting (bullet lists, bold text, paragraphs) sourced from the Medusa product metadata field.

---

# 📝 Cómo Obtener Long Description de Productos

## TL;DR (Para el Agente Frontend)

**Campo a usar:** `product.metadata.long_description`

**Tipo:** `string` con contenido HTML

**Ejemplo rápido:**
```typescript
const { product } = await medusa.store.product.retrieve(productId)
const longDescription = product.metadata?.long_description as string

// Renderizar
<div dangerouslySetInnerHTML={{ __html: longDescription }} />
```

---

## 📍 Ubicación

```typescript
product.metadata.long_description  // ← AQUÍ está
```

**NO confundir con:**
- ❌ `product.description` → Descripción CORTA (texto plano)
- ✅ `product.metadata.long_description` → Descripción LARGA (HTML)

---

## 💻 Ejemplos de Uso

### Opción 1: Fetch con API estándar de Medusa

```typescript
import Medusa from "@medusajs/js-sdk"

const medusa = new Medusa({
  baseUrl: process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL,
  publishableApiKey: process.env.NEXT_PUBLIC_PUBLISHABLE_API_KEY,
})

// Obtener producto
const { product } = await medusa.store.product.retrieve(productId)

// Extraer long description
const longDescription = product.metadata?.long_description as string | undefined
```

### Opción 2: Fetch directo

```typescript
const response = await fetch(
  `${process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL}/store/products/${productId}`,
  {
    headers: {
      'x-publishable-api-key': process.env.NEXT_PUBLIC_PUBLISHABLE_API_KEY!
    }
  }
)

const { product } = await response.json()
const longDescription = product.metadata?.long_description as string
```

---

## 🎨 Renderizado en React/Next.js

### Básico (con dangerouslySetInnerHTML)

```tsx
export default function ProductPage({ product }) {
  const longDesc = product.metadata?.long_description as string

  return (
    <div>
      {/* Descripción corta */}
      <p>{product.description}</p>

      {/* Descripción larga (HTML) */}
      {longDesc && (
        <div 
          className="prose max-w-none"
          dangerouslySetInnerHTML={{ __html: longDesc }}
        />
      )}
    </div>
  )
}
```

### Con Sanitización (Recomendado para Seguridad)

```bash
npm install dompurify
npm install --save-dev @types/dompurify
```

```tsx
import DOMPurify from 'dompurify'

export default function ProductPage({ product }) {
  const longDescRaw = product.metadata?.long_description as string
  const longDescClean = longDescRaw ? DOMPurify.sanitize(longDescRaw) : undefined

  return (
    <div>
      {longDescClean && (
        <div 
          className="product-details prose"
          dangerouslySetInnerHTML={{ __html: longDescClean }}
        />
      )}
    </div>
  )
}
```

---

## 📊 Datos Reales de Ejemplo

```json
{
  "id": "prod_sun-wifi-hub-wifi-to-rf-converter",
  "title": "SUN Wifi Hub, Wifi to RF Converter",
  "description": "Short description here...",
  "metadata": {
    "long_description": "<p>SUN Wifi Hub integrates all SUN devices into a system that can be controlled by a smart phone. It simple adapts to the needs of automation, and opens a new world for the user. There are 2 different smart phone apps that can work with our SUN Wifi Hub. Both apps are user friendly, and they have their own advantage.</p>\n"
  }
}
```

---

## ✅ Checklist para el Frontend

- [ ] Usar `product.metadata.long_description` (no `product.description`)
- [ ] Verificar que existe antes de renderizar (`if (longDesc)`)
- [ ] Renderizar con `dangerouslySetInnerHTML` o sanitizar primero
- [ ] Aplicar estilos con clase `prose` (si usas Tailwind Typography)
- [ ] Manejar caso cuando `long_description` es `null` o `undefined`

---

## 🔗 Documentación Completa

Ver: `/docs/FRONTEND_INTEGRATION_GUIDE.md` sección "Descripciones de Producto"

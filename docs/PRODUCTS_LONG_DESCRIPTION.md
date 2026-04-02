# Products — Long Description
> **Tipo**: Technical Reference
> **Repo**: backend
> **Última verificación**: 2026-04-02
> **Estado**: ✅ Current

---

## ¿Qué es y por qué existe?

El campo `long_description` almacena una descripción enriquecida (HTML) de cada producto, separada del campo nativo `product.description` (texto plano corto). Se guarda en `product.metadata.long_description` porque Medusa v2 no tiene un campo de descripción larga nativo.

Se edita desde el Admin Panel via el widget `long-description-widget.tsx` inyectado en la página de detalle de producto.

---

## Arquitectura

- **Almacenamiento**: `product.metadata.long_description` (string HTML)
- **Acceso**: vía API nativa de Medusa — el campo `metadata` siempre se devuelve
- **Admin widget**: `src/admin/widgets/long-description-widget.tsx` (zona `product.details.after`)
- **Sin endpoint custom**: no hay ruta dedicada — se lee y escribe vía las rutas nativas de productos

---

## Modelo de Datos / Estructura

```typescript
// Posición en el objeto producto
product.metadata = {
  long_description: "<p>HTML content here...</p>",  // string | undefined
  // ... otros campos de metadata
}
```

**No confundir con:**
- `product.description` → descripción corta, texto plano
- `product.metadata.long_description` → descripción larga, **HTML**

---

## Flujo de Implementación

### Leer desde Store API (frontend)

```typescript
// Via SDK
const { product } = await medusa.store.product.retrieve(productId, {
  headers: { "x-publishable-api-key": PUBLISHABLE_KEY }
})
const longDescription = product.metadata?.long_description as string | undefined

// Via fetch directo
const res = await fetch(`${MEDUSA_URL}/store/products/${productId}`, {
  headers: { "x-publishable-api-key": PUBLISHABLE_KEY }
})
const { product } = await res.json()
const longDescription = product.metadata?.long_description as string
```

### Escribir desde Admin

El widget usa el endpoint nativo de Medusa con merge de metadata para no sobrescribir otros campos:

```typescript
// 1. Fetch metadata actual
const current = await fetch(`/admin/products/${productId}`)
const { product } = await current.json()
const existingMetadata = product.metadata || {}

// 2. Merge y write
await fetch(`/admin/products/${productId}`, {
  method: "POST",
  body: JSON.stringify({
    metadata: {
      ...existingMetadata,
      long_description: newHtmlContent
    }
  })
})
```

---

## API / Interfaces

No hay endpoints custom. Se usa la API nativa:

| Método | Ruta | Uso |
|--------|------|-----|
| `GET` | `/store/products/:id` | Leer `metadata.long_description` |
| `POST` | `/admin/products/:id` | Actualizar `metadata.long_description` |

---

## Reglas Críticas

1. **Siempre hacer merge de metadata** — nunca sobrescribir el objeto completo o se pierden otros campos (`variant_attributes`, etc.)
2. **Renderizar como HTML** — usar `dangerouslySetInnerHTML` (o sanitización previa con DOMPurify)
3. **Verificar existencia** antes de renderizar — puede ser `null` o `undefined`
4. **El contenido viene del Admin** — es HTML generado por el editor de texto del widget

---

## Archivos Clave

| Tipo | Ruta Completa | Propósito |
|------|---------------|-----------|
| Admin Widget | `backend/src/admin/widgets/long-description-widget.tsx` | Editor de long description en PDP admin |

---

## Historial de Decisiones

| Fecha | Decisión | Razón |
|-------|----------|-------|
| ~2026-01 | Usar `metadata.long_description` en lugar de campo DB | Medusa v2 no tiene campo nativo de descripción larga; metadata siempre se expone en la API |

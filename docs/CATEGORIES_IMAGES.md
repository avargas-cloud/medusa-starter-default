# Categories — Images
> **Tipo**: Technical Reference
> **Repo**: backend
> **Última verificación**: 2026-04-02
> **Estado**: ✅ Current

---

## ¿Qué es y por qué existe?

Documenta el sistema de imágenes para categorías de producto, incluyendo la limitación de la Admin API de Medusa v2 que impide acceder al campo `thumbnail` de categorías, y el workaround usando `category.metadata.image.url`.

---

## Arquitectura

### La limitación

La columna `thumbnail` **existe en la DB** (`product_category.thumbnail TEXT`) pero **no se expone en la Admin API**. El query parameter `fields` tampoco la incluye. La Store API tampoco la expone.

### Solución: metadata.image

```
Upload de imagen
    │  (con header x-upload-context: categories)
    └─► Smart Storage → carpeta categories/ en MinIO
    └─► URL retornada al widget
    └─► Widget hace Fetch-Merge-Write → category.metadata.image.url

Frontend / Admin Widget
    └─► Lee category.metadata.image.url
```

---

## Modelo de Datos / Estructura

```typescript
// Estructura en metadata de categoría
category.metadata = {
  image: {
    url: "https://bucket-production-2e09.up.railway.app/medusa-media/categories/pcat_led-strips.png"
  },
  // ... otros campos: filter_config, sorting_config, etc.
}
```

| Ubicación | Campo `thumbnail` | `metadata.image.url` |
|-----------|------------------|---------------------|
| Database | ✅ Existe (type: text) | ✅ Existe (jsonb) |
| Admin API | ❌ No expuesto | ✅ Expuesto en responses |
| Widget lee | ❌ No accesible | ✅ Usa este |
| Widget escribe | ❌ No writable via API | ✅ Escribe aquí |

---

## Flujo de Implementación

### Upload de imagen de categoría

1. Usuario sube imagen en el Category Image Widget
2. Widget envía `x-upload-context: categories` en el header
3. Upload endpoint detecta el header y añade prefix `context_categories_`
4. Smart Storage detecta el prefix y enruta a la carpeta `categories/` en MinIO
5. Archivo guardado como `categories/pcat_{handle}.{ext}`
6. URL retornada: `https://bucket.../medusa-media/categories/pcat_led-strips.png`
7. Widget guarda URL via **Fetch-Merge-Write**

### Fetch-Merge-Write (patrón obligatorio)

```typescript
// 1. Fetch metadata actual
const fetchResponse = await fetch(`/admin/product-categories/${categoryId}`, {
  credentials: "include"
})
const { product_category } = await fetchResponse.json()
const existingMetadata = product_category?.metadata || {}

// 2. Merge preservando otros campos
await fetch(`/admin/product-categories/${categoryId}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  credentials: "include",
  body: JSON.stringify({
    metadata: {
      ...existingMetadata,     // Preserva filter_config, sorting_config, etc.
      image: { url: newUrl }   // Solo actualiza el campo de imagen
    }
  })
})
```

**Si se omite el merge, se borran** `filter_config`, `sorting_config` y otros campos de metadata.

### Media Library embebida

El widget incluye una librería de medios con:
- Navegación automática a carpeta `categories/`
- Búsqueda server-side vía `GET /admin/media?prefix=categories/&search=...`
- Paginación con S3 continuation tokens

---

## API / Interfaces

| Método | Ruta | Propósito |
|--------|------|-----------|
| `GET` | `/admin/product-categories/:id` | Leer `metadata.image.url` |
| `POST` | `/admin/product-categories/:id` | Escribir `metadata.image.url` (con merge) |
| `POST` | `/admin/uploads` | Subir archivo (con `x-upload-context: categories`) |
| `GET` | `/admin/media` | Listar archivos de MinIO |

---

## Reglas Críticas

1. **Siempre Fetch-Merge-Write** — nunca sobrescribir metadata completa
2. **Header `x-upload-context: categories`** en uploads de imágenes de categoría — sin él, el archivo va a la carpeta incorrecta
3. **Leer de `metadata.image.url`**, no del campo `thumbnail` — la API no expone `thumbnail`

---

## Archivos Clave

| Tipo | Ruta Completa | Propósito |
|------|---------------|-----------|
| Admin Widget | `backend/src/admin/widgets/category-image-widget.tsx` | Upload + media library para imágenes de categoría |
| Upload endpoint | `backend/src/api/admin/media/route.ts` | Gestión de archivos en MinIO |
| Smart Storage | `backend/src/modules/smart-storage/` | S3-compatible storage con routing por prefix |

---

## Historial de Decisiones

| Fecha | Decisión | Razón |
|-------|----------|-------|
| 2026-01-31 | `metadata.image.url` en lugar de `thumbnail` column | La Admin API de Medusa v2 no expone el campo `thumbnail` de categorías |
| 2026-01-31 | Renombrar `metadata.woocommerce_image` → `metadata.image` | Nombre más genérico y limpio post-migración de WooCommerce |
| 2026-01-31 | Fetch-Merge-Write pattern | Escritura directa de metadata borraba `filter_config` y otros campos |

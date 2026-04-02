# Products — Attributes System
> **Tipo**: Technical Reference
> **Repo**: backend
> **Última verificación**: 2026-04-02
> **Estado**: ✅ Current

---

## ¿Qué es y por qué existe?

El módulo `product-attributes` implementa un sistema de atributos técnicos muchos-a-muchos entre productos y valores de atributo (e.g., voltaje, lúmenes, color). Medusa v2 no tiene un sistema nativo de especificaciones técnicas con dimensiones configurables, por lo que se construyó como módulo custom con tabla de links propia.

**Principio clave:** Las operaciones de borrado en la tabla de links se hacen con **hard delete via raw SQL**, NO con `remoteLink.delete()` (que deja registros soft-deleted que contaminan las queries).

---

## Arquitectura

### Componentes Principales

```
AttributeSet (agrupador)
  └─► AttributeKey (dimensión, e.g. "Wattage")
        └─► AttributeValue (valor, e.g. "12W", "24W")
              └─► [Link] ←─ Product (M2M via tabla pivot)
```

### Tabla Pivot (Link Table)

```
product_product_productattributes_attribute_value
  - product_id          VARCHAR NOT NULL
  - attribute_value_id  VARCHAR NOT NULL
  - created_at          TIMESTAMP
  - updated_at          TIMESTAMP
  - deleted_at          TIMESTAMP NULL  ← SIEMPRE filtrar con .whereNull("deleted_at")
  - UNIQUE (product_id, attribute_value_id)
```

### Definición del Link

`src/links/product-attribute-link.ts`:
```typescript
defineLink(
    { linkable: ProductModule.linkable.product, isList: true },
    { linkable: AttributeModule.linkable.attributeValue, isList: true }
)
```

`isList: true` en **ambos lados** es obligatorio para soportar M2M. Sin esto Medusa rechaza múltiples links con "Cannot create multiple links".

---

## Modelo de Datos / Estructura

| Entidad | Archivo modelo | Tabla DB |
|---------|---------------|----------|
| `AttributeSet` | `src/modules/product-attributes/models/attribute-set.ts` | `attribute_set` |
| `AttributeKey` | `src/modules/product-attributes/models/attribute-key.ts` | `attribute_key` |
| `AttributeValue` | `src/modules/product-attributes/models/attribute-value.ts` | `attribute_value` |

### Campos de `AttributeKey`

| Campo | Tipo | Propósito |
|-------|------|-----------|
| `handle` | text unique | Slug URL-friendly (e.g. `"material"`) |
| `label` | text | Nombre legible (e.g. `"Material"`) |
| `options` | array nullable | Valores permitidos para dropdowns (e.g. `["Red","Blue"]`) |
| `display_name` | text nullable | Override del label para la UI de filtros del frontend |
| `description` | text nullable | Texto de ayuda para el panel de filtros |
| `filter_type` | text nullable | Tipo de UI: `"checkbox"`, `"range"`, `"toggle"`, `"dropdown"`, `"color-swatch"` |
| `filter_order` | number nullable | Orden en el panel de filtros |
| `icon` | text nullable | Identificador de icono: `"thermometer"`, `"bolt"`, `"ruler"` |
| `unit` | text nullable | Unidad de medida: `"K"`, `"V"`, `"W"`, `"ft"`, `"mm"` |
| `metadata` | json nullable | Metadata extra |

### Migración de display metadata

`Migration20260129194325.ts` — añade las 6 columnas de display configuration (`display_name`, `description`, `filter_type`, `filter_order`, `icon`, `unit`). Todas son nullable; backward compatible.

---

## Flujo de Implementación

### Actualización de atributos de un producto

`src/workflows/product-attributes/update-product-attributes.ts`:

1. Fetch de links existentes (filtrado por `deleted_at IS NULL` via raw SQL)
2. Comparar old vs new value IDs por AttributeKey
3. Si cambiaron: **HARD DELETE** via Knex `.del()` de los valores viejos
4. Crear nuevos links via `remoteLink.create()`
5. Actualizar `product.metadata.variant_attributes` para variant switches

```typescript
// ✅ CORRECTO: Hard delete
await knex("product_product_productattributes_attribute_value")
    .where("product_id", productId)
    .whereIn("attribute_value_id", toDelete)
    .del()

// ❌ NUNCA: crea registros soft-deleted que contaminan queries
await remoteLink.delete({...})
```

### Sync de options a AttributeValue entities

`POST /admin/attributes/sync-values` — utilitario que reconcilia las opciones (`options[]` en AttributeKey) con entidades `AttributeValue` en la DB. Crea las que faltan; elimina las que sobran.

---

## API / Interfaces

### AttributeKey (Attribute global)

| Método | Ruta | Propósito |
|--------|------|-----------|
| `GET` | `/admin/attributes` | Listar todos los AttributeKeys con sus values |
| `POST` | `/admin/attributes` | Crear AttributeKey (ejecuta workflow) |
| `GET` | `/admin/attributes/:id` | Obtener AttributeKey con conteo de productos |
| `POST` | `/admin/attributes/:id` | Actualizar AttributeKey (ejecuta workflow) |
| `DELETE` | `/admin/attributes/:id` | Eliminar con cascade (ver Cascade Delete) |
| `POST` | `/admin/attributes/:id/values` | Crear AttributeValue para un AttributeKey |
| `POST` | `/admin/attributes/:id/move` | Mover a otro AttributeSet (o null = sin set) |
| `POST` | `/admin/attributes/bulk-move` | Mover múltiples attributes a un AttributeSet |
| `POST` | `/admin/attributes/sync-values` | Sincronizar options → AttributeValue entities |

### AttributeSet (Agrupador)

| Método | Ruta | Propósito |
|--------|------|-----------|
| `GET` | `/admin/attribute-sets` | Listar sets con sus atributos |
| `POST` | `/admin/attribute-sets` | Crear set (handle auto-generado del title) |
| `POST` | `/admin/attribute-sets/:id` | Renombrar set |
| `DELETE` | `/admin/attribute-sets/:id` | Eliminar set (safe — no elimina sus attributes) |

### Atributos de un Producto

| Método | Ruta | Propósito |
|--------|------|-----------|
| `GET` | `/admin/products/:id/attributes` | Obtener atributos asignados (filtra soft-deleted) |
| `POST` | `/admin/products/:id/attributes` | Actualizar atributos + gestionar variant generation |

#### Payload POST `/admin/products/:id/attributes`

```typescript
{
  value_ids: string[],          // IDs de AttributeValue a asignar
  variant_keys?: string[]       // IDs de AttributeKey que generan variantes
}
```

La respuesta de error cuando hay variantes con órdenes:
```typescript
// HTTP 400
{
  error: "Cannot disable variant attribute",
  message: "Some variants have existing orders and cannot be deleted.",
  protectedVariants: ["variant_id_1", "variant_id_2"]
}
```

### Cascade Delete (`DELETE /admin/attributes/:id`)

Al eliminar un AttributeKey:
1. Fetch de todas las categorías via HTTP (el admin context no puede resolver `productCategoryModuleService` directamente)
2. Para cada categoría con `filter_config.active_filters`: eliminar referencia al atributo borrado (soporta formato string[] y objeto[])
3. Recomputa el `order` en los filtros que quedan
4. Obtiene todos los AttributeValues del key
5. Elimina links producto-atributo de la tabla pivot (hard delete)
6. Elimina los AttributeValues
7. Elimina el AttributeKey

---

## Admin UI — Pantallas

### Página de Atributos (`/app/attributes`)

**Archivo:** `src/admin/routes/attributes/page.tsx`

Funcionalidades:
- **Accordion por AttributeSet** — atributos agrupados visualmente en contenedores colapsables
- **Unassigned group** — siempre presente para atributos sin set
- **Bulk selection + Bulk Move** — seleccionar varios atributos y moverlos a un set en una acción
- **Search** — filtro en tiempo real que oculta sets sin matches
- Modales: Create Attribute, Create Set, Rename Set, Delete Set

Modales:
- `src/admin/components/attributes/create-attribute-modal.tsx` — incluye sección de "Display Configuration" con los campos `display_name`, `description`, `filter_type`, `icon`, `unit`
- `src/admin/components/attributes/create-set-modal.tsx`
- `src/admin/components/attributes/rename-set-modal.tsx`
- `src/admin/components/attributes/delete-set-modal.tsx`

### Widget en Product Detail Page (`product.details.after`)

**Archivo:** `src/admin/widgets/product-attributes-widget.tsx`

- Muestra atributos del producto agrupados por AttributeKey (helper `groupAttributesByKey`)
- Indica con badge "Variant" los keys marcados en `product.metadata.variant_attributes`
- Dual-fetch: `GET /admin/products/:id/attributes` + `sdk.admin.product.retrieve` para metadata
- Lanza `ManageAttributesModal` para edición

### ManageAttributesModal

**Archivo:** `src/admin/components/manage-attributes-modal.tsx`

UX features:
- **Combobox searchable** para seleccionar AttributeKey (busca mientras escribe)
- **Inline Quick-Add** con botón `+` en columna Values para agregar valores sin reseleccionar el key
- **Auto-creation** — seleccionar una "option" string crea automáticamente el AttributeValue entity
- Sección "Add New Attribute" en la parte superior (acción primaria)

---

## Reglas Críticas

1. **HARD DELETE SIEMPRE** en la tabla pivot — usar raw Knex `.del()`, nunca `remoteLink.delete()`
2. **FILTRAR `deleted_at`** en todas las SELECTs sobre la tabla pivot — incluir `.whereNull("deleted_at")`
3. **`isList: true` en ambos lados** del link definition — es M2M, no O2M
4. **Raw SQL para queries críticas** — bypasea el cache y soft-delete de Medusa ORM
5. **HTTP pattern para operaciones de categoría en admin routes** — no se puede resolver `productCategoryModuleService` directamente

---

## Archivos Clave

| Tipo | Ruta Completa | Propósito |
|------|---------------|-----------|
| Módulo | `backend/src/modules/product-attributes/index.ts` | Export del módulo |
| Service | `backend/src/modules/product-attributes/service.ts` | MedusaService con 3 entidades |
| Modelo | `backend/src/modules/product-attributes/models/attribute-key.ts` | Dimensión con display metadata |
| Modelo | `backend/src/modules/product-attributes/models/attribute-set.ts` | Agrupador |
| Modelo | `backend/src/modules/product-attributes/models/attribute-value.ts` | Valor concreto |
| Migración | `backend/src/modules/product-attributes/migrations/Migration20260129194325.ts` | Agrega 6 columnas de display |
| Link | `backend/src/links/product-attribute-link.ts` | Definición M2M con `isList: true` en ambos lados |
| Workflow | `backend/src/workflows/product-attributes/update-product-attributes.ts` | Hard delete + create links |
| Workflow | `backend/src/workflows/product-attributes/create-attribute-key.ts` | Crear AttributeKey |
| Workflow | `backend/src/workflows/product-attributes/update-attribute-key.ts` | Actualizar AttributeKey |
| Workflow | `backend/src/workflows/product-attributes/move-attribute.ts` | Mover a otro set |
| Workflow | `backend/src/workflows/product-attributes/bulk-move-attributes.ts` | Bulk move |
| API Admin | `backend/src/api/admin/attributes/route.ts` | GET/POST AttributeKeys |
| API Admin | `backend/src/api/admin/attributes/[id]/route.ts` | GET/POST/DELETE con cascade |
| API Admin | `backend/src/api/admin/attributes/[id]/move/route.ts` | Mover a set |
| API Admin | `backend/src/api/admin/attributes/[id]/values/route.ts` | Crear AttributeValue |
| API Admin | `backend/src/api/admin/attributes/bulk-move/route.ts` | Bulk move |
| API Admin | `backend/src/api/admin/attributes/sync-values/route.ts` | Sync options → entities |
| API Admin | `backend/src/api/admin/attribute-sets/route.ts` | GET/POST AttributeSets |
| API Admin | `backend/src/api/admin/attribute-sets/[id]/route.ts` | POST/DELETE AttributeSet |
| API Admin | `backend/src/api/admin/products/[id]/attributes/route.ts` | GET/POST atributos del producto |
| Widget PDP | `backend/src/admin/widgets/product-attributes-widget.tsx` | Widget en Product Detail |
| Modal | `backend/src/admin/components/manage-attributes-modal.tsx` | Modal de gestión |
| Admin page | `backend/src/admin/routes/attributes/page.tsx` | Dashboard de atributos |

---

## Historial de Decisiones

| Fecha | Decisión | Razón |
|-------|----------|-------|
| 2026-01-24 | `isList: true` en ambos lados del link | Sin esto Medusa rechaza M2M con "Cannot create multiple links" |
| 2026-01-24 | Combobox searchable en ManageAttributesModal | La lista de atributos es grande; búsqueda en tiempo real mejora UX |
| 2026-01-30 | Hard delete via raw SQL en lugar de `remoteLink.delete()` | `remoteLink.delete()` crea soft-deleted que contaminan queries y filtros; 964 links ghost eliminados de prod |
| 2026-01-30 | `.whereNull("deleted_at")` en todas las SELECTs | Filtrar ghost records acumulados de la era pre-hard-delete |
| 2026-01-29 | Campos de display metadata en AttributeKey (`display_name`, `filter_type`, `icon`, `unit`, etc.) | Frontend necesita metadata para renderizar filtros dinámicos sin hardcodear configuración |
| 2026-01-31 | HTTP pattern para cascade delete de categorías | Admin routes no pueden resolver `productCategoryModuleService` directamente |

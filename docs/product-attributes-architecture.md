
# Especificación Técnica: Módulo de Atributos de Producto

Este documento describe la arquitectura final, validada y funcional del módulo de Atributos de Producto (`product-attributes`) implementado en el sistema Medusa. Sirve como referencia para futuros desarrollos y para evitar regresiones.

## 1. Arquitectura de Datos

### Modelos
El módulo define tres modelos principales. Es crítico respetar los nombres de las propiedades.

#### `AttributeKey` (Definición del Atributo)
- **Propiedad Clave:** `label` (String). NO usar `title`.
- **Relaciones:**
  - `values`: `hasMany` -> `AttributeValue`. (Requerida para que la API pueda incluir valores anidados).
  - `attribute_set`: `belongsTo` -> `AttributeSet`.

```typescript
// src/modules/product-attributes/models/attribute-key.ts
export const AttributeKey = model.define("attribute_key", {
    id: model.id().primaryKey(),
    handle: model.text().unique(),
    label: model.text(), // CORRECTO. No usar 'title'.
    values: model.hasMany(() => AttributeValue, {
        mappedBy: "attribute_key"
    })
    // ...
})
```

#### `AttributeValue` (Valor Específico)
- **Propiedad Clave:** `value` (String).
- **Relaciones:**
  - `attribute_key`: `belongsTo` -> `AttributeKey`.

## 2. Configuración de Links (Vínculos)

El vínculo entre Productos (Core) y Atributos (Módulo) se define mediante un Remote Link.

**Archivo:** `src/links/product-attribute.ts`
```typescript
import ProductModule from "@medusajs/medusa/product"
import AttributeModule from "../modules/product-attributes"
import { defineLink } from "@medusajs/framework/utils"

export default defineLink(
    ProductModule.linkable.product,
    AttributeModule.linkable.attributeValue // Nota: CamelCase 'attributeValue'
)
```

## 3. API & Endpoints

### GET `/admin/products/[id]/attributes`
Este endpoint alimenta el widget del dashboard.

**Puntos Críticos:**
1. **Query Graph:** Debe solicitar `attribute_key.label`, NUNCA `title`.
2. **Manejo de Errores:** Debe estar envuelto en `try-catch` para evitar crashear el frontend si la integridad de datos falla.
3. **Respuesta:** Devuelve `{ attributes: [...] }`.

```typescript
// Ejemplo correcto de Query
const { data: productData } = await query.graph({
    entity: "product",
    fields: [
        "attribute_value.id",
        "attribute_value.value",
        "attribute_value.attribute_key.label", // <-- IMPORTANTE
        // ...
    ],
    // ...
})
```

## 4. Frontend Widget (`ProductAttributesWidget`)

El widget debe ser defensivo contra datos malformados.

**Reglas de Oro:**
1. **Validar Arrays:** Nunca asumir que `attributes` es un array. Usar `Array.isArray(attributes) ? attributes : []`.
2. **Fallbacks de UI:** Si `attribute_key` es null (borrado), mostrar "Unknown" en lugar de crashear.
3. **Uso de Claves:** Usar `attr.attribute_key?.label` para mostrar el nombre.

## 5. Solución de Problemas Comunes

| Síntoma | Causa Probable | Solución |
|---------|---------------|----------|
| **Dropdown vacío** | El frontend busca `title` pero el modelo tiene `label`. | Cambiar `k.title` por `k.label` en el componente React. |
| **Error 500 en API** | Falta relación `values` en `AttributeKey`. | Agregar `values: model.hasMany(...)` al modelo y migrar. |
| **Crash "map is not a function"** | API devuelve objeto o null en lugar de array. | Envolver la variable en `Array.isArray(...)`. |
| **"Error saving attributes"** | Conflicto de IDs o módulo mal referenciado en Link. | Verificar `medusa-config` y nombres de exportación del módulo. |

---
**Generado:** 2026-01-22

# Products — Dynamic Variants System
> **Tipo**: Technical Reference
> **Repo**: backend
> **Última verificación**: 2026-04-02
> **Estado**: ✅ Current

---

## ¿Qué es y por qué existe?

El sistema de variantes dinámicas permite generar automáticamente variantes de producto a partir de combinaciones de atributos (e.g., "12W / Red / E26", "24W / Blue / E26"). Medusa v2 nativo no agrupa variantes por dimensiones de atributo ni genera combinaciones automáticamente.

El sistema convierte AttributeKeys marcados como "variant" en ProductOptions de Medusa, y genera el producto cartesiano de sus valores como ProductVariants.

---

## Arquitectura

```
Admin UI: ManageAttributesModal
    │
    └─► POST /admin/products/:id/attributes
        │   { value_ids: [...], variant_keys: ["key_id_1"] }
        │
        ├─► updateProductAttributesWorkflow   (actualiza links de atributos)
        │
        ├─► [Si se removió variant key] → safeDeleteOptionWorkflow
        │       ├─► findVariantsByOptionStep
        │       ├─► checkVariantSalesStep     (bloquea si hay órdenes)
        │       ├─► deleteVariantsStep
        │       └─► deleteOptionStep
        │
        └─► [Si se agregó variant key] → Variant Generation
                ├─► createProductOptions (una por AttributeKey)
                ├─► Cartesian product de valores
                └─► createProductVariants (N combinaciones)
```

### Subscriber de auditoría

`src/subscribers/protect-managed-options.ts` — reacciona al evento `ProductEvents.PRODUCT_OPTION_DELETED` y loguea la eliminación como audit trail.

---

## Modelo de Datos / Estructura

### Metadata de producto

```typescript
product.metadata = {
  variant_attributes: ["attr_key_id_1", "attr_key_id_2"],  // Keys que generan variantes
  // ... otros campos
}
```

### Variantes generadas

```typescript
// Ejemplo: atributo "Wattage" (12W, 24W) × "Color" (Red, Blue) = 4 variantes
variant.title = "12W / Red"
variant.options = { "Wattage": "12W", "Color": "Red" }
variant.metadata = {
  managed_by: "attributes",       // Marca que es variante gestionada
  variation: "12w-red"            // Slug único
}
variant.manage_inventory = false
```

### ProductOption creado

Por cada `variant_key` se crea un ProductOption en Medusa cuyo `title` es el `label` del AttributeKey correspondiente.

### Límite de combinaciones

Máximo **100 variantes** por producto. El backend rechaza con 400 si el producto cartesiano supera ese límite.

---

## Flujo de Implementación

### Habilitar una variante

1. Usuario marca AttributeKey como "variant" en ManageAttributesModal
2. POST a `/admin/products/:id/attributes` con `variant_keys: ["key_id"]`
3. Backend valida que el key tenga **≥ 2 valores** — rechaza con 400 si no
4. Busca si ya existe ProductOption con ese título — si no existe, crea uno
5. Genera producto cartesiano de valores de los keys **nuevamente agregados** (no los ya existentes)
6. Filtra combinaciones duplicadas (compara contra variantes existentes)
7. Crea N ProductVariants con `metadata.managed_by = "attributes"`
8. Crea PriceSet vacío para cada nueva variante (amount: 0, currency: "usd")

### Deshabilitar una variante

1. Usuario desmarca AttributeKey como "variant"
2. POST con `variant_keys: []` (key removido)
3. Backend detecta keys removidos comparando `product.metadata.variant_attributes` anterior vs nuevo
4. Ejecuta `safeDeleteOptionWorkflow`:
   - Busca variantes del option a eliminar
   - Verifica que ninguna variante tenga líneas de orden (`order_line_item`)
   - Si tiene órdenes: retorna HTTP 400 con lista de `protectedVariants`
   - Si no tiene órdenes: elimina variantes y luego el option
5. Frontend recibe resultado y actualiza UI

### Protección de órdenes existentes

`checkVariantSalesStep` usa `remoteQuery` para verificar `order_line_item.variant_id`. Si encuentra registros, bloquea la eliminación y devuelve los `protectedVariants` al frontend.

---

## API / Interfaces

| Método | Ruta | Propósito |
|--------|------|-----------|
| `GET` | `/admin/products/:id/attributes` | Leer atributos y variant_attributes del producto |
| `POST` | `/admin/products/:id/attributes` | Actualizar atributos + manejar variant generation/deletion |

### Payload POST

```typescript
{
  value_ids: string[],      // Todos los AttributeValue IDs a asignar al producto
  variant_keys?: string[]   // AttributeKey IDs que deben generar variantes
}
```

### Respuestas

```typescript
// Éxito — variantes creadas
{ message: "Attributes and variants updated successfully", variantsCreated: 4 }

// Éxito — sin variantes nuevas necesarias
{ message: "Attributes updated successfully (no new variants needed)", variantsCreated: 0 }

// HTTP 400 — variante con órdenes protegida
{
  error: "Cannot disable variant attribute",
  message: "Some variants have existing orders and cannot be deleted.",
  protectedVariants: ["variant_id_1"],
  details: "Variant variant_id_1: 2 order(s)"
}

// HTTP 400 — pocas opciones para generar variantes
{ message: "Attribute \"Wattage\" needs at least 2 values" }

// HTTP 400 — demasiadas combinaciones
{ message: "Too many combinations: 120. Max 100." }
```

---

## Reglas Críticas

1. **Mínimo 2 valores** para activar un variant key — el backend rechaza con 400 si hay menos
2. **Safe delete obligatorio** — nunca borrar variantes directamente si pueden tener órdenes
3. **`metadata.managed_by = "attributes"`** — marca las variantes como gestionadas por el sistema
4. **Cartesian product solo de keys nuevos** — no regenera variantes para keys ya existentes
5. **Deduplicación activa** — no crea variantes cuya combinación de opciones ya existe
6. **Límite: 100 combinaciones** — el backend rechaza si el cartesiano supera este límite

---

## Archivos Clave

| Tipo | Ruta Completa | Propósito |
|------|---------------|-----------|
| API Route | `backend/src/api/admin/products/[id]/attributes/route.ts` | Orquestación completa: update + generate + safe delete |
| Workflow | `backend/src/workflows/product-attributes/update-product-attributes.ts` | Actualiza links de atributos y metadata |
| Workflow | `backend/src/workflows/variant-cleanup.ts` | `safeDeleteOptionWorkflow` — delete con protección de órdenes |
| Subscriber | `backend/src/subscribers/protect-managed-options.ts` | Audit trail de eliminación de opciones |
| Admin Widget | `backend/src/admin/widgets/product-attributes-widget.tsx` | Widget PDP con tabla de atributos |
| Modal | `backend/src/admin/components/manage-attributes-modal.tsx` | Modal de gestión (combobox searchable) |

---

## Historial de Decisiones

| Fecha | Decisión | Razón |
|-------|----------|-------|
| 2026-01-24 | Safe delete con `checkVariantSalesStep` | Proteger integridad de órdenes existentes |
| 2026-01-24 | `metadata.managed_by = "attributes"` | Distinguir variantes gestionadas de variantes manuales |
| 2026-01-24 | Combobox searchable en modal | La lista de atributos es grande; búsqueda en tiempo real mejora UX |
| 2026-01-24 | Cartesian product solo de keys nuevos | Evitar regeneración de variantes existentes al editar atributos no-variant |
| ~2026-01 | Límite de 100 combinaciones | Prevenir explosión combinatorial accidental |

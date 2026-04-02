# Dev — Query Patterns: remoteQuery vs Knex
> **Tipo**: Technical Reference
> **Repo**: backend
> **Ultima verificacion**: 2026-04-02
> **Estado**: Current

---

## Que es y por que existe

En Medusa v2, hay dos formas de consultar datos: `remoteQuery` (capa de datos de Medusa, type-safe, mas lento) y `knex` (SQL directo, rapido). Usar la incorrecta causa errores en runtime o problemas de performance.

---

## Decision Tree

```
Necesitas consultar datos?
    |
    v
¿Es una entidad de un modulo Medusa?  → Si → remoteQuery()
    |
    No
    |
    v
¿Es una tabla manual (custom)?  → Si → knex()
    |
    No
    |
    v
¿Es un campo JSON metadata?  → Si → acceso directo despues de query
```

---

## Tabla de Decision Rapida

| Entidad | Leer | Escribir | Razon |
|---------|------|---------|-------|
| Product | `remoteQuery()` | `remoteQuery()` | Core Medusa module |
| Product.metadata (actualizar) | — | `knex()` | JSON update |
| ProductCategory | `remoteQuery()` | `remoteQuery()` | Core Medusa module |
| Category.metadata (actualizar) | — | `knex()` | JSON update |
| AttributeKey | `remoteQuery()` | `remoteQuery()` | Medusa module |
| AttributeValue | `remoteQuery()` | `remoteQuery()` | Medusa module |
| AttributeSet | `remoteQuery()` | `remoteQuery()` | Medusa module |
| Product-Attribute Links | `knex()` | `knex()` | Tabla manual (bug de Medusa v2) |

---

## Part 1: remoteQuery (Modulos Medusa)

### Patron basico

```typescript
const remoteQuery = req.scope.resolve("remoteQuery")

const products = await remoteQuery({
    entryPoint: "product",
    fields: ["id", "title", "handle", "metadata"],
    variables: {
        filters: {
            id: "prod_123"
        }
    }
})
```

### Ejemplos por entidad

**Products en una categoria:**
```typescript
const products = await remoteQuery({
    entryPoint: "product",
    fields: ["id", "title", "handle"],
    variables: {
        filters: {
            categories: { id: ["pcat_led_strips"] }
        }
    }
})
```

**AttributeKeys por AttributeSet:**
```typescript
const attributeKeys = await remoteQuery({
    entryPoint: "attribute_key",
    fields: ["id", "handle", "label", "filter_type", "unit"],
    variables: {
        filters: { attribute_set_id: "attrset_lighting" }
    }
})
```

**AttributeValues por key:**
```typescript
const values = await remoteQuery({
    entryPoint: "attribute_value",
    fields: ["id", "value", "attribute_key_id"],
    variables: {
        filters: { attribute_key_id: "attr_key_power" }
    }
})
```

**ProductCategory con metadata:**
```typescript
const categories = await remoteQuery({
    entryPoint: "product_category",
    fields: ["id", "name", "handle", "metadata", "parent_category_id"],
    variables: {
        filters: { id: "pcat_electronics" }
    }
})
// Acceso a metadata directamente
const filterConfig = categories[0]?.metadata?.filter_config
```

---

## Part 2: Knex (Tablas Manuales)

### Obtener Knex

```typescript
const knex = req.scope.resolve("__pg_connection__")
```

### Actualizar metadata (ProductCategory)

```typescript
// NO usar remoteQuery para updates de metadata en tablas con JSONB
await knex("product_category")
    .where({ id: categoryId })
    .update({
        metadata: JSON.stringify({
            ...existingMetadata,  // preservar metadata existente
            filter_config: newFilterConfig
        }),
        updated_at: new Date()
    })
```

### Tabla de Product-Attribute Links

Esta tabla es manual porque el Link Service de Medusa v2 fuerza `UNIQUE(product_id)` → solo 1 atributo por producto. La tabla custom tiene `UNIQUE(product_id, attribute_value_id)` → multiples atributos.

```typescript
const knex = req.scope.resolve("__pg_connection__")

// Get all attribute links for products
const links = await knex("product_product_productattributes_attribute_value")
    .select("product_id", "attribute_value_id")
    .whereIn("product_id", ["prod_1", "prod_2"])

// Count attributes per value (para filtros)
const counts = await knex("product_product_productattributes_attribute_value")
    .select("attribute_value_id")
    .count("* as count")
    .whereIn("product_id", productIds)
    .whereIn("attribute_value_id", valueIds)
    .groupBy("attribute_value_id")

// Get attributes for a single product
const productAttrs = await knex("product_product_productattributes_attribute_value")
    .select("attribute_value_id")
    .where({ product_id: "prod_123" })
```

Schema de la tabla:
```sql
CREATE TABLE "product_product_productattributes_attribute_value" (
    "id" text PRIMARY KEY,
    "product_id" text NOT NULL,
    "attribute_value_id" text NOT NULL,
    "created_at" timestamptz DEFAULT now() NOT NULL,
    "updated_at" timestamptz DEFAULT now() NOT NULL,
    "deleted_at" timestamptz,
    CONSTRAINT "unique_pair" UNIQUE ("product_id", "attribute_value_id")
);
```

Creada via `src/scripts/force-create-link-table.js` (no via migration ORM).

---

## Knex en Fulfillment Providers

Los providers de fulfillment NO pueden acceder al DI container en `calculatePrice`. Reciben Knex via constructor:

```typescript
class GroundShippingService extends AbstractFulfillmentProviderService {
    private knex: Knex.Knex

    constructor({ __pg_connection__ }: { __pg_connection__: Knex.Knex }) {
        super()
        this.knex = __pg_connection__
    }

    async calculatePrice(...): Promise<...> {
        const [settings] = await this.knex("shipping_settings").select(...).limit(1)
    }
}
```

---

## Archivos Clave

| Tipo | Ruta Completa | Proposito |
|------|---------------|-----------|
| Modulo | `backend/src/modules/ground-shipping/service.ts` | Ejemplo de Knex via constructor en provider |
| Script | `backend/src/scripts/force-create-link-table.js` | Crea tabla de links manualmente |
| Doc | `backend/docs/PRODUCT_ATTRIBUTES_ARCHITECTURE.md` | Contexto del "Nuclear Option" para attributes |

---

## Historial de Decisiones

- **Tabla manual para Product-Attribute Links**: Medusa v2 Link Service fuerza `UNIQUE(product_id)`. La tabla manual tiene `UNIQUE(product_id, attribute_value_id)` para soportar multiples atributos por producto.
- **Knex para metadata updates**: MikroORM de Medusa no siempre mergea JSONB correctamente. Para actualizar campos especificos de metadata sin sobrescribir el resto, Knex con `JSON.stringify({...existingMetadata, ...newFields})` es mas predecible.

# BUG: Order Totals Incorrectos en Admin Panel — Medusa v2.13.0

> **Estado**: ✅ RESUELTO (2026-02-25)  
> **Versión afectada**: `@medusajs/order@2.13.0`, `@medusajs/core-flows@2.13.0`  
> **Issue upstream**: [Medusa #14628](https://github.com/medusajs/medusa/issues/14628)  
> **Aplica a**: Admin List `/app/orders` y cualquier endpoint que calcule totales sin solicitar `items.*`

---

## Resumen Ejecutivo

El Admin Panel mostraba `$16.04` para órdenes cuyo total correcto era `$70.88`. El problema **no era de datos** — la base de datos tenía los totales correctos en `order_summary`. El bug era puramente un problema de **cómo Medusa recupera y calcula los totales en memoria** al momento de servir la respuesta del API.

---

## Síntomas

| Vista | Síntoma | Valor incorrecto | Valor correcto |
|-------|---------|-----------------|---------------|
| Admin List `/app/orders` | Columna "Order Total" | `$16.04` | `$70.88` |
| Admin Detail `/app/orders/:id` | Detalle de order | ✅ Correcto | `$70.88` |
| Frontend `/account/orders/:id` | QTY en líneas | Vacío/NaN | `1` |

El `$16.04` era exactamente = `shipping ($14.99) + tax ($4.64 × mismatch)` — los ítems contribuían `$0` porque su `quantity` era `undefined`.

---

## Anatomía del Bug (Capas)

### Capa 1: `addRelationsToCalculateTotals` — el origen del problema

**Archivo**: `@medusajs/order/src/services/order-module-service.ts` (dist: `order-module-service.js` líneas ~190-210)

Cuando el Admin List solicita `?fields=id,status,total,...` (sin `*items`), Medusa detecta que se necesita calcular totales y llama a `shouldIncludeTotals` → `addRelationsToCalculateTotals`.

Esta función agregaba `items` como **relación** (JOIN) para que MikroORM cargue los ítems. **Pero nunca agregaba** `items.quantity` ni `items.unit_price` al **select** de campos. Result: MikroORM cargaba los ítems pero **potencialmente sin los campos necesarios** para el cálculo.

```
Admin request: ?fields=id,status,total  (sin items.*)
  └─ shouldIncludeTotals → addRelationsToCalculateTotals
       └─ Agrega "items" a relations  ← ✅ join existe
       └─ NO agrega items.quantity al select  ← ❌ field podría estar undefined
  └─ decorateCartTotals(order)
       └─ unit_price × undefined quantity = NaN  ← ❌ total = $0 para items
  └─ total = NaN_items + shipping ($14.99) + tax = ~$16.04  ← bug visible
```

### Capa 2: `mapRepositoryToOrderModel` — wildcard incorrecto

**Archivo**: `@medusajs/order/src/utils/transform-order.ts` (dist: `transform-order.js` líneas ~147-175)

El código original de Medusa tenía:
```js
if (rel == "items.quantity") {
    obj.populate.push("items.item");
    return "items.item.quantity";  // ← INCORRECTO
}
```

En el modelo de datos de Medusa v2:
- `OrderItem` (tabla `order_item`) → tiene `quantity`, `unit_price`, `version`
- `OrderLineItem` (tabla `order_line_item`) → tiene `title`, `thumbnail`, `sku`, etc.
- `mainOrder.items` = array de `OrderItem` (la entidad que tiene `quantity`)
- `OrderItem.item` = referencia al `OrderLineItem` correspondiente

Al retornar `"items.item.quantity"`, el ORM buscaba `OrderLineItem.quantity` — **que no existe**. La quantity correcta está en `OrderItem.quantity` directamente (sin `.item`).

Además, esta lógica de wildcard también mapeaba incorrectamente:

```
items.X  →  items.item.X   (wildcard genérico)
```

Esto es correcto para campos de catálogo (`items.title` → `OrderLineItem.title`), pero **incorrecto** para los campos propios del `OrderItem` como `quantity`, `unit_price`, `version`.

### Capa 3: `loadItemAdjustments` — requiere `item.version`

**Archivo**: `@medusajs/order/src/utils/base-repository-find.ts` (líneas ~244-174)

Cuando se cargan los adjustment de los ítems:
```js
async function loadItemAdjustments(orders) {
    const items = orders.flatMap(r => [...(r.items ?? [])]);
    const params = items.map(i => {
        if (!i.version) {
            throw new Error("Item version is required to load adjustments");  // ← 500!
        }
        return { item_id: i.item.id, version: i.version };
    });
}
```

`i.version` es `OrderItem.version` (la versión de la orden en que se creó/modificó el ítem). Si MikroORM no carga este campo (porque no está en el SELECT explícito), arroja un error 500.

El código en `base-repository-find.js` intenta auto-detectar si necesita cargar `version`:
```js
if (config.options.fields?.some(f => f.includes("items.item."))) {
    config.options.fields.push("items.version");  // auto-agrega version si hay items.item.*
}
```
Pero esto solo funciona si hay campos `items.item.*` en el select. Si el select solo tiene `["items.quantity", "items.unit_price"]` (nuestros campos explícitos sin `items.item.*`), la condición falla y `version` no se carga → 500.

---

## La Solución Implementada

### Patch 1: `@medusajs/order` — tres cambios

**Archivo 1**: `dist/utils/transform-order.js` — `protectedItemFields`

```js
// ANTES (Medusa original):
if (rel == "items.quantity") {
    obj.populate.push("items.item");
    return "items.item.quantity";  // ← busca OrderLineItem.quantity (no existe)
}

// DESPUÉS (nuestro patch):
const protectedItemFields = [
    "items.quantity", "items.raw_quantity",
    "items.version",      // ← crítico para loadItemAdjustments
    "items.unit_price", "items.raw_unit_price"
];
if (protectedItemFields.includes(rel)) {
    if (type === "fields") {
        obj.populate.push("items.item");
    }
    return rel;  // ← mantiene como items.quantity = OrderItem.quantity ✅
}
```

**Archivo 2**: `dist/services/order-module-service.js` — `addRelationsToCalculateTotals`

```js
// NUEVO: agrega campos explícitos cuando no hay *items wildcard
const hasWildcardItems = (config.select ?? []).some(
    f => f.includes("items.*") || f.startsWith("*items")
);
const requiredItemFieldsForTotals = [
    "items.version",       // ← necesario para loadItemAdjustments
    "items.quantity",      // ← necesario para decorateCartTotals
    "items.raw_quantity",
    "items.unit_price",    // ← necesario para decorateCartTotals
    "items.raw_unit_price",
];
if (!hasWildcardItems) {
    config.select = deduplicate([...config.select, ...requiredItemFieldsForTotals]);
}
// ... filter mantiene como includes() en vez de startsWith() (fix #14628)
```

**Por qué el guard `!hasWildcardItems`?** — El Admin Detail solicita `*items` (todos los campos de items). En ese caso, MikroORM cargaría TODOS los campos por defecto. Agregar campos explícitos **restringe** MikroORM a solo esos campos, rompiendo la carga de otros que el Detail necesita. El guard evita este conflicto.

**Archivo 3**: `dist/services/order-module-service.js` — `createOrderLineItemsBulk_`

```js
// Agregamos unit_price y raw_unit_price al crear OrderItem:
await this.orderItemService_.create({
    version: toCreate.version ?? 1,
    item_id: item.id,
    quantity: toCreate.quantity,
    // Nuestro fix: estos campos faltaban
    unit_price: toCreate.unit_price,
    raw_unit_price: toCreate.raw_unit_price,
    compare_at_unit_price: toCreate.compare_at_unit_price,
    raw_compare_at_unit_price: toCreate.raw_compare_at_unit_price,
});
```

Esto asegura que **futuras órdenes** creen el `OrderItem` con `unit_price` guardado directamente en la tabla `order_item` (no solo en `order_line_item`).

**También**: el filtro de `addRelationsToCalculateTotals` cambió de `val.startsWith(field)` a `val === field` (includes) para no stripear sub-campos accidentalmente.

**Patch 2**: `@medusajs/core-flows` — `get-orders-list.js`

```js
// Agrega "summary" como campo garantizado en el list workflow
const guaranteedFields = ["id", "status", "summary", ...];
```

Esto añade el campo `summary` a la query del Admin List, permitiendo que el admin tenga acceso a `order.summary.original_order_total` como respaldo con los totales pre-calculados de PostgreSQL.

---

## Archivos de Patch

Los patches están en `backend/patches/`:

```
patches/
├── @medusajs+core-flows+2.13.0.patch   # Agrega "summary" al list workflow
└── @medusajs+order+2.13.0.patch        # Tres fixes descritos arriba
```

Se aplican automáticamente vía `patch-package` gracias a:
```json
// backend/package.json
{ "scripts": { "postinstall": "patch-package" } }
```

**Y explícitamente en Railway** — `patch-package` corre en la **fase install** (no en build) para que quede **baked-in en el cache de Nixpacks**:

```toml
# backend/nixpacks.toml
[phases.install]
# El texto del echo es parte de la clave de cache de Nixpacks.
# Si necesitas re-aplicar patches (ej. al cambiar un .patch file),
# cambia el número de versión (v2 → v3) para invalidar el cache.
cmds = ["echo '--- INSTALL v2 (with patches) ---'", "yarn install --frozen-lockfile", "npx patch-package"]

[phases.build]
cmds = ["yarn build"]
```

**¿Por qué en install y no en build?**

Nixpacks cachea el resultado de la **fase install** (incluye `node_modules` patched). La **fase build** no se cachea. Si `patch-package` estuviera en build, correría en **cada deployment** (~10s de overhead). Al ponerlo en install:
- **1er deploy después de un cambio**: cache miss → install fresh + patch-package → cache guardado con patches ✅
- **Deploys siguientes**: cache hit → `node_modules` ya parchado, `patch-package` no corre → rápido ✅

**¿Cuándo necesitas invalidar el cache?**

Solo cuando cambies los archivos `.patch` (ej. al actualizar Medusa). Para eso, cambia el echo en `nixpacks.toml`:
```toml
# Antes:
"echo '--- INSTALL v2 (with patches) ---'"
# Después del cambio:  
"echo '--- INSTALL v3 (with patches) ---'"
```

Esto cambia el hash del comando de install → Railway hace fresh install → patches nuevos se aplican → nuevo cache guardado.

---

## Por qué el Admin Detail (`/app/orders/:id`) no tenía el bug original

El Detail solicita `?fields=...,*items,...` — con `*items` (wildcard). Esto le dice a MikroORM que cargue **todos** los campos del `OrderItem` incluyendo `quantity` y `unit_price`. Por eso el cálculo de totales era correcto en el detail.

El List en cambio solo pedía `?fields=id,status,total,...` — sin `*items`. Ahí estaba el problema.

---

## Diagnóstico Rápido (si el bug reaparece)

```bash
# 1. Verificar en DB que el total correcto existe
psql $DATABASE_URL -c "
  SELECT o.display_id, os.original_order_total, os.current_order_total
  FROM \"order\" o
  JOIN order_summary os ON os.order_id = o.id
  WHERE o.display_id = 1058;"

# 2. Verificar que order_item tiene unit_price
psql $DATABASE_URL -c "
  SELECT oi.quantity, oi.unit_price, oli.unit_price as line_unit_price
  FROM order_item oi
  JOIN order_line_item oli ON oli.id = oi.item_id
  WHERE oi.order_id = (SELECT id FROM \"order\" WHERE display_id = 1058)
  LIMIT 5;"

# 3. Verificar que los patches están aplicados
grep -n "protectedItemFields" backend/node_modules/@medusajs/order/dist/utils/transform-order.js
grep -n "requiredItemFieldsForTotals" backend/node_modules/@medusajs/order/dist/services/order-module-service.js
```

---

## Lista de Verificación al Actualizar Medusa

> ⚠️ **IMPORTANTE**: Cuando actualices `@medusajs/order` o `@medusajs/core-flows` a una versión nueva, los siguientes checks son **obligatorios**.

```
□ 1. Ejecutar: npx patch-package --error-on-fail
      Si falla → el patch ya no aplica limpiamente → necesita re-implementarse

□ 2. Verificar en transform-order.js que aún existe el bloque "protectedItemFields"
      grep "protectedItemFields" node_modules/@medusajs/order/dist/utils/transform-order.js

□ 3. Verificar que "items.version" está en protectedItemFields
      (sin este, Admin Detail da 500: "Item version is required to load adjustments")

□ 4. Verificar que addRelationsToCalculateTotals agrega explícitamente items.quantity/version/unit_price
      grep "requiredItemFieldsForTotals" node_modules/@medusajs/order/dist/services/order-module-service.js

□ 5. Verificar que el filter usa .includes() no .startsWith()
      grep "requiredRelationsForTotals.includes" node_modules/@medusajs/order/dist/services/order-module-service.js

□ 6. Verificar que get-orders-list.js incluye "summary" en los campos garantizados
      grep '"summary"' node_modules/@medusajs/core-flows/dist/order/workflows/get-orders-list.js

□ 7. Test funcional en local:
      - Admin List /app/orders → orden activa debe mostrar total correcto
      - Admin Detail /app/orders/:id → debe cargar sin error 500
      - Frontend /account/orders/:id → QTY debe mostrar número (no vacío)

□ 8. Si la nueva versión de Medusa corrigió alguno de estos bugs upstream,
      eliminar el patch correspondiente del archivo .patch (o regenerar con patch-package)
```

---

## Contexto de la Base de Datos

Las órdenes ANTERIORES al patch de `createOrderLineItemsBulk_` pueden tener `order_item.unit_price = NULL`. Si se necesita corregir órdenes históricas:

```sql
-- Script para backfill de unit_price en order_item desde order_line_item
UPDATE order_item oi
SET 
    unit_price = oli.unit_price,
    raw_unit_price = oli.raw_unit_price
FROM order_line_item oli
WHERE oi.item_id = oli.id
  AND oi.unit_price IS NULL
  AND oli.unit_price IS NOT NULL;
```

Un script TypeScript para esto existe en `backend/src/scripts/checks/check-cancelled-order-totals.ts`.

---

## Historial de Cambios

| Fecha | Cambio | Efecto |
|-------|--------|--------|
| 2026-02-24 | Primera versión del patch (`protectedItemFields` + filter fix) | Admin Detail funcionaba mejor; List aún mostraba totales incorrectos |
| 2026-02-25 | `addRelationsToCalculateTotals` con campos explícitos (sin `items.version`) | List mejoró transitoriamente; Detail dio 500 ("Item version...") |
| 2026-02-25 | Agregado `items.version` a `protectedItemFields` y a `requiredItemFieldsForTotals` | Ambas vistas funcionan correctamente ✅ |
| 2026-02-25 | `nixpacks.toml` con `npx patch-package` en fase build | Patches se aplican en Railway aunque haya cache de node_modules ✅ |

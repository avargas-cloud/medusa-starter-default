# Dev — Medusa Patches y Bugs Conocidos
> **Tipo**: Technical Reference
> **Repo**: backend
> **Ultima verificacion**: 2026-04-02
> **Estado**: Current — Todos los patches aplicados en produccion

---

## Que es y por que existe

EcoPowerTech aplica patches al codigo de Medusa v2 para corregir bugs que afectan la operacion. Los patches se aplican via `patch-package` en el postinstall hook y se propagan a produccion via un script post-build.

---

## Mecanismo de Patches

```
Development:
  yarn install → postinstall: patch-package → patches aplicados en node_modules ✓

Production (Railway/Railpack):
  medusa build → .medusa/server/ (npm install fresco, patches se pierden)
  node scripts/post-build.js:
    ↓ Copia patches/ → .medusa/server/patches/
    ↓ Inyecta "postinstall": "npx --yes patch-package" en .medusa/server/package.json
  cd .medusa/server && npm install --omit=dev
  → postinstall: npx --yes patch-package ← patches aplicados en produccion ✓
```

### Archivos de patches activos

```
backend/patches/
├── @medusajs+order+2.13.0.patch      # 3 fixes: totales de orden
├── @medusajs+core-flows+2.13.0.patch # get-orders-list + discount-aware tax
└── @medusajs+utils+2.13.1.patch      # utils fix
```

### Verificar que patches estan aplicados

```bash
grep -n "protectedItemFields" backend/node_modules/@medusajs/order/dist/utils/transform-order.js
grep -n "requiredItemFieldsForTotals" backend/node_modules/@medusajs/order/dist/services/order-module-service.js
```

### CRITICO al actualizar packages patcheados

```bash
npx patch-package --error-on-fail
# Si falla → el patch necesita re-implementarse para la nueva version
```

---

## Patch 1 — Order Totals Bug (@medusajs/order@2.13.0)

**Fecha**: Febrero 24-25, 2026. **Estado**: En produccion.

### El bug

El Admin Panel mostraba totales incorrectos (ej: `$16.04` en lugar de `$70.88`). Solo afectaba la vista de Lista de ordenes, no el Detail.

### Causa raiz (3 capas)

**Capa 1 (`transform-order.js` — `mapRepositoryToOrderModel`):**
Mapeaba `items.quantity` → `items.item.quantity`, buscando `OrderLineItem.quantity` que no existe. La quantity correcta vive en `OrderItem.quantity` (tabla `order_item`), no en `OrderLineItem` (tabla `order_line_item`).

**Capa 2 (`order-module-service.js` — `addRelationsToCalculateTotals`):**
El Admin List pedia ordenes sin `*items`. Medusa agregaba `items` como relacion (JOIN) pero nunca agregaba `items.quantity` ni `items.unit_price` al SELECT → `unit_price × undefined = NaN` → total incorrecto.

**Capa 3 (`base-repository-find.js` — `loadItemAdjustments`):**
Requiere `item.version` para cargar adjustments. Si `version` no esta en el SELECT → error 500.

### Solucion aplicada

**`transform-order.js` — `protectedItemFields`:**
Lista de campos que viven en `OrderItem` y NO deben ser remapeados a `items.item.*`:
```javascript
const protectedItemFields = [
    "items.quantity", "items.raw_quantity",
    "items.version",  // critico para loadItemAdjustments
    "items.unit_price", "items.raw_unit_price",
    // ... fulfillment fields
]
```

**`order-module-service.js` — `addRelationsToCalculateTotals`:**
Inyecta siempre los campos requeridos para calcular totales:
```javascript
const requiredItemFieldsForTotals = [
    "items.version", "items.quantity", "items.unit_price", ...
]
config.select = deduplicate([...config.select, ...requiredItemFieldsForTotals])
```

**`order-module-service.js` — `createOrderLineItemsBulk_`:**
Persiste `unit_price` y `raw_unit_price` directamente en `order_item` al crear ordenes.

### Backfill para ordenes historicas

```sql
-- Para ordenes con unit_price NULL en order_item
UPDATE order_item oi
SET unit_price = oli.unit_price, raw_unit_price = oli.raw_unit_price
FROM order_line_item oli
WHERE oi.item_id = oli.id
  AND oi.unit_price IS NULL
  AND oli.unit_price IS NOT NULL;
```

### Diagnostico rapido si el bug reaparece

```bash
# 1. Verificar total en DB
psql $DATABASE_URL -c "
  SELECT o.display_id, os.original_order_total, os.current_order_total
  FROM \"order\" o
  JOIN order_summary os ON os.order_id = o.id
  WHERE o.display_id = 1058;"

# 2. Verificar que patches estan aplicados
grep -n "protectedItemFields" backend/node_modules/@medusajs/order/dist/utils/transform-order.js
```

---

## Patch 2 — get-orders-list (@medusajs/core-flows@2.13.0)

**Fecha**: Marzo 17, 2026. **Estado**: En produccion.

Agrega `"summary"` como campo garantizado en el workflow de lista de ordenes. Permite usar `order.summary.original_order_total` (pre-calculado en PostgreSQL) como respaldo cuando el calculo en memoria falla.

---

## Patch 3 — @medusajs/utils@2.13.1

**Fecha**: Marzo 2026. **Estado**: En produccion.

Fix puntual de utils (ver el archivo `.patch` para detalles exactos).

---

## Bug: Tax Duplicado y Discount-Aware Tax

**Fecha**: Marzo 16, 2026. **Estado**: Resuelto via endpoints SQL — NO via patch.

### El problema

Florida Administrative Code Rule 12A-1.003: el impuesto debe calcularse sobre el precio **despues** de descuentos. Medusa nativo calcula sobre precio bruto.

Adicionalmente, el sub-region `us-fl` tenia el provider nativo `tp_system` que generaba una segunda linea `manual (7.00%)`, duplicando el tax.

**Ejemplo Order #1107:**
- Tax Medusa nativo: `7% × $50.48 = $3.53` (incorrecto)
- Tax correcto (FL law): `7% × ($50.48 - $2.52) = $3.36`
- Tax con duplicado: `$3.53 × 2 = $7.07`

### Por que no se parcheo el core

- `PosTaxProvider` ignora `unit_price` — retorna solo `rate=7`. Modificar `normalizeLineItemsForTax` no tiene efecto.
- Agregar `items.adjustments.*` al query del workflow causo efectos secundarios (discount total cambiaba de $2.52 → $2.67).
- El approach SQL directo es mas predecible.

### Solucion implementada (endpoints especializados)

| Endpoint | Cuando se llama | Que hace |
|----------|----------------|---------|
| `/admin/draft-orders/[id]/compute-tax` | Al crear draft order | Calcula `computed_tax_amount` en metadata |
| `/admin/draft-orders/[id]/convert-force` | Al convertir draft → order | Inyecta lineas FL/EXEMPT directamente en SQL |
| `/admin/draft-orders/[id]/add-shipping-force` | Agregar shipping a draft | Bypass del workflow (AwilixResolutionError) |
| `/admin/orders/[id]/post-edit-sync` | Despues de edit | Parcha `order_summary.totals` JSONB + inyecta tax lines |
| `/admin/orders/[id]/apply-discount-force` | Aplicar descuento | Elimina lineas viejas e inserta correctas |

**Subscriber:** `tax-fix-subscriber.ts` corre en `order.placed` y `order-edit.confirmed`. Elimina filas de `order_line_item_tax_line` donde `code NOT IN ('FL', 'FL-SHIPPING', 'EXEMPT')`.

### Por que hay AwilixResolutionError en add-shipping

```sql
SELECT id, country_code, provider_id FROM tax_region;
-- us    → provider_id = '' (empty string)
-- us-fl → provider_id = '' (check constraint impide UPDATE)
```

`addDraftOrderShippingMethodsWorkflow` llama a `getTaxLines → retrieveProvider('')` → AwilixResolutionError. No se puede corregir via UPDATE por el check constraint. Solucion: INSERT SQL directo bypaseando el workflow.

---

## Bug: Subscribers de Modulos No Se Disparan

**Fecha**: Enero 28, 2026. **Estado**: Documentado y workaround implementado.

### El bug

En Medusa v2, los event subscribers no se disparan para eventos de modulos de productos, customers e inventario. Causa: cada modulo usa su propio bus de eventos interno que no propaga al bus global.

**Evidencia:**
- Modulos custom en `src/modules/` → subscribers funcionan
- `@medusajs/*` packages → subscribers fallan con algunos eventos
- Emitir manualmente desde una API route → subscribers funcionan

### Workaround (3 capas)

EcoPowerTech usa subscribers + jobs schedulados (no middleware HTTP response interception):

1. **Capa 1 — Subscribers** (inmediato, para eventos que si funcionan)
2. **Capa 2 — Reconciliation Jobs** (cada 5 minutos, catch-all)
3. **Capa 3 — Sync Manual** (boton en Admin Panel)

**Subscribers activos que funcionan:**
- `customer-meilisearch-sync.ts` — sync a MeiliSearch al actualizar customers
- `product-thumbnail-sync.ts` — sync de thumbnails
- `tax-fix-subscriber.ts` — elimina lineas tax duplicadas
- `qb-*` — QuickBooks sync subscribers

### Patron de middleware (alternativa documentada, no en uso actualmente)

```typescript
// Patron para cuando los subscribers fallan — interceptar la respuesta HTTP
async function syncMiddleware(req, res, next) {
    const originalJson = res.json.bind(res)  // .bind(res) es CRITICO
    res.json = (data: any) => {
        if (data?.product) {
            setImmediate(async () => {  // setImmediate es CRITICO — no bloquea la respuesta
                // Re-fetch con relaciones (la respuesta HTTP es minima)
                const [fullProduct] = await productModule.listProducts(
                    { id: [data.product.id] },
                    { relations: ["variants"] }
                )
                await index.addDocuments([transformProduct(fullProduct)])
            })
        }
        return originalJson(data)
    }
    next()
}
```

---

## Bug: Cart Race Condition (Frontend)

**Fecha**: Febrero 12, 2026. **Estado**: Resuelto en frontend. **Repo**: frontend (documentado aqui por referencia cruzada).

### El bug

Race condition en el cart store causaba cantidades incorrectas cuando el usuario hacia clic rapidamente en los botones +/-. 20 clics → cantidad 231 en lugar de 21.

### Causas

1. **Optimistic Update Corruption**: Delta se aplicaba a la cantidad ya modificada en estado optimista. Formula incorrecta: `optimisticQty + delta`. Correcta: `baseQty + delta`. Resultado: suma de serie aritmetica (1+2+3+...+20 = 210).

2. **Stale Closure**: Callback del debounce capturaba `item.quantity` al momento del primer click (stale despues de 2.5s).

3. **Debounce muy corto**: 200ms original vs ~2s de response time del API → requests solapados causando 404.

### Solucion

```typescript
// Mapa que guarda la cantidad real antes de optimistic updates
const baseQuantities = new Map<string, number>()

// Al primer delta de una linea:
const baseQuantity = baseQuantities.get(lineId) || item.quantity
const newQuantity = baseQuantity + accumulatedDelta  // siempre desde la base

// Debounce aumentado a 2500ms
// Cleanup despues de confirmacion del servidor:
baseQuantities.delete(lineId)
```

**Archivo:** `frontend/src/features/cart/stores/cartStore.ts`

---

## Archivos Clave de Patches

| Tipo | Ruta Completa | Proposito |
|------|---------------|-----------|
| Patch | `/home/alejo/webapps/ecopowertech-workspace/backend/patches/@medusajs+order+2.13.0.patch` | 3 fixes de order totals |
| Patch | `/home/alejo/webapps/ecopowertech-workspace/backend/patches/@medusajs+core-flows+2.13.0.patch` | get-orders-list + discount-aware |
| Patch | `/home/alejo/webapps/ecopowertech-workspace/backend/patches/@medusajs+utils+2.13.1.patch` | Utils fix |
| Script | `/home/alejo/webapps/ecopowertech-workspace/backend/scripts/post-build.js` | Propaga patches a .medusa/server/ |
| Subscriber | `/home/alejo/webapps/ecopowertech-workspace/backend/src/subscribers/tax-fix-subscriber.ts` | Elimina lineas tax duplicadas |
| Route | `/home/alejo/webapps/ecopowertech-workspace/backend/src/api/admin/draft-orders/[id]/compute-tax/route.ts` | Tax computation |
| Route | `/home/alejo/webapps/ecopowertech-workspace/backend/src/api/admin/draft-orders/[id]/convert-force/route.ts` | Draft → Order con tax correcto |
| Route | `/home/alejo/webapps/ecopowertech-workspace/backend/src/api/admin/orders/[id]/post-edit-sync/route.ts` | Sync post-edit de order |
| Modulo | `/home/alejo/webapps/ecopowertech-workspace/backend/src/modules/pos-tax/service.ts` | PosTaxProvider — retorna rate=7 o 0 |

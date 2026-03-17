# Fix: Draft Order List View — Totals Incorrectos

> **Fecha:** 2026-03-17  
> **Estado:** ✅ RESUELTO

---

## Síntomas

| Vista | Entorno | Síntoma | Causa |
|-------|---------|---------|-------|
| Lista /draft-orders-advanced | **Producción** | `$0.00` (solo shipping) | Parche `@medusajs/order` no aplicado |
| Lista /draft-orders-advanced | **Desarrollo** | Total sin taxes | `order.total` calculado sin tax_lines |
| Detalle /draft-orders-advanced/:id | Ambos | ✅ Correcto | Detail sí carga todos los campos |

---

## Causa Raíz (3 capas)

### 1. UI: Prioridad de fuente de total incorrecta

`draft-orders-table.tsx` usaba `order.total` como fuente primaria. Pero `order.total`:
- En **desarrollo**: calculado en memoria sin `tax_lines` → = subtotal (sin taxes)
- En **producción**: calculado sin `items.quantity/unit_price` si el parche falla → = solo shipping

### 2. Railway: `post-build.js` era un stub vacío

El script solo hacía `process.exit(0)`. En producción, el flujo es:

```
yarn install --frozen-lockfile
  → postinstall: patch-package  ← aplica parches al build workspace ✅
medusa build
  → genera .medusa/server/ con npm install FRESCO (borra parches) ❌
Railway deploy: cd .medusa/server && npm install --omit=dev
  → sin postinstall → parches NUNCA aplicados en producción
```

### 3. Railway: Ignoraba `nixpacks.toml`

Railpack 0.19.0 tiene su propio plan — `nixpacks.toml` solo aplica para Nixpacks. Nuestros custom cmds en ese archivo eran ignorados completamente.

---

## Fixes Aplicados

### Fix 1: UI — Prioridad de totales
**Archivo:** `src/admin/routes/draft-orders-advanced/components/draft-orders-table.tsx`  
**Archivo:** `src/admin/routes/draft-orders-advanced/hooks/use-draft-orders.tsx`

```typescript
// ANTES (buggy): order.total primero (puede ser parcial)
order.total ?? order.metadata?.computed_total

// DESPUÉS (correcto): computed_total primero (guardado por compute-tax)
order.metadata?.computed_total ?? order.total
```

`metadata.computed_total` es guardado explícitamente por `GET /admin/draft-orders/:id/compute-tax`:
```typescript
computed_total = discountedSubtotal + shippingSubtotal + taxAmount
// = items - descuentos + taxes + shipping ✅
```

### Fix 2: `package.json` — build script
```json
// ANTES:
"build": "medusa build"

// DESPUÉS:
"build": "medusa build && node scripts/post-build.js"
```

Railpack ejecuta `npm run build`, entonces el post-build.js corre automáticamente.

### Fix 3: `scripts/post-build.js` — inject postinstall
El script ahora:
1. Copia `patches/` → `.medusa/server/patches/`
2. Inyecta `"postinstall": "npx --yes patch-package"` en `.medusa/server/package.json`

**NO** intenta ejecutar `patch-package` directamente (`.medusa/server/node_modules` no existe en build time).

Los parches se aplican durante el **deploy step** de Railway:
```bash
cd .medusa/server && npm install --omit=dev --legacy-peer-deps
# → triggers postinstall: npx --yes patch-package
# → @medusajs/order@2.13.0 ✔
# → @medusajs/core-flows@2.13.0 ✔
# → @medusajs/utils@2.13.1 ✔
```

---

## Flujo Correcto Post-Fix (Railway)

```
yarn install --frozen-lockfile
  → postinstall: patch-package (build workspace)

npm run build
  → medusa build (genera .medusa/server/ limpio)
  → node scripts/post-build.js:
      📋 Copies patches/ → .medusa/server/patches/
      ✅ Injects postinstall='npx --yes patch-package'
      ✅ post-build.js complete.

Deploy: cd .medusa/server && npm install --omit=dev --legacy-peer-deps
  → postinstall: npx --yes patch-package
  → @medusajs/order@2.13.0 ✔  (items.quantity/unit_price fix)
  → @medusajs/core-flows@2.13.0 ✔  (discount-aware tax + summary field)
  → @medusajs/utils@2.13.1 ✔

npm start → servidor con parches activos ✅
```

---

## Resultado Esperado (Producción Post-Deploy)

Para órdenes que tienen `metadata.computed_total` guardado:
- Lista muestra el total correcto: **items - descuentos + taxes + shipping**

Para órdenes muy antiguas sin `computed_total` en metadata:
- Fallback a `order.total` que ahora debería ser correcto (parches aplicados)
- Si siguen en $0: abrir el detalle → ya compute-tax guarda el `computed_total`

---

## Diagnóstico Rápido si el Bug Reaparece

```bash
# Verificar que los parches están aplicados en producción
# (conectar a Railway shell y ejecutar):
grep "protectedItemFields" node_modules/@medusajs/order/dist/utils/transform-order.js
grep "requiredItemFieldsForTotals" node_modules/@medusajs/order/dist/services/order-module-service.js
grep '"summary"' node_modules/@medusajs/core-flows/dist/order/workflows/get-orders-list.js

# Si no aparecen → el postinstall no corrió → revisar .medusa/server/package.json:
cat .medusa/server/package.json | grep postinstall
```

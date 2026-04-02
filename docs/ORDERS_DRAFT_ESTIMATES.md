# Orders — Draft Orders & Estimates (Advanced UI)
> **Tipo**: Technical Reference
> **Repo**: backend
> **Última verificación**: 2026-04-02
> **Estado**: ✅ Current

---

## ¿Qué es y por qué existe?

El sistema de Draft Orders cubre el ciclo completo de cotizaciones (Estimates) en el admin de Medusa. Es una UI avanzada que reemplaza la vista nativa de draft orders con edición inline de items, dual pricing (Default/Wholesale), tax management, drag-to-reorder, y sincronización con QuickBooks Desktop.

También documenta los fixes críticos del bug de totales incorrectos en la vista de lista (producción mostraba $0.00) y el sistema de descuentos POS.

---

## Arquitectura General

```
Admin Panel (Medusa) — /draft-orders-advanced/:id
    │
    ├── Edición inline de items (add/update/delete force)
    ├── Dual pricing: Default retail / Wholesale por ítem
    ├── Tax management: FL 7% o Tax Exempt
    ├── Store Pickup / Shipping
    ├── Drag-to-reorder con sort_order persistente
    ├── Estimate PDF (Puppeteer + Chrome)
    ├── Email via Resend (PDF adjunto)
    ├── QB Sync: Estimate → Sales Order
    └── Note Presets: presets por grupo para el campo de notas

POS (store-pos) — /estimates/:id
    └── Mismo flujo, UI adaptada para 1080p
```

---

## Features Implementadas

| Feature | Estado |
|---------|--------|
| Vista avanzada en `/draft-orders-advanced/:id` | ✅ |
| Dual pricing (Default/Wholesale) por ítem | ✅ |
| Tax management (FL 7% o Tax Exempt) | ✅ |
| Store Pickup auto-rellena dirección de tienda | ✅ |
| Estimate PDF (Puppeteer) | ✅ |
| Print in Store (iframe oculto) | ✅ |
| Email via Resend (PDF adjunto) | ✅ |
| Per-field Customer Defaults (botones azules) | ✅ |
| Activity Timeline con Email Sent atribuido | ✅ |
| Auto-status Created → Sent al enviar email | ✅ |
| QB Sync (crear/actualizar/cerrar Estimate) | ✅ |
| QB IsActive Fix en EstimateMod | ✅ |
| Cancel Draft Order → desactiva QB Estimate | ✅ |
| Delete Draft Order → elimina permanentemente | ✅ |
| Show Cancelled filter (con counter) | ✅ |
| Show Declined filter | ✅ |
| Auto-reactivate al re-sincronizar Cancelled | ✅ |
| Hard delete de line items (no zombie qty=0) | ✅ |
| Drag-to-reorder con sort_order persistente | ✅ |
| Convert-Force endpoint con backorder fallback | ✅ |
| Note Presets (4 grupos, seed automático) | ✅ |
| Descuentos POS (nuevos + existentes) | ✅ |
| Backlighting project link | ✅ |

---

## Custom Backend Endpoints

### Draft Orders — Force Endpoints

Los endpoints "force" bypasean las validaciones de Medusa para ediciones directas de draft orders desde el POS:

| Método | Ruta | Descripción |
|--------|------|-------------|
| `POST` | `/admin/draft-orders/:id/add-item-force` | Agregar ítem sin validación |
| `POST` | `/admin/draft-orders/:id/update-item-force` | Actualizar qty/precio sin validación |
| `POST` | `/admin/draft-orders/:id/delete-item-force` | Hard delete de línea (no qty=0) |
| `POST` | `/admin/draft-orders/:id/add-shipping-force` | Agregar shipping sin validación |
| `DELETE` | `/admin/draft-orders/:id/remove-shipping/:methodId` | Remover shipping |
| `GET` | `/admin/draft-orders/:id/compute-tax` | Calcular impuesto + persistir en metadata |
| `GET` | `/admin/draft-orders/:id/variant-prices` | Precios Default + Wholesale por variante |
| `POST` | `/admin/draft-orders/:id/convert-force` | Convertir draft → order con backorder fallback |
| `POST` | `/admin/draft-orders/:id/send-email` | Enviar estimate via Resend + adjunto PDF |
| `POST` | `/admin/draft-orders/:id/set-bl-link` | Vincular con proyecto Backlighting |
| `GET` | `/admin/draft-orders/sync-pos` | Sync masivo de draft orders POS |

### Descuentos POS

| Método | Ruta | Descripción |
|--------|------|-------------|
| `POST` | `/admin/pos-discount` | Crea promo + aplica al draft order via Order Edit workflow |
| `DELETE` | `/admin/pos-discount` | Remueve promo del draft order via Order Edit workflow |
| `POST` | `/admin/pos-discount/apply-existing` | Aplica promo nombrada existente con corrección de qty |
| `GET` | `/admin/pos-promotions` | Lista promos disponibles (excluye CUSTOM-DISC-*) |

### Note Presets

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/admin/note-presets` | Lista todos (auto-crea tabla y seed si no existe) |
| `POST` | `/admin/note-presets` | Crear preset |
| `PATCH` | `/admin/note-presets/:id` | Actualizar preset |
| `DELETE` | `/admin/note-presets/:id` | Eliminar preset |

### Estimate Options

```
GET /admin/estimate-options
→ { payment_terms[], lead_times[], order_types[], sales_reps[] }

Carga desde system_defaults WHERE context IN ('Document Defaults', 'Order Defaults', 'Customer Defaults', 'Global')
```

---

## Fix: Bug de Totales a $0 en Lista

### Síntoma

| Vista | Síntoma | Causa |
|-------|---------|-------|
| Lista `/draft-orders-advanced` en producción | `$0.00` | Parche `@medusajs/order` no aplicado en producción |
| Lista en desarrollo | Total sin taxes | `order.total` calculado sin `tax_lines` |

### Causa Raíz — 3 Capas

**1. UI: Prioridad de fuente incorrecta**

```typescript
// ANTES (buggy):
order.total ?? order.metadata?.computed_total

// DESPUÉS (correcto):
order.metadata?.computed_total ?? order.total
```

`metadata.computed_total` es guardado por `compute-tax`:
```typescript
computed_total = discountedSubtotal + shippingSubtotal + taxAmount
```

**2. Railway: `post-build.js` era stub vacío**

El build de Medusa genera `.medusa/server/` con un `npm install` fresco que borra los parches. El fix fue inyectar `postinstall: "npx --yes patch-package"` en `.medusa/server/package.json` desde `scripts/post-build.js`.

**3. Railway: `nixpacks.toml` ignorado por Railpack 0.19.0**

Los comandos custom en `nixpacks.toml` no aplican para Railpack. El fix fue mover la lógica al script de build.

### Fix Aplicado

```json
// package.json
"build": "medusa build && node scripts/post-build.js"
```

`scripts/post-build.js` copia `patches/` → `.medusa/server/patches/` e inyecta `postinstall`.

### Flujo Correcto Post-Fix (Railway)

```
yarn install → postinstall: patch-package (build workspace)
npm run build → medusa build + post-build.js
  → Copia patches/ → .medusa/server/patches/
  → Inyecta postinstall en .medusa/server/package.json

Deploy: cd .medusa/server && npm install --omit=dev --legacy-peer-deps
  → postinstall: npx --yes patch-package
  → @medusajs/order@2.13.0 ✔ (items.quantity/unit_price fix)
  → @medusajs/core-flows@2.13.0 ✔ (discount-aware tax + summary field)
  → @medusajs/utils@2.13.1 ✔
```

### Diagnóstico si el Bug Reaparece

```bash
# Verificar parches en producción (Railway shell):
grep "protectedItemFields" node_modules/@medusajs/order/dist/utils/transform-order.js
grep '"summary"' node_modules/@medusajs/core-flows/dist/order/workflows/get-orders-list.js
cat .medusa/server/package.json | grep postinstall
```

---

## Descuentos POS — Diseño Técnico

### Regla Crítica de `target_type`

```typescript
// CORRECTO — aplica % sobre unit_price × qty (pre-tax)
target_type: 'items'

// INCORRECTO — usaría subtotal+tax como base
target_type: 'order'
```

```typescript
// TAMBIÉN CRÍTICO:
is_tax_inclusive: false   // a nivel promotion
is_tax_inclusive: false   // a nivel application_method
```

### Bug: ORM Snapshot de Qty Desactualizado

Cuando `update-item-force` escribe qty directamente a BD, el ORM de Medusa mantiene el snapshot anterior (qty=1 aunque en BD sea qty=2). Resultado: el Order Edit workflow calcula `5% × $46.13 × 1 = $2.31` en lugar de `5% × $46.13 × 2 = $4.61`.

**Fix:** `posOverrideAdjustmentsWorkflow` — intercepta el JSON payload del edit antes del `confirmDraftOrderEditWorkflow` y recalcula los adjustment amounts desde `order_item` (que sí tiene el qty correcto).

---

## Modelo de Datos — `metadata.computed_total`

La fuente de verdad para el total en lista de estimates es `metadata.computed_total`, no `draft_order.total`:

```typescript
// compute-tax endpoint escribe:
computed_total = (subtotal - discount_total) + shippingSubtotal + taxAmount
```

Para órdenes sin `computed_total` (legacy): fallback a `order.total` (ahora correcto con parches).

---

## Archivos Clave

| Tipo | Ruta Completa | Propósito |
|------|---------------|-----------|
| API | `backend/src/api/admin/draft-orders/[id]/add-item-force/route.ts` | Add ítem bypass |
| API | `backend/src/api/admin/draft-orders/[id]/update-item-force/route.ts` | Update bypass |
| API | `backend/src/api/admin/draft-orders/[id]/delete-item-force/route.ts` | Hard delete |
| API | `backend/src/api/admin/draft-orders/[id]/compute-tax/route.ts` | Tax + persist computed_total |
| API | `backend/src/api/admin/draft-orders/[id]/variant-prices/route.ts` | Dual pricing |
| API | `backend/src/api/admin/draft-orders/[id]/send-email/route.ts` | Email via Resend |
| API | `backend/src/api/admin/draft-orders/[id]/convert-force/route.ts` | Convert con backorder |
| API | `backend/src/api/admin/draft-orders/[id]/set-bl-link/route.ts` | Vincular BL |
| API | `backend/src/api/admin/draft-orders/sync-pos/route.ts` | Sync masivo |
| API | `backend/src/api/admin/pos-discount/route.ts` | Descuento nuevo |
| API | `backend/src/api/admin/pos-discount/apply-existing/route.ts` | Promo existente |
| API | `backend/src/api/admin/pos-promotions/route.ts` | Listar promos |
| API | `backend/src/api/admin/note-presets/route.ts` | CRUD presets |
| API | `backend/src/api/admin/estimate-options/route.ts` | Opciones dropdowns |
| Workflow | `backend/src/workflows/pos-discount/workflows.ts` | `posOverrideAdjustmentsWorkflow` |
| Script | `backend/scripts/post-build.js` | Inyecta patches en build de producción |
| Patches | `backend/patches/` | Parches a paquetes Medusa v2 |
| Admin | `backend/src/admin/routes/draft-orders-advanced/` | Vista avanzada Medusa Admin |

---

## Historial de Decisiones

- **`metadata.computed_total` como fuente primaria** (2026-03-17): Fix al bug de $0 en producción. `order.total` no es confiable sin los parches aplicados. `computed_total` es calculado explícitamente y guardado por `compute-tax`.
- **Hard delete en `delete-item-force`** (2026-03-10): Los "zombie items" (qty=0) rompían cálculos en QB. El hard delete via `deleteOrderLineItems()` resuelve permanentemente.
- **Drag-to-reorder con `sort_order`** (2026-03-10): El orden de items es controlado por el POS/Admin y se persiste en `metadata.sort_order` del orden. MeiliSearch no puede controlar el orden de líneas de una cotización.
- **`posOverrideAdjustmentsWorkflow`** (2026-03-30): Solución nativa al problema de qty snapshot. Evita la necesidad de SQL surgery post-confirm que era la solución anterior (ahora comentada como fallback).
- **Note Presets con auto-seed** (2026-03-09): La tabla `note_presets` se auto-crea y siembra en la primera llamada al endpoint. No requiere migration explícita — facilita el onboarding en entornos nuevos.

# Fast Checkout Architecture Migration

## Fecha
2026-02-23

## Problema

El checkout tardaba 10-15 segundos en producción y generaba errores 502 de timeout.

**Causa raíz:** El frontend (Vercel) hacía 5-6 llamadas HTTP secuenciales al backend (Railway):
1. `POST /store/carts/:id` — actualizar email + dirección
2. `POST /store/carts/:id/shipping-methods` — agregar método de envío
3. `GET /store/carts/:id` — obtener total actualizado
4. `POST /store/payment-collections` — crear colección de pago
5. `POST /store/payment-collections/:id/payment-sessions` — crear sesión
6. `POST /store/carts/:id/complete` — completar carrito

Cada llamada agregaba ~30ms de latencia de red (Vercel → Railway) + tiempo de procesamiento en Medusa.

## Solución

Crear un endpoint monolítico en el backend de Medusa que ejecuta todos los pasos internamente.
El frontend hace **una sola llamada** y el backend orquesta todo.

### Nuevo flujo

```
Frontend (Vercel)  ──── 1 POST ────▶  Medusa (Railway) /store/fast-checkout
                                             │
                                    updateCartWorkflow
                                    resolveShippingOptionId
                                    addShippingMethodToCartWorkflow
                                    GET /store/carts/:id  (Store API — authoritative total in DOLLARS)
                                    createPaymentCollectionForCartWorkflow
                                    createPaymentSessionsWorkflow
                                    completeCartWorkflow
                                             │
                                         Authorize.net  (amount already in dollars — no ÷100)
                                             │
                                         Order Created
```

**Tiempo en producción:** ~2-3 segundos (vs 10-15 segundos antes).

## Archivos Creados / Modificados

### Backend

| Archivo | Cambio |
|---------|--------|
| `src/api/store/fast-checkout/route.ts` | **NUEVO** — endpoint principal |
| `src/workflows/checkout/fast-checkout-workflow.ts` | Placeholder (orquestación movida al route) |
| `src/scripts/test/test-fast-checkout.ts` | **NUEVO** — test E2E con token real de Authorize.net (ver abajo) |

### Frontend

| Archivo | Cambio |
|---------|--------|
| `src/features/checkout/components/payment/usePaymentForm.ts` | Reemplaza 5 llamadas → 1 POST a `/store/fast-checkout` |
| `src/pages/api/checkout/initiate-payment-legacy.ts.bak` | Backup del código original |

## Detalles del Endpoint

### POST /store/fast-checkout

**Headers requeridos:**
```
Content-Type: application/json
x-publishable-api-key: pk_...
```

**Body:**
```json
{
  "cartId": "cart_01...",
  "email": "customer@example.com",
  "shippingAddress": { "firstName": "...", "state": "FL", ... },
  "billingAddress": { "firstName": "...", "state": "FL", ... },
  "shippingMethodId": "so_01..." ,
  "opaqueData": { "dataDescriptor": "...", "dataValue": "..." }
}
```

**Respuesta exitosa:**
```json
{ "ok": true, "orderId": "order_01...", "displayId": 1014 }
```

## Correcciones Aplicadas Durante el Deploy

### 1. `x-publishable-api-key` faltaba en el frontend

- **Síntoma:** 400 "Publishable API key required" en Railway
- **Fix:** Agregar header en `usePaymentForm.ts`:
  ```typescript
  "x-publishable-api-key": import.meta.env.PUBLIC_MEDUSA_PUBLISHABLE_KEY
  ```

### 2. `cartModuleService` nombre incorrecto

- **Síntoma:** No podía obtener el total del carrito
- **Fix:** El módulo correcto en Medusa v2 es `"cart"` (no `"cartModuleService"`)
  ```typescript
  const cartModule = req.scope.resolve("cart")
  ```

### 3. Shipping ID no se resolvía en local

- **Síntoma:** `container.resolve("remoteQuery").graphql` no es una función
- **Fix:** Usar HTTP al endpoint `/store/shipping-options` como Strategy 1,
  con `query.graph` y `fulfillmentModuleService` como fallbacks

### 4. `display_id` era null en la respuesta

- **Síntoma:** `completeCartWorkflow` no incluye `display_id` en su resultado
- **Fix:** Fetch explícito del módulo `order` después de completar:
  ```typescript
  const orderModule = req.scope.resolve("order")
  const [fullOrder] = await orderModule.listOrders({ id: [orderId] }, { select: ["id", "display_id"] })
  ```

## Pruebas Realizadas

- ✅ Script de prueba local con tarjeta real `4111 1111 1111 1111` en test mode
- ✅ Orden `order_01KJ63R47HJYNATV154G4XXBP7` (#1014) creada exitosamente
- ✅ Deploy a Railway — error identificado y corregido (header faltante)
- ✅ Deploy a Vercel con header correcto

### Ejecutar el script de prueba

```bash
# Desde backend/
NODE_OPTIONS="--dns-result-order=ipv4first" npx tsx src/scripts/test/test-fast-checkout.ts
```

**Tarjeta de prueba (Authorize.net en Test Mode):**
```
Número:    4111 1111 1111 1111
Mes:       12
Año:       2026
CVV:       123
```

> El script genera un token opaqueData real vía `securePaymentContainerRequest` y después
> llama al endpoint `POST /store/fast-checkout`. Requiere que Authorize.net esté en Test Mode
> en el dashboard para que el cargo sea simulado.

## Rendimiento Observado

| Entorno | Tiempo |
|---------|--------|
| Local (dev mode) | ~17s (Authorize.net test mode es lento, dev server overhead) |
| Production Railway / Vercel | ~2-3s esperado |

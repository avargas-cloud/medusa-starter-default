# Checkout + Payment Implementation Guide
> **Tipo**: Technical Reference
> **Repo**: backend + frontend
> **Última verificación**: 2026-04-02
> **Estado**: ✅ Current

---

## ¿Qué es y por qué existe?

Guía completa de implementación del checkout y procesamiento de pagos usando Authorize.net (Accept.js) como proveedor en Medusa v2, integrado con el storefront Astro. El flujo usa un endpoint `fast-checkout` que consolida 5-6 llamadas secuenciales en una sola, reduciendo el tiempo de checkout de 10-15s a ~2-3s.

---

## Arquitectura

```
[Customer Browser]
     │
     │  1. Accept.js tokeniza tarjeta → opaqueData
     │
     ▼
[Astro Frontend / Vercel]
     │
     │  2. Single POST con { cartId, opaqueData, billing, shipping, shippingMethodId }
     │     Header: x-publishable-api-key
     │
     ▼
[Medusa Backend / Railway]  POST /store/fast-checkout
     │
     ├── updateCartWorkflow          (email + shipping address)
     ├── resolveShippingOptionId     (exact → pickup → ground → cost-sorted fallback)
     ├── addShippingMethodToCartWorkflow
     ├── GET /store/carts/:id        (Store API — total autoritativo en DÓLARES)
     ├── createPaymentCollectionForCartWorkflow
     ├── createPaymentSessionsWorkflow  (almacena opaqueData + billingAddress + amount)
     └── completeCartWorkflow        → authorizePayment → capturePayment → Order
                │
                ▼
          [Authorize.net]  chargeCard($amount, opaqueData)
                │
                ▼
          [Order creado en Medusa]
```

---

## Módulo de Pagos: Authorize.net

**Path:** `backend/src/modules/authorize-net/`

Implementa `AbstractPaymentProvider` de `@medusajs/framework/utils`.

### Métodos del Provider

| Método | Cuándo se llama | Qué hace |
|--------|----------------|----------|
| `initiatePayment` | Sesión creada | Genera session ID local, almacena amount |
| `authorizePayment` | Completion del cart | Delega a `capturePayment` (auth+capture en un paso) |
| `capturePayment` | Creación de orden | Llama `authCaptureTransaction` de Authorize.net con opaqueData |
| `cancelPayment` | Cancelación de orden | Llama `voidTransaction` de Authorize.net |
| `refundPayment` | Refund desde Admin | Llama `refundTransaction` de Authorize.net |

### Payment Session Data

```typescript
{
  opaqueData: {
    dataDescriptor: "COMMON.ACCEPT.INAPP.PAYMENT",
    dataValue: "eyJjb2RlIjoiNTBfMl8wNj..."  // Token JWT de Accept.js
  },
  billingAddress: {
    firstName, lastName, address1, city, state, zip, country
  },
  amount: 7676  // CENTS — fast-checkout guarda Math.round(cartData.total × 100)
                // PERO capturePayment usa Medusa's native data.amount (en DÓLARES) primero
}
```

> **Unidades de moneda:** `fast-checkout` almacena en CENTS en `payment_session.data.amount`. El método `capturePayment` usa `Medusa's data.amount` (DÓLARES) como primera prioridad, el `sessionData.amount` solo como fallback. Los refunds de Medusa llegan en DÓLARES — se usan directamente.

---

## Fast Checkout Endpoint

**File:** `backend/src/api/store/fast-checkout/route.ts`

**Endpoint:** `POST /store/fast-checkout`

### Request Body

```typescript
{
  cartId: string,
  email?: string,
  shippingAddress?: {
    firstName, lastName, address1, city, state, postcode, country
  },
  billingAddress?: {
    firstName, lastName, address1, city, state, zip, country
  },
  shippingMethodId: string,   // so_... real ID o alias: "optimistic_ground" | "pickup"
  opaqueData: {
    dataDescriptor: string,
    dataValue: string
  },
  amount?: number             // Dólares — fallback solo; Medusa total toma prioridad
}
```

### Response (success)

```json
{ "ok": true, "orderId": "order_01...", "displayId": 1014 }
```

### Response (error)

```json
{ "error": "User-friendly message" }
```

### Routing de Errores

| Condición | Status | Mensaje |
|-----------|--------|---------|
| Shipping profile mismatch | 400 | Re-select shipping |
| Out of stock | 400 | Stock message |
| Payment declined / opaqueData rechazado | 402 | Payment message |
| Error inesperado | 500 | Generic error |

---

## Resolución de Shipping Option

El endpoint resuelve el `shippingMethodId` del frontend a un `so_...` ID real de Medusa:

1. **Exact match** — si ya es un ID `so_...` válido, se usa directamente
2. **Alias: pickup** — busca cualquier opción con "pickup" en nombre/provider_id; fallback: `amount === 0`
3. **Alias: ground** — prefiere el provider base `"ground-shipping"` flat-rate primero; fallback: la opción terrestre más barata (sort ascendente)
4. **Last resort** — la opción más cara disponible (sort descendente — cubre perfil Long Item)

---

## Variables de Entorno Requeridas

### Backend (Railway)

| Variable | Descripción |
|----------|-------------|
| `AUTHORIZENET_API_LOGIN_ID` | API Login ID de Authorize.net |
| `AUTHORIZENET_TRANSACTION_KEY` | Transaction Key de Authorize.net |
| `AUTHORIZENET_ENVIRONMENT` | `production` o `sandbox` |
| `PUBLISHABLE_API_KEY` | Usado por fast-checkout en HTTP fallback |
| `MEDUSA_BACKEND_URL` | URL del backend |

### Frontend (Vercel)

| Variable | Descripción |
|----------|-------------|
| `PUBLIC_MEDUSA_BACKEND_URL` | URL del backend Medusa |
| `PUBLIC_MEDUSA_PUBLISHABLE_KEY` | Publishable API key |
| `PUBLIC_AUTHORIZENET_CLIENT_KEY` | Accept.js public key (desde dashboard Auth.net) |

---

## Impuesto FL 7%

```
Base imponible = SOLO items (shipping está exento)
Tax = subtotal_items × 0.07
```

Esta fórmula se aplica tanto en el storefront como en el POS (para órdenes con `tax_mode: 'FL_7'`).

---

## Archivos Clave

| Tipo | Ruta Completa | Propósito |
|------|---------------|-----------|
| Módulo | `backend/src/modules/authorize-net/` | Payment provider Authorize.net |
| API | `backend/src/api/store/fast-checkout/route.ts` | Endpoint unificado de checkout |
| Test | `backend/src/scripts/tests/test-fast-checkout.ts` | E2E test con token real de Authorize.net |
| Frontend | `frontend/src/components/checkout/` | Componentes de checkout en Astro |

---

## Reglas Críticas

- El header `x-publishable-api-key` es **obligatorio** en todas las llamadas a `/store/*`
- `fast-checkout` usa el total del cart desde `/store/carts/:id` como monto autoritativo — no el `amount` del request body
- `capturePayment` usa `data.amount` de Medusa (dólares) primero, no el `sessionData.amount` (cents)
- Para refunds: Medusa pasa el monto en dólares a `refundPayment()` — usar directamente sin conversión

---

## Historial de Decisiones

- **Endpoint único `fast-checkout`** (2026-02): Antes el frontend hacía 5-6 llamadas secuenciales con ~30ms de latencia de red cada una. El endpoint unificado reduce de 10-15s a ~2-3s.
- **Auth+Capture en un paso**: Authorize.net soporta `authCaptureTransaction` que autoriza y captura simultáneamente. Medusa llama `authorizePayment` → delega a `capturePayment` en el mismo step.
- **Shipping alias "optimistic_ground"**: El frontend puede enviar este alias antes de conocer el `so_...` ID real, y el backend lo resuelve dinámicamente. Simplifica el UX de selección de envío.
- **Tax solo sobre items** (2026-03-06): Actualización que corrige la fórmula anterior que incluía shipping en la base imponible. FL no grava el envío.

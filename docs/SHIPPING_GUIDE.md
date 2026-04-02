# Shipping Guide
> **Tipo**: Technical Reference
> **Repo**: backend
> **Ultima verificacion**: 2026-04-02
> **Estado**: Current

---

## Que es y por que existe

Medusa v2 no tiene integracion nativa con UPS. EcoPowerTech implementa seis fulfillment providers como custom `ModuleProvider(Modules.FULFILLMENT)`:

- `store-pickup` — recogida en tienda (siempre gratis)
- `ground-shipping` — tarifa plana condicional (lee tabla `shipping_settings`)
- `ups-ground` — UPS Ground real-time (serviceCode `03`)
- `ups-next-day-air` — UPS Next Day Air real-time (serviceCode `01`)
- `ups-2nd-day-air` — UPS 2nd Day Air real-time (serviceCode `02`)
- `ups-3-day-select` — UPS 3 Day Select real-time (serviceCode `12`)

Las tarifas UPS se obtienen via UPS Shop API (un solo HTTP call devuelve todos los servicios) con un cache en memoria de 30 segundos, compartido entre todos los providers del mismo proceso Node.js.

---

## Arquitectura

Dos rutas de pricing independientes:

```
STORE PICKUP
  └─ store-pickup provider → always returns calculated_amount: 0

GROUND SHIPPING (flat-rate con override)
  └─ ground-shipping provider
      └─ knex directo → shipping_settings table
      └─ override_ups_ground = true  → usar tarifa plana (default)
      └─ override_ups_ground = false → throws (provider se oculta, UPS Ground toma su lugar)
      └─ Logica: free si total >= free_shipping_minimum
                 long-item rate si hay items > 30" de dimension
                 regular rate en caso contrario

UPS REAL-TIME (4 servicios)
  └─ ups-ground / ups-next-day-air / ups-2nd-day-air / ups-3-day-select
      └─ box-packing.ts → PackageSpec[] (agrupa items en cajas optimas)
      └─ ups-rate-cache.ts → UPS Shop API
          └─ OAuth 2.0 token (cacehado 3500s, token valido 3600s)
          └─ Un solo HTTP call → devuelve tarifas para todos los servicios
          └─ Cache en memoria: 30s TTL por (cartId + postalCode + pkgCount)
          └─ In-flight deduplication: si otro provider ya esta fetcheando, espera
```

### Constraint critico

Los providers de fulfillment NO pueden acceder al DI container durante `calculatePrice` (limitacion de Medusa v2). Solucion:
- `ground-shipping`: recibe `__pg_connection__` (Knex) via constructor
- UPS providers: usan el modulo singleton `ups-rate-cache.ts` (acceso a env vars directamente)

---

## Modelo de Datos

### Tabla shipping_settings

```sql
CREATE TABLE shipping_settings (
    id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
    free_shipping_minimum           INTEGER NOT NULL DEFAULT 29900, -- cents ($299.00)
    regular_ground_shipping_price   INTEGER NOT NULL DEFAULT 1499,  -- cents ($14.99)
    long_item_ground_shipping_price INTEGER NOT NULL DEFAULT 3499,  -- cents ($34.99)
    override_ups_ground             BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
```

NOTA: Esta tabla usa **centavos**, a diferencia del resto del sistema que usa dolares. Es la unica excepcion en la config de shipping.

| Columna | Descripcion |
|---------|-------------|
| `free_shipping_minimum` | Subtotal (centavos) sobre el cual ground shipping es gratis |
| `regular_ground_shipping_price` | Tarifa plana para carritos normales (centavos) |
| `long_item_ground_shipping_price` | Tarifa cuando hay items de perfil largo >30" (centavos) |
| `override_ups_ground` | `true` = usar tarifa plana; `false` = usar UPS Ground live |

### Deteccion de Long Items

`ground-shipping/service.ts` detecta items "largos" (>30") verificando en dos pasos:
1. `inventory_item.length/width/height` (fuente primaria — widget de admin)
2. Fallback: `product_variant.length/width/height`

La constante `LONG_ITEM_THRESHOLD_INCHES = 30` esta en el codigo.

### UPS Rate Cache (ups-rate-cache.ts)

No es un modulo Medusa — es un archivo TypeScript singleton con estado en memoria:

```
rateCache: Map<string, { rates: Record<serviceCode, cents>, timestamp }>
inFlightRequests: Map<string, Promise>  -- evita HTTP calls duplicadas
sharedAccessToken + sharedTokenExpiry   -- token OAuth compartido
CACHE_TTL_MS = 30_000 (30 segundos)
```

Clave de cache: `${cartId}:${postalCode}:${pkgCount}`

---

## Flujo UPS OAuth 2.0

1. Ir a developer.ups.com → Crear App → Solicitar Rating API
2. Copiar `Client ID` y `Client Secret`
3. El sistema usa OAuth 2.0 Client Credentials (no legacy API key)
4. Tokens se obtienen automaticamente: `POST https://onlinetools.ups.com/security/v1/oauth/token`
5. Token cacheado 3500s (token valido 3600s)

### Sanitizacion de Estado para UPS API

`ups-rate-cache.ts` incluye `sanitizeState()` que maneja:
- Formato Medusa province `"us-fl"` → extrae `"FL"`
- Country codes recibidos como state `"US"` → deriva estado desde ZIP (funcion `zipToUsState()`)
- Duplicados `"FLFL"` → `"FL"`

---

## API / Interfaces

| Endpoint | Metodo | Proposito |
|----------|--------|-----------|
| `/admin/shipping-settings` | GET | Obtener configuracion actual (defaults si no hay row) |
| `/admin/shipping-settings` | POST | Actualizar configuracion (upsert) |
| `/admin/ups-rate-preview` | GET | Preview de tarifas UPS para un carrito/draft order |
| `/store/shipping-options` | GET | Opciones disponibles (core Medusa) |

### GET /admin/ups-rate-preview

Query params:
- `postal_code` (requerido) — destino
- `draft_order_id` (opcional) — fetcha items y dimensiones del draft order

Devuelve tarifas en **dolares** para los 4 servicios (01, 02, 03, 12).

### POST /admin/shipping-settings

Body (todos opcionales):
```typescript
{
  free_shipping_minimum?: number          // centavos
  regular_ground_shipping_price?: number  // centavos
  long_item_ground_shipping_price?: number // centavos
  override_ups_ground?: boolean
}
```

---

## Registro en medusa-config.ts

Todos los providers estan bajo `@medusajs/medusa/fulfillment`:

| Resolve | ID | Options |
|---------|-----|---------|
| `@medusajs/medusa/fulfillment-manual` | `manual` | — |
| `./src/modules/store-pickup` | `store-pickup` | — |
| `./src/modules/ground-shipping` | `ground-shipping` | — |
| `./src/modules/ups-ground-shipping` | `ups-ground` | clientId, clientSecret, serviceCode: "03" |
| `./src/modules/ups-next-day-air` | `ups-next-day-air` | clientId, clientSecret, serviceCode: "01" |
| `./src/modules/ups-2nd-day-air` | `ups-2nd-day-air` | clientId, clientSecret, serviceCode: "02" |
| `./src/modules/ups-3-day-select` | `ups-3-day-select` | clientId, clientSecret, serviceCode: "12" |

El modulo `shipping-settings-module` tambien esta registrado en `modules[]` (permite ORM access, aunque `ground-shipping` usa Knex directo):

```typescript
{ resolve: "./src/modules/shipping-settings-module" }
```

---

## Variables de Entorno

```env
# UPS (requerido para providers ups-*)
UPS_CLIENT_ID=your_client_id
UPS_CLIENT_SECRET=your_client_secret
UPS_SHIPPER_NUMBER=your_shipper_number     # para tarifas negociadas

# Origen del shipment (fallback si no viene de la ubicacion del fulfillment)
UPS_ORIGIN_NAME=Ecopowertech Inc
UPS_ORIGIN_ADDRESS=2760 W 84th St Unit 4
UPS_ORIGIN_CITY=Hialeah
UPS_ORIGIN_STATE=FL
UPS_ORIGIN_ZIP=33016
UPS_ORIGIN_COUNTRY=US

# Alternativa (usada por medusa-config.ts options, NO por ups-rate-cache.ts)
UPS_SHIPPER_NAME=Ecopowertech
UPS_SHIPPER_ADDRESS_LINE1=...
UPS_SHIPPER_CITY=...
UPS_SHIPPER_STATE=...
UPS_SHIPPER_POSTAL_CODE=...
UPS_SHIPPER_COUNTRY=US
```

NOTA: `ups-rate-cache.ts` usa `UPS_ORIGIN_*`. Los `options` en `medusa-config.ts` usan `UPS_SHIPPER_*`. Si `shipping_address.from_location` esta disponible en el contexto de calculatePrice, tiene prioridad sobre ambas.

---

## Reglas Criticas

- Los providers no pueden usar el DI container en `calculatePrice` — Knex directo o singleton en memoria
- `UPS_CLIENT_ID` y `UPS_CLIENT_SECRET` deben estar en `.env` para que UPS funcione
- Si `override_ups_ground = false`, el provider `ground-shipping` lanza un error deliberado para ocultar esa opcion — esto es intencional
- `shipping-settings-module` debe estar registrado en `medusa-config.ts` (aunque ground-shipping use Knex, el modulo permite consultar via Admin API)
- Despues de implementar, configurar Shipping Options en Admin Panel de Medusa y asociarlas a regiones y Sales Channels

---

## Archivos Clave

| Tipo | Ruta Completa | Proposito |
|------|---------------|-----------|
| Config | `/home/alejo/webapps/ecopowertech-workspace/backend/medusa-config.ts` | Registro de todos los providers |
| Modulo | `/home/alejo/webapps/ecopowertech-workspace/backend/src/modules/box-packing.ts` | Cart items → PackageSpec[] |
| Modulo | `/home/alejo/webapps/ecopowertech-workspace/backend/src/modules/ups-rate-cache.ts` | Cache UPS Shop API + OAuth |
| Modulo | `/home/alejo/webapps/ecopowertech-workspace/backend/src/modules/store-pickup/service.ts` | Store pickup gratuito |
| Modulo | `/home/alejo/webapps/ecopowertech-workspace/backend/src/modules/ground-shipping/service.ts` | Flat-rate ground con override |
| Modulo | `/home/alejo/webapps/ecopowertech-workspace/backend/src/modules/ups-ground-shipping/service.ts` | UPS Ground (03) |
| Modulo | `/home/alejo/webapps/ecopowertech-workspace/backend/src/modules/ups-next-day-air/service.ts` | UPS Next Day Air (01) |
| Modulo | `/home/alejo/webapps/ecopowertech-workspace/backend/src/modules/ups-2nd-day-air/service.ts` | UPS 2nd Day Air (02) |
| Modulo | `/home/alejo/webapps/ecopowertech-workspace/backend/src/modules/ups-3-day-select/service.ts` | UPS 3 Day Select (12) |
| Modulo | `/home/alejo/webapps/ecopowertech-workspace/backend/src/modules/shipping-settings-module/service.ts` | ORM para shipping_settings |
| Modulo | `/home/alejo/webapps/ecopowertech-workspace/backend/src/modules/shipping-settings-module/models/shipping-settings.ts` | Definicion del modelo |
| API | `/home/alejo/webapps/ecopowertech-workspace/backend/src/api/admin/shipping-settings/route.ts` | Admin API para configuracion |
| API | `/home/alejo/webapps/ecopowertech-workspace/backend/src/api/admin/ups-rate-preview/route.ts` | Preview de tarifas UPS |

---

## Historial de Decisiones

- **Flat-rate override para Ground**: UPS Ground real-time es mas lento y variable. `override_ups_ground = true` permite usar precio fijo sin deshabilitar el modulo UPS. Cuando ambas opciones existen (override + ups-ground live), el Admin puede elegir cual mostrar a clientes.
- **Cache en memoria 30s**: El UPS Shop API tarda ~800ms. Multiples renders del checkout en paralelo colapsarian el rate limit. El cache compartido en `ups-rate-cache.ts` deduplica con in-flight promises.
- **Knex directo en providers**: Medusa v2 no permite resolver servicios del DI container dentro de `calculatePrice`. La solucion es recibir `__pg_connection__` via constructor (ground-shipping) o usar variables de proceso directamente (ups-rate-cache).
- **Un solo Shop API call para 4 servicios**: El endpoint `/rating/v1/Shop` devuelve tarifas para todos los servicios elegibles en un call. Todos los providers consultan la misma cache, generando un unico HTTP request por cart+zip.

# Uber Direct Shipping — Provider, Quotes en Tiempo Real y Plan de Integración
> **Tipo**: Technical Reference + Implementation Plan
> **Repo**: backend + store-pos
> **Última verificación**: 2026-04-08
> **Estado**: Provider implementado ✅ — Integración API pendiente 🔲

---

## Qué es y por qué existe

`uber-shipping` es un fulfillment provider de Medusa v2 para envíos locales vía Uber Direct (courier on-demand). A diferencia de los providers UPS que calculan rates en tiempo real contra la UPS API, Uber opera con un precio que el cajero establece manualmente desde el POS — o en la fase futura, el POS consulta la Uber Direct API para obtener un quote antes de presentárselo al cliente.

**Casos de uso:**
- Órdenes con delivery mismo día en el área de Miami
- El cajero genera la cotización desde el POS sin abrir la app de Uber
- El cliente recibe el precio pre-aprobado dentro del estimate/orden

**Solo para POS:** Esta opción no aparece en el storefront web (`enabled_in_store` ausente). Solo es visible vía `/admin/shipping-options`.

---

## Estado actual (2026-04-08)

### Implementado ✅

| Componente | Archivo | Estado |
|-----------|---------|--------|
| Fulfillment provider | `src/modules/uber-shipping/service.ts` | ✅ Activo |
| Module export | `src/modules/uber-shipping/index.ts` | ✅ Activo |
| Registro en config | `medusa-config.ts` | ✅ Registrado |
| Shipping option en DB | `so_01KNPTJG5AN53KNADEXWBSEXZ6` | ✅ Creado |
| Script de migración | `src/scripts/migrations/create-uber-shipping.ts` | ✅ Ejecutado |

### Pendiente 🔲

| Componente | Descripción |
|-----------|-------------|
| `src/modules/uber-zipcode-whitelist.ts` | Whitelist de zipcodes Miami-Dade/Broward |
| `src/modules/uber-direct-client.ts` | Cliente OAuth 2.0 + quote API |
| `src/api/admin/uber-delivery-quote/route.ts` | Endpoint admin para el POS |
| `store-pos/components/pos/ShippingModal.tsx` | UI: botón Calculate + badge ETA |

---

## Arquitectura del provider (estado actual)

```
medusa-config.ts
  └─ fulfillment module
       └─ uber-shipping provider (id: "uber-shipping")
            └─ UberShippingService
                 ├─ canCalculate()     → false (precio manual)
                 ├─ calculatePrice()   → { calculated_amount: 0 }
                 ├─ createFulfillment() → { data: { method: "uber-shipping" }, labels: [] }
                 └─ getFulfillmentOptions() → [{ id: "uber-shipping", name: "Uber" }]
```

El monto real se establece:
- **Hoy:** manualmente desde el Medusa Admin (Settings → Locations → Shipping) o inline en el POS ShippingModal
- **Futuro:** el POS consulta la Uber Direct API y pre-llena el precio automáticamente

---

## Shipping option en DB

```sql
SELECT id, name, provider_id, metadata
FROM shipping_option
WHERE name = 'Uber';

-- so_01KNPTJG5AN53KNADEXWBSEXZ6 | Uber | uber-shipping_uber-shipping | {"pos_only": true}
```

**Características:**
- `price_type`: `flat` (precio fijo, no calculado)
- `service_zone_id`: `serzo_01KH9VSRWMMTXAY1BXASMM0G0F` (United States)
- `shipping_profile_id`: `sp_01KFH54TAP34J6ZYRE1NZWGSG2` (Default Shipping Profile)
- `metadata.pos_only`: `true` — marker para filtrado en POS
- Sin regla `enabled_in_store` → invisible al storefront web

---

## Comportamiento en órdenes y QuickBooks

Uber se comporta **idénticamente** a los demás métodos de shipping en:

### Cálculo de totales de orden
`order.shipping_total` suma `shipping_method.amount` sin distinción de provider. Medusa no diferencia entre precio calculado por API vs. ingresado manualmente — ambos fluyen igual.

### Sincronización QuickBooks
En `src/lib/quickbooks/order-flow-core.ts`, `buildShippingQbItem()` lee:
```typescript
const amount = Number(method.amount || 0)
```
No revisa el provider. Uber se incluye como line item **SHIPPING & HANDLING** igual que UPS Ground o Manual. La única excepción implementada es el filtro de "pickup" (Store Pickup se excluye de QB) — Uber no aplica a ese filtro.

El `method.name` ("Uber") aparece en el campo de descripción/memo en QB, pero no como campo contable separado.

| Aspecto | Uber | UPS | Manual |
|---------|------|-----|--------|
| Total de orden | `amount` del DB | `amount` del DB | `amount` del DB |
| Sync QB | ✅ Automático | ✅ Automático | ✅ Automático |
| Distinguible en QB | Solo en memo | Solo en memo | Solo en memo |

---

## Plan de integración: Uber Direct API (pendiente)

### Objetivo
Mostrar en el POS ShippingModal un quote de precio + ETA en tiempo real, consultado contra la Uber Direct API, usando la dirección de la tienda como origen y la del cliente como destino.

### Variables de entorno necesarias
Agregar a `backend/.env` y a Railway:

```env
UBER_DIRECT_CLIENT_ID=<desde Uber Developer Portal>
UBER_DIRECT_CLIENT_SECRET=<desde Uber Developer Portal>
UBER_DIRECT_CUSTOMER_ID=<UUID del customer en Uber Direct>
UBER_DIRECT_API_URL=https://sandbox-api.uber.com   # prod: https://api.uber.com
```

> Las vars de origen (`UPS_SHIPPER_ADDRESS_LINE1`, `UPS_SHIPPER_CITY`, etc.) ya existen y se reutilizan para la dirección de la tienda.

### Arquitectura del flujo final

```
POS ShippingModal
    → GET /admin/uber-delivery-quote?postal_code=33126&draft_order_id=ord_xxx
         ├─ isZipcodeInDeliveryArea(zip)   ← uber-zipcode-whitelist.ts
         ├─ packItems(items)               ← box-packing.ts (igual que UPS)
         └─ getUberDeliveryQuote(params)   ← uber-direct-client.ts (OAuth 2.0)
    ← { available: true, price_dollars: 18.50, eta_minutes: 42, quote_id: "..." }
```

**Origen:** dirección de la tienda (Ecopowertech Miami, 2760 W 84th St, Hialeah FL 33016)
**Destino:** dirección del cliente en la orden
**Box packing:** misma función `packItems()` de `box-packing.ts` que usan los providers UPS

---

### Fase 1 — Backend: Módulos nuevos

#### `src/modules/uber-zipcode-whitelist.ts`

Set hardcodeado de ~80 zipcodes Miami-Dade/Broward con función `isZipcodeInDeliveryArea(zip: string): boolean`.

Cobertura mínima:
- Miami: `33101–33139`, `33142–33168`, `33172–33196`
- Hialeah: `33002`, `33010–33018`
- Doral: `33166`, `33178`
- Coral Gables: `33114`, `33124`, `33134`, `33146`
- Miami Beach: `33109`, `33119`, `33139–33141`
- Kendall: `33173–33176`, `33183–33186`, `33193`, `33196`
- Homestead: `33030–33035`, `33090`
- Fort Lauderdale sur: `33301–33316`, `33334`

---

#### `src/modules/uber-direct-client.ts`

Cliente HTTP singleton para Uber Direct API. Patrón idéntico a `ups-rate-cache.ts`.

**Interfaces:**
```typescript
interface UberQuoteRequest {
    pickupAddress: string
    pickupCity: string
    pickupState: string
    pickupZip: string
    dropoffAddress: string
    dropoffCity: string
    dropoffState: string
    dropoffZip: string
    packages: PackageSpec[]   // de box-packing.ts
}

interface UberQuoteResult {
    priceCents: number
    etaMinutes: number
    quoteId: string
    expiresAt: string
}
```

**Exports:**
- `getUberDeliveryQuote(params: UberQuoteRequest): Promise<UberQuoteResult | null>`

**Internos:**
- `getUberAccessToken()` — OAuth 2.0 client credentials, token cacheado en memoria hasta 5 min antes del expiry
- `fetchDeliveryQuote()` — `POST /v1/customers/{customer_id}/deliveries/quotes`

**Cache de quotes:** clave = `dropoffZip`, TTL = 60 segundos
**Error handling:** log + retorna `null` (nunca lanza — el caller decide fallback)

---

### Fase 2 — Backend: Endpoint admin

#### `src/api/admin/uber-delivery-quote/route.ts`

`GET /admin/uber-delivery-quote?postal_code=&draft_order_id=`

Flujo:
```
1. Validar postal_code presente → 400 si falta
2. isZipcodeInDeliveryArea(postal_code)
   → false: { available: false, reason: "Outside delivery area" }
3. Si draft_order_id: query DB items (peso/dimensiones) + dirección del cliente
4. packItems(items) → array de cajas
5. getUberDeliveryQuote({ origen tienda, destino cliente, packages })
   → null: { available: false, reason: "Service temporarily unavailable" }
6. { available: true, price_dollars, eta_minutes, quote_id }
```

**Respuesta exitosa:**
```json
{
  "available": true,
  "price_dollars": 18.50,
  "eta_minutes": 42,
  "quote_id": "abc-123-xyz"
}
```

**Respuesta de error:**
```json
{
  "available": false,
  "reason": "Outside delivery area"
}
```

---

### Fase 3 — POS: ShippingModal

**Archivo:** `store-pos/components/pos/ShippingModal.tsx`

Cambios aditivos:

```typescript
// 1. Detección de opción Uber (junto a isCustomGround, getUPSServiceCode)
const isUberOption = (name: string) => /^uber$/i.test(name.trim())

// 2. Activar botón Calculate para Uber
const hasCalculate = !pickup && (
    !!getUPSServiceCode(opt.name) ||
    isCustomGround(opt.name) ||
    isUberOption(opt.name)           // ← nuevo
)

// 3. State para ETA
const [uberEta, setUberEta] = useState<Record<string, number>>({})
// key = shipping option ID, value = minutos

// 4. Branch en handleCalculate
if (isUberOption(optName)) {
    // GET /admin/uber-delivery-quote?postal_code=X&draft_order_id=Y
    // available → setPrice + setUberEta
    // !available → toast.warning(reason)
    // error → toast.error(...)
}
```

**UI nueva:**
- Badge `~42 min` junto al input de precio (solo cuando ya fue calculado)
- Badge rojo "Fuera de área" si `available: false` (cajero puede igualmente ingresar precio manual)

---

### Tests requeridos (80% coverage mínimo)

| Archivo | Qué cubre |
|---------|-----------|
| `src/modules/__tests__/uber-zipcode-whitelist.test.ts` | Zips válidos → true, zips fuera → false, edge cases |
| `src/modules/__tests__/uber-direct-client.test.ts` | Mock axios: token cache, parsing quote, null en error |
| `src/api/admin/uber-delivery-quote/__tests__/route.test.ts` | Zip válido, zip inválido, sin postal_code → 400 |

---

### Orden de implementación

```
1.1  uber-zipcode-whitelist.ts    ← sin dependencias
1.2  uber-direct-client.ts        ← usa 1.1
2.1  uber-delivery-quote route    ← usa 1.1 + 1.2  (testeable con curl)
3.1  ShippingModal changes        ← usa 2.1        (testeable en UI)
```

---

### Riesgos

| Riesgo | Impacto | Mitigación |
|--------|---------|------------|
| Uber Direct API difiere de docs | Alto | Empezar en sandbox; loguear respuesta completa al primer call exitoso |
| Quotes expiran en 5–15 min | Medio | Botón re-calculate siempre disponible |
| API de Uber caída | Medio | Retorna `available: false` → cajero entra precio manual |
| ShippingModal supera 800 líneas | Bajo | Extraer a `store-pos/lib/uber-quote.ts` si necesario |

---

### Criterios de éxito

- [ ] Cajero ve botón "Calculate" en la fila de Uber en ShippingModal
- [ ] Quote para zip Miami-área devuelve precio + ETA en < 3s
- [ ] Badge `~XX min` visible junto al precio
- [ ] Zip fuera de área muestra "Fuera de área de entrega" inline
- [ ] Si Uber API falla → precio manual sigue disponible
- [ ] OAuth tokens cacheados (no 1 call de token por quote)
- [ ] `yarn type-check` sin errores en backend
- [ ] `npm run type-check` sin errores en store-pos
- [ ] Coverage ≥ 80% en módulos nuevos

---

## Referencias

- [Uber Direct API — Get a Quote](https://developer.uber.com/docs/deliveries/guides/get-a-delivery-quote)
- [Uber Direct — Authentication](https://developer.uber.com/docs/deliveries/guides/authentication)
- Patrón UPS a seguir: `src/modules/ups-rate-cache.ts`
- Box packing: `src/modules/box-packing.ts`
- Docs UPS relacionadas: `docs/UPS_SHIPPING_SYSTEM.md`
- Docs shipping general: `docs/SHIPPING_GUIDE.md`

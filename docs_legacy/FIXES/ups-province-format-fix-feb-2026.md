# Fix: UPS Error 111286 — Medusa Province Format `"us-fl"` Sent as State

**Date:** 2026-02-23  
**Commits:** `d56986f`, `749f6b7`, `e15bb0b`  
**File:** `backend/src/modules/ups-rate-cache.ts`  
**Symptom:** UPS expedited shipping options (Next Day Air, 2nd Day Air, 3 Day Select) completely missing from checkout

---

## Síntoma

UPS expedited shipping options no aparecen en el checkout. El backend lanza error en `/store/shipping-options/:id/calculate`:

```
❌ UPS Shop API Error Dumps: [{ code: '111286', message: 'US is not a valid state for the specified shipment.' }]
❌ UPS Next Day Air® rate error: Request failed with status code 400
error:   UPS Next Day Air®: rate unavailable for cart [id]
http:    POST /store/shipping-options/.../calculate ← - (500)
```

El frontend en `medusa-client.ts` descarta las opciones que retornan `null` del `/calculate`:
```typescript
// medusa-client.ts línea ~323
console.warn(`⚠️ Rate unavailable for ${option.name}, hiding option.`)
return null  // opción oculta al usuario
```

---

## Causa Raíz

Medusa v2 guarda el estado/provincia en el campo `shipping_address.province` usando el formato **`"us-fl"`** (ISO 3166-2: `country-subdivision`), por ejemplo:
- Florida → `"us-fl"`
- New York → `"us-ny"`
- Texas → `"us-tx"`

El código anterior en `sanitizeState()` hacía:
```typescript
// BUG: "us-fl".toUpperCase() = "US-FL" → slice(0,2) = "US"
return trimmed.length > 2 ? trimmed.slice(0, 2) : trimmed
```

`"US-FL"` tiene length 5 > 2, por lo que `slice(0, 2)` = `"US"`. El UPS API recibe `StateProvinceCode: "US"` que es el country code, no un estado — lo rechaza con error 111286.

### Por qué no se detectó antes

- Las opciones expedited nunca habían fallado masivamente en prod hasta que se guardó una dirección completa (con `province` correctamente llenado) en el cart
- En sesiones de prueba con address manual (sin autocompletar Google Maps), `province` podía ser `""` y el error pasaba silenciado

---

## Fix Aplicado

**Archivo:** `backend/src/modules/ups-rate-cache.ts` — función `sanitizeState()`

```typescript
function sanitizeState(state: string, postalCode?: string): string {
    if (!state) return ""
    const trimmed = state.trim().toUpperCase()

    // 🔑 FIX: Handle Medusa province format "us-fl", "US-FL" → extract "FL"
    if (trimmed.includes("-")) {
        const parts = trimmed.split("-")
        const statePart = (parts[parts.length - 1] ?? "").trim()
        if (statePart.length === 2) {
            console.log(`📍 sanitizeState: Medusa format "${trimmed}" → "${statePart}"`)
            return statePart  // "US-FL" → "FL" ✅
        }
        if (statePart.length > 2) {
            return statePart.slice(0, 2)  // "us-florida" → "FL"
        }
    }

    // Guard: country code accidentally passed as state  
    if (COUNTRY_CODES.has(trimmed)) {
        if (trimmed === "US" && postalCode) {
            return zipToUsState(postalCode)  // derive state from ZIP
        }
        return ""
    }

    // Duplicate state bug: "FLFL" → "FL"
    return trimmed.length > 2 ? trimmed.slice(0, 2) : trimmed
}
```

Resultados:
| Input (Medusa) | Output (UPS) |
|----------------|-------------|
| `"us-fl"` | `"FL"` ✅ |
| `"US-FL"` | `"FL"` ✅ |
| `"us-ny"` | `"NY"` ✅ |
| `"US"` + ZIP 32163 | `"FL"` ✅ (derivado del ZIP) |
| `"FLFL"` | `"FL"` ✅ (bug duplicado anterior) |
| `""` | `""` ✅ |

---

## Cambio Relacionado: Cache Key Invalidation

Cuando el UPS retornaba error, el frontend cacheaba el resultado fallido en `sessionStorage` (key `ept_shipping_options_v1`) por 1 hora. Usuarios con cache vieja no verían las opciones aunque el backend se corrigiera.

**Fix:** Se incrementó el cache key de `v1` a `v2` en `frontend/src/lib/medusa-client.ts`:
```typescript
// Antes:
const SHIPPING_OPTIONS_CACHE_KEY = 'ept_shipping_options_v1'
// Después:
const SHIPPING_OPTIONS_CACHE_KEY = 'ept_shipping_options_v2'
```

Esto invalida automáticamente la cache de todos los usuarios existentes en el próximo deploy.

---

## Verificación

Después del fix, los logs del backend muestran:
```
📍 sanitizeState: Medusa format "US-FL" → "FL"
🚀 UPS Shop API — cart ... → 32163 | 2 pkg(s), 1.25lbs total
✅ UPS Shop returned 4 services: { '01': 3987, '02': 2943, '12': 2156, '03': 1823 }
http:    POST /store/shipping-options/.../calculate ← - (200) - 584ms
```

Y el checkout muestra las 3 opciones expedited correctamente.

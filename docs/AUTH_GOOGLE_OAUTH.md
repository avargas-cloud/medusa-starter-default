# AUTH_GOOGLE_OAUTH — Google OAuth para Customers
> **Tipo**: Technical Reference
> **Repo**: backend
> **Última verificación**: 2026-04-02
> **Estado**: ⚠️ Partial — Plugin legacy comentado; provider nativo activo condicionalmente

Consolida: GOOGLE_OAUTH_COMPLETE_GUIDE + GOOGLE_OAUTH_QUICK_REFERENCE + GOOGLE_OAUTH_SETUP

---

## ¿Qué es y por qué existe?

Google OAuth permite a los compradores del storefront web autenticarse con su cuenta de Google sin crear una contraseña separada. Solo aplica al actor `customer` — los admins y el POS usan exclusivamente `emailpass`.

---

## Estado Actual del Código — LEER PRIMERO

### Plugin legacy: COMENTADO (inactivo)

En `medusa-config.ts` existe un bloque comentado para `medusa-plugin-auth`:

```typescript
// Google OAuth Authentication
// TEMPORARILY DISABLED: Plugin causing build errors
// {
//   resolve: "medusa-plugin-auth",
//   options: { strict: "store", google: { ... } }
// }
```

Este plugin es de **Medusa v1** y no es compatible con Medusa v2. Está comentado permanentemente — no descomentar.

### Provider nativo: ACTIVO condicionalmente

En el mismo archivo, el módulo de auth de Medusa v2 incluye el provider de Google de forma condicional:

```typescript
// Se activa SOLO si GOOGLE_CLIENT_ID está definida en el environment
...(process.env.GOOGLE_CLIENT_ID ? [{
  resolve: "@medusajs/auth-google",
  id: "google",
  options: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackUrl: process.env.GOOGLE_CALLBACK_URL || (
      process.env.NODE_ENV === 'production'
        ? 'https://medusa-starter-default-production-b69e.up.railway.app/auth/customer/google/callback'
        : `${process.env.STOREFRONT_URL || 'https://localhost:4321'}/api/auth/google/callback`
    )
  }
}] : [])
```

**En producción**: activo (Railway tiene `GOOGLE_CLIENT_ID` configurado).
**En desarrollo sin `GOOGLE_CLIENT_ID`**: inactivo, no se registra el provider.

### Callbacks: DOS implementaciones

El código tiene dos archivos de callback para Google OAuth:

| Archivo | Ruta URL | Método |
|---------|----------|--------|
| `backend/src/api/auth/customer/google/callback/route.ts` | `GET /auth/customer/google/callback` | usa `validateCallback()` |
| `backend/src/api/store/auth/google/callback/route.ts` | `GET /store/auth/google/callback` | usa `authenticate()` (incorrecto — ver nota) |

**El callback correcto es** `/auth/customer/google/callback` que usa `validateCallback()`. El de `/store/auth/google/callback` usa `authenticate()` que es el método para email/password, no para OAuth — es un archivo legacy que no debería recibir tráfico en producción.

**En desarrollo**, el `callbackUrl` apunta al frontend (`/api/auth/google/callback`) porque Chrome bloquea redirects a `http://localhost:9000` en HTTPS-First mode. El frontend sirve como proxy HTTPS que luego llama al backend.

---

## Arquitectura

```
[Usuario] → Click "Continue with Google"
     ↓
[Frontend] → <a href="https://backend/auth/customer/google">
     ↓          (SIEMPRE <a href>, NUNCA fetch)
[Backend] GET /auth/customer/google
     ↓    → authModuleService.getAuthUrl("google", { authScope: "store" })
     ↓    → redirect a Google
[Google] Consent screen
     ↓
[Backend] GET /auth/customer/google/callback?code=...&state=...
     ↓    → authService.validateCallback("google", { authData })
     ↓    → Extrae email de provider_identities[0].user_metadata.email
     ↓    → Busca/crea/activa customer (3 casos)
     ↓    → generateJwtToken({ actor_id: customer.id })
     ↓    → redirect a ${STOREFRONT_URL}/auth/callback?token=JWT
[Frontend] /auth/callback
     ↓    → localStorage.setItem("medusa_auth_token", token)
     →    → redirect a returnPath o /account
```

### Casos en el Callback

| Situación | Acción |
|-----------|--------|
| Email nuevo (no existe customer) | Medusa Auth Module crea customer automáticamente; callback lo busca con pequeño delay (100ms) |
| Email existente con `has_account=true` | Login normal — vincula auth_identity al customer existente |
| Email legacy (`has_account=false`, `legacy_customer=true`) | Activa cuenta: `has_account = true`, limpia metadata legacy, vincula auth_identity, sync MeiliSearch |

---

## Modelo de Datos

Google OAuth crea en Medusa:

```
auth_identity
└── app_metadata: { customer_id: "cus_..." }

provider_identity (provider = "google")
├── entity_id: google_user_id
├── user_metadata: { email, name, picture, given_name, family_name, ... }
└── auth_identity_id → auth_identity.id
```

Para clientes que también tienen emailpass pueden existir DOS `provider_identity` (una por provider) vinculadas a la misma `auth_identity`.

---

## Flujo de Implementación — Detalles Técnicos

### Initiate Endpoint: GET /auth/customer/google

```typescript
// backend/src/api/auth/customer/google/route.ts
const redirectUrl = await authModuleService.getAuthUrl("google", {
  authScope: "store",
  protocol: req.protocol,
  host: req.headers.host,
})
return res.redirect(redirectUrl)
```

### Callback Endpoint: GET /auth/customer/google/callback

Puntos críticos verificados en el código:

1. **Usar `validateCallback()`, NO `authenticate()`** — OAuth es un flujo de dos pasos. `authenticate()` es para credenciales directas.
2. **En Railway (producción)**, `req.protocol` ve `'http'` porque Railway termina SSL. El código fuerza `'https'` en producción para que el redirect_uri validado coincida con el registrado en Google Console.
3. **Email** se extrae de `authIdentity.provider_identities[0].user_metadata.email`.
4. **`actor_id` en JWT DEBE ser `customer.id`** — si se usa `authIdentity.id`, Medusa interpreta el token como "ya autenticado" y falla en requests a `/store/customers/me`.
5. **MeiliSearch sync manual** para legacy customers activados vía Google (SQL directo no dispara eventos).

```typescript
// Crítico: protocol forzado en producción
protocol: process.env.NODE_ENV === 'production' ? 'https' : req.protocol,
host: req.headers.host,

// Crítico: validateCallback, NO authenticate
const { success, authIdentity } = await authService.validateCallback("google", authData)

// Crítico: actor_id = customer.id (NOT authIdentity.id)
const token = jwt.sign({
  actor_id: customer.id,       // ← Customer ID
  actor_type: "customer",
  auth_identity_id: authIdentity.id,
  app_metadata: { customer_id: customer.id, provider: "google" }
}, http.jwtSecret, { expiresIn: http.jwtExpiresIn || "24h" })
```

---

## Configuración

### Google Cloud Console

1. Ir a [APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials)
2. Crear OAuth 2.0 Client ID (Web application)
3. Authorized Redirect URIs:
   ```
   # Producción
   https://medusa-starter-default-production-b69e.up.railway.app/auth/customer/google/callback

   # Desarrollo (si usas proxy frontend)
   https://localhost:4321/api/auth/google/callback
   ```
4. Authorized JavaScript Origins: dominio del frontend

### Variables de Entorno

```bash
# Backend (Railway)
GOOGLE_CLIENT_ID=....apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
GOOGLE_CALLBACK_URL=https://medusa-starter-default-production-b69e.up.railway.app/auth/customer/google/callback
STOREFRONT_URL=https://ecopowertech.com

# Desarrollo (opcional — sin estas vars, Google OAuth queda desactivado)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
STOREFRONT_URL=https://localhost:4321
```

---

## Frontend Integration

```html
<!-- SIEMPRE <a href>, NUNCA fetch — OAuth requiere redirección completa del browser -->
<a
  href="{MEDUSA_URL}/auth/customer/google"
  onclick="localStorage.setItem('oauth_return_path', window.location.pathname)"
>
  Continue with Google
</a>
```

Página callback (`web/src/pages/auth/callback.astro`):

```typescript
const token = new URL(window.location.href).searchParams.get("token")
if (token) {
  localStorage.setItem("medusa_auth_token", token)
  const returnPath = localStorage.getItem("oauth_return_path") || "/account"
  // Filtrar /404 del returnPath antes de redirigir
  const safePath = returnPath === "/404" ? "/account" : returnPath
  window.location.href = safePath
}
```

---

## Reglas Críticas

- NUNCA usar `authenticate()` en el callback — siempre `validateCallback()`
- `actor_id` en JWT = `customer.id` (NOT `authIdentity.id`)
- Frontend: usar `<a href>` para iniciar OAuth, NO fetch
- Token se guarda en `localStorage` como `"medusa_auth_token"`
- Filtrar `/404` del `oauth_return_path` antes de redirigir
- El plugin `medusa-plugin-auth` está comentado permanentemente — es para Medusa v1

---

## Archivos Clave

| Tipo | Ruta Completa | Propósito |
|------|---------------|-----------|
| Route | `backend/src/api/auth/customer/google/route.ts` | Inicia OAuth flow (activo) |
| Route | `backend/src/api/auth/customer/google/callback/route.ts` | Callback con `validateCallback()` (activo) |
| Route | `backend/src/api/store/auth/google/callback/route.ts` | Callback legacy con `authenticate()` (no debería recibir tráfico) |
| Config | `backend/medusa-config.ts` | Provider google condicional + plugin legacy comentado |

---

## Troubleshooting

| Error | Causa | Solución |
|-------|-------|----------|
| "Redirect URI mismatch" | URI en Google Console no coincide exactamente | Agregar URI exacta que aparece en el log del backend |
| "Already authenticated" en requests posteriores | `actor_id` es `authIdentity.id` no `customer.id` | Usar `customer.id` como `actor_id` en JWT |
| Redirige a /404 | `oauth_return_path` guardó `/404` | Filtrar `/404` antes de redirigir en callback page |
| "Failed to connect" al clickear botón | Usando fetch en lugar de `<a href>` | Cambiar a tag `<a>` |
| Google OAuth desactivado en dev | No hay `GOOGLE_CLIENT_ID` | Agregar la variable al `.env` local |

---

## Historial de Decisiones

- **`medusa-plugin-auth` comentado**: El plugin es para Medusa v1 y causa build errors en v2. Fue reemplazado por el provider nativo `@medusajs/auth-google` que se registra condicionalmente en el módulo auth.
- **`validateCallback` vs `authenticate`**: OAuth usa un flujo de dos pasos (initiate → callback). `authenticate()` es para credenciales directas (email/password). Google OAuth requiere `validateCallback()` que procesa el `code` recibido de Google y lo intercambia con los servidores de Google.
- **Protocol forzado a `https` en producción**: Railway termina SSL antes de llegar al backend, por lo que `req.protocol` siempre ve `'http'`. Sin este fix, el redirect_uri construido para validar el callback no coincide con el registrado en Google Console.
- **Callback URL en dev via frontend proxy**: Chrome tiene HTTPS-First mode que auto-upgrades `http://localhost:9000` a `https://` causando `ERR_SSL_PROTOCOL_ERROR`. En dev, la callback URL apunta al frontend (que ya tiene HTTPS via cert local) que actúa como proxy.
- **Dos archivos de callback**: El de `/store/auth/google/callback/` fue la implementación original con `authenticate()`. El correcto es `/auth/customer/google/callback/` con `validateCallback()`. El legacy no fue borrado pero no debería recibir tráfico de Google porque el `callbackUrl` registrado apunta al correcto.

# AUTH_COMPLETE_GUIDE — Customer Authentication
> **Tipo**: Technical Reference
> **Repo**: backend
> **Última verificación**: 2026-04-02
> **Estado**: ✅ Current

Consolida: AUTHENTICATION_COMPLETE_GUIDE + AUTHENTICATION_BACKEND_API_SPEC + CUSTOMER_AUTH_3_CASES_COMPLETE_GUIDE + AUTHENTICATION_VERIFICATION_WALKTHROUGH

---

## ¿Qué es y por qué existe?

El sistema de auth de clientes en EcoPowerTech tiene 3 casos porque Medusa v2 solo maneja el caso "nuevo usuario". Los casos adicionales son:

- **Clientes legacy de QuickBooks** — importados sin cuenta, necesitan activación por email
- **Re-registro con email existente** — si la contraseña coincide, es auto-login; si no, 409
- **Password reset** — Medusa no incluye password reset para clientes en v2; implementado custom

---

## Arquitectura

### Actors en medusa-config.ts

```typescript
authMethodsPerActor: {
  user: ["emailpass"],                     // Admin panel + POS staff
  customer: ["emailpass", "google"],       // Compradores web
  pos_user: ["emailpass"],                 // Declarado pero NO usado — ver AUTH_POS_STAFF.md
}
```

### Database Schema

```
customer
├── id, email, has_account (boolean), metadata (JSONB)
└── metadata relevante para auth:
    { legacy_customer, activation_token, activation_expires,
      reset_token, reset_expires, temporary_password, activated_at }

auth_identity
└── app_metadata: { customer_id: "cus_..." }   ← Link al customer

provider_identity
├── entity_id: email
├── provider: "emailpass"
├── auth_identity_id → auth_identity.id
└── provider_metadata: { password: "<base64-96bytes>" }
```

### Hash de contraseña — Formato Exacto Medusa v2

Medusa usa scrypt-kdf en formato 96 bytes codificado en base64:

```
Offset  Len  Campo
 0-5      6  ASCII "scrypt"
 6        1  version (0x00)
 7        1  logN (0x0F = 15 → N = 32768)
 8-11     4  r = 8 (big-endian uint32)
12-15     4  p = 1 (big-endian uint32)
16-47    32  salt (random)
48-63    16  SHA-256 checksum de bytes 0..47
64-95    32  HMAC-SHA-256 con scrypt_key[32..63] sobre bytes 0..63
```

Configurado en medusa-config.ts:
```typescript
{ resolve: "@medusajs/auth-emailpass", id: "emailpass",
  options: { hashConfig: { logN: 15, r: 8, p: 1 } } }
```

**Para nuevos registros**: usar `authModule.register()` — Medusa hashea internamente.
**Para password reset/confirm**: replicar el formato byte a byte con `crypto` de Node.js stdlib. Ver implementación completa en `/store/auth/reset-password/confirm/route.ts`.

**NUNCA** usar el paquete npm `scrypt-kdf` — produce un formato diferente que falla al verificar.

---

## Flujo de Implementación — Los 3 Casos

### Entry Point: POST /store/auth/register

```
POST /store/auth/register
{ email, password, first_name, last_name }
```

El route.ts hace primero un SELECT SQL directo (evita caché de Medusa):

```
SELECT id, email, first_name, last_name, has_account, metadata
FROM customer WHERE email = $1
```

Luego decide qué caso ejecutar:

```
├── has_account = true
│   └── case2-existing-customer.ts
│
├── has_account = false, metadata.legacy_customer = true
│   └── case3-legacy-customer.ts
│
└── no existe
    └── case1-new-customer.ts
```

---

### Caso 1: Nuevo Cliente (case1-new-customer.ts)

```
1. authModule.register("emailpass", { email, password, authScope: "store" })
   → Crea auth_identity + provider_identity con hash scrypt-kdf
2. createCustomerAccountWorkflow({ authIdentityId, customerData })
   → Crea customer con has_account: true
3. Auto-asigna a grupo "Retail" si existe
4. authModule.updateAuthIdentities({ app_metadata: { customer_id } })
5. generateJwtToken({ actor_id: customer.id, actor_type: "customer" })
6. SendGrid: email de bienvenida (no-blocking, ignora errores)

Response: 201 { success: true, customer, token }
```

**Regla crítica**: `actor_id` en el JWT es siempre `customer.id`, nunca `authIdentity.id`.

---

### Caso 2: Cliente Existente (case2-existing-customer.ts)

```
Si password correcto:
  authModule.authenticate("emailpass", { email, password, authScope: "store" })
  → generateJwtToken con actor_id: customer.id
  → Response: 200 { success: true, customer, token }

Si password incorrecto:
  → Response: 409 { error: "Email already registered", message: "..." }
```

---

### Caso 3: Cliente Legacy (case3-legacy-customer.ts)

Legacy = importado desde QuickBooks (exists en DB, `has_account = false`, `metadata.legacy_customer = true`)

```
1. Generar activation_token = base64(customer_id:timestamp)
2. SQL UPDATE customer SET metadata = { legacy_customer, temporary_password,
   activation_token, activation_expires: +24h }
   (usa SQL directo porque customerModule.updateCustomers() se cuelga en legacy customers)
3. SendGrid: email de activación con link:
   ${STOREFRONT_URL}/activate-account?token=<activation_token>

Response: 200 { success: true, needs_activation: true, message: "..." }
```

**Sin token en la respuesta** — el cliente no queda logueado hasta activar.

---

### Activación de Legacy: POST /store/auth/activate

```
POST /store/auth/activate { token }

1. Decode base64 → customer_id + timestamp
2. SQL SELECT customer WHERE id = customer_id
3. Validar activation_token === token (en metadata)
4. Validar activation_expires (24h)
5. authModule.register("emailpass", { email, password: temporary_password })
   → Crea auth_identity + provider_identity con hash correcto (Medusa nativo)
6. SQL UPDATE auth_identity SET app_metadata = { customer_id }
7. SQL UPDATE customer SET has_account = true, limpiar metadata de activación
8. MeiliSearch sync: actualizar status → "Registered"
9. generateJwtToken({ actor_id: customer.id, actor_type: "customer" })

Response: 200 { success: true, customer, token, message }
```

---

### Password Reset: POST /store/auth/reset-password

```
POST /store/auth/reset-password { email }

SEGURIDAD: Siempre retorna 200 (previene email enumeration)
Internamente:
1. query.graph para buscar customer (respeta deleted_at)
2. Si no existe o has_account = false → return 200 silencioso
3. crypto.randomBytes(32).toString('hex') → reset_token (1h expiry)
4. customerModule.updateCustomers → guarda reset_token + reset_expires en metadata
5. SendGrid: email con link ${STOREFRONT_URL}/reset-password?token=<token>

Response siempre: 200 { success: true, message: "If this email exists..." }
```

---

### Confirmar Reset: POST /store/auth/reset-password/confirm

```
POST /store/auth/reset-password/confirm { token, password }

1. SQL: SELECT customer WHERE metadata->>'reset_token' = token
   (SQL directo: evita limitaciones de paginación de módulos Medusa)
2. Validar reset_expires (1h)
3. SQL: buscar auth_identity por customer_id
4. SQL: buscar provider_identity WHERE entity_id = email AND provider = 'emailpass'
5. hashPassword(password) → formato 96-byte scrypt-kdf con crypto de Node.js
6. authModule.updateProviderIdentities([{ id, provider_metadata: { password: hash } }])
7. Re-link provider_identity si detecta "split identity" (email en Google + emailpass desvinculado)
   - Caso especial: si es también admin user, NO mover el provider — inyectar customer_id en app_metadata
8. customerModule.updateCustomers → limpiar reset_token, guardar password_reset_at
9. generateJwtToken → auto-login

Response: 200 { success: true, customer, token, message }
```

#### Caso especial — split-identity

Ocurre cuando el cliente registró con Google y luego hace password reset. Medusa crea una `auth_identity` para Google y puede quedar una `provider_identity` emailpass vinculada a una `auth_identity` diferente. El confirm route detecta esto y re-vincula silenciosamente.

También maneja el caso donde el mismo email se usa para admin + customer (ej: `a.vargas@ecopowertech.com`): en este caso NO mueve el `provider_identity` porque rompería el login de admin — en cambio, inyecta `customer_id` en el `app_metadata` del admin auth_identity.

---

## API / Endpoints

Todos los endpoints de store requieren header `x-publishable-api-key`.

| Método | Endpoint | Auth | Descripción | Response exitoso |
|--------|----------|------|-------------|-----------------|
| `POST` | `/store/auth/register` | `x-publishable-api-key` | 3-case registration | 201 `{ customer, token }` o 200 `{ needs_activation }` |
| `POST` | `/store/auth/activate` | `x-publishable-api-key` | Activar legacy customer | 200 `{ customer, token }` |
| `POST` | `/store/auth/login` | `x-publishable-api-key` | Login custom (SQL directo) | 200 `{ customer, token }` |
| `POST` | `/auth/customer/emailpass` | `x-publishable-api-key` | Login Medusa nativo | 200 `{ token }` |
| `POST` | `/store/auth/reset-password` | `x-publishable-api-key` | Solicitar reset | 200 `{ success, message }` |
| `POST` | `/store/auth/reset-password/confirm` | `x-publishable-api-key` | Confirmar reset + hash | 200 `{ customer, token }` |

### Nota sobre /store/auth/login vs /auth/customer/emailpass

`/store/auth/login` es un route custom que hace SQL directo para buscar el customer — fue necesario porque el módulo de customer de Medusa no funciona en store scope con grandes datasets. El endpoint nativo de Medusa `/auth/customer/emailpass` también funciona pero retorna un formato diferente.

---

## Metadata Parsing — Normalización

`customer.metadata` puede llegar como string, array, u objeto. Siempre normalizar:

```typescript
let meta = customer.metadata
if (typeof meta === 'string') meta = JSON.parse(meta)
if (Array.isArray(meta)) {
  // Legacy: metadata es array de strings JSON
  meta = meta.reduce((acc, item) => {
    const parsed = typeof item === 'string' ? JSON.parse(item) : item
    return { ...acc, ...parsed }
  }, {})
}
```

El flag `legacy_customer` puede estar como booleano o como string `"true"` — verificar ambos.

---

## Auth por Frontend

Cada frontend usa un actor Medusa diferente. La misma persona puede tener cuentas en múltiples actores.

| Frontend | Actor Medusa | Endpoint | Nota |
|---|---|---|---|
| `web/` | `customer` | `/auth/customer/emailpass` | Google OAuth también disponible |
| `store-pos/` | `user` | `/auth/user/emailpass` | Requiere estar en tabla `pos_users` |
| `backlighting/` | `user` (admin) o `customer` | `/auth/user/emailpass` → fallback `/auth/customer/emailpass` | Intenta admin primero, luego customer |

> El backlighting backend ya tiene implementado el auth contra Medusa — intenta admin login primero, si falla intenta customer login, y emite su propio JWT HttpOnly (`bl_auth_token`).

---

## Cuentas Dual (mismo email)

Un mismo correo electrónico puede existir como dos entidades completamente separadas en Medusa:

- **`customer`** — la persona compra en la tienda web (`web/`)
- **`user`** (admin) — la misma persona trabaja en el POS o accede a backlighting

Medusa los trata como entidades distintas en tablas distintas. Comparten email pero:
- Sus contraseñas pueden ser diferentes (se hashean por separado)
- Su `auth_identity` es distinta (cada actor tiene su propia)
- No hay sincronización automática entre ellas

**Casos reales:**
- Un empleado (`user`) también compra en la tienda (`customer`) con el mismo correo
- El reset password de `customer` NO afecta la contraseña del `user` — son provider_identities separadas
- El login del POS (`/auth/user/emailpass`) nunca interfiere con el session del storefront (`/auth/customer/emailpass`)

**Caso especial documentado** (ver `Historial de Decisiones`): cuando el mismo email existe en ambos actores y el `customer` hace password reset, el backend detecta que el `provider_identity` emailpass está vinculado a un admin `auth_identity` y lo maneja inyectando `customer_id` en `app_metadata` sin mover el provider — para no romper el login de admin.

---

## Reglas Críticas

- `actor_id` en JWT SIEMPRE es `customer.id` — nunca `authIdentity.id`
- `provider_metadata.password` debe estar en el campo `"password"`, NO `"password_hash"`
- SQL directo para operaciones en auth tables (paginación de Medusa causa 404 en datasets grandes)
- `customerModule.updateCustomers()` se cuelga en legacy customers — usar SQL directo
- Password mínimo 8 caracteres (validado en backend)
- Token de activación expira en 24h; token de reset expira en 1h
- Verificar `needs_activation` ANTES de `token` en la respuesta del register (orden crítico para el frontend)

---

## Variables de Entorno

| Variable | Propósito |
|----------|---------|
| `DATABASE_URL` | Conexión PostgreSQL (para SQL directo en auth tables) |
| `JWT_SECRET` | Firma JWT — debe ser idéntico en backend y POS |
| `COOKIE_SECRET` | Cookie signing |
| `SENDGRID_API_KEY` | Envío de emails de activación y reset |
| `SENDGRID_FROM` | Email remitente verificado en SendGrid |
| `STOREFRONT_URL` | URL base del storefront para links en emails |
| `GOOGLE_CLIENT_ID` | OAuth Google (si configurado, activa el provider google) |
| `GOOGLE_CLIENT_SECRET` | OAuth Google |

---

## Archivos Clave

| Tipo | Ruta Completa | Propósito |
|------|---------------|-----------|
| Route | `backend/src/api/store/auth/register/route.ts` | Entry point — detecta los 3 casos |
| Handler | `backend/src/api/store/auth/register/case1-new-customer.ts` | Nuevo cliente |
| Handler | `backend/src/api/store/auth/register/case2-existing-customer.ts` | Cliente existente |
| Handler | `backend/src/api/store/auth/register/case3-legacy-customer.ts` | Legacy activation email |
| Route | `backend/src/api/store/auth/activate/route.ts` | Activar cuenta legacy |
| Route | `backend/src/api/store/auth/login/route.ts` | Login custom (SQL directo) |
| Route | `backend/src/api/store/auth/reset-password/route.ts` | Solicitar reset |
| Route | `backend/src/api/store/auth/reset-password/confirm/route.ts` | Confirmar reset + hash |
| Config | `backend/medusa-config.ts` | authMethodsPerActor, hashConfig |
| Lib | `backend/src/lib/db.ts` | getSql() helper para SQL directo |

---

## Historial de Decisiones

- **3 casos en un endpoint**: Más ergonómico para el frontend — un solo POST `/register` maneja todos los escenarios. El frontend solo necesita verificar `needs_activation` antes de `token`.
- **SQL directo**: Los módulos de Medusa tienen paginación que genera 404 en datasets grandes. Las auth tables y la tabla customer se consultan vía SQL directo.
- **Split auth_identity**: Usuarios con Google OAuth que luego hacen password reset pueden tener providers desvinculados. Fix aplicado silenciosamente en `reset-password/confirm`. El caso admin+customer mismo email se maneja inyectando `customer_id` sin mover el provider.
- **`scrypt-kdf` npm vs `crypto` nativo**: La librería npm produce un formato diferente al de Medusa internamente. La implementación en `reset-password/confirm/route.ts` replica el formato byte a byte usando solo `crypto` de Node.js stdlib.
- **customerModule.updateCustomers() colgado en legacy customers**: Estos customers tienen metadata en formato array (importados con un script antiguo). El módulo de Medusa no puede actualizarlos. Solución: SQL directo para todos los UPDATE de metadata en legacy customers.
- **MeiliSearch sync manual en activate**: Las actualizaciones vía SQL directo no disparan eventos de Medusa, por lo que el subscriber de MeiliSearch nunca se ejecuta. La activación hace el sync manualmente.

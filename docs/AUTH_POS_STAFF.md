# AUTH_POS_STAFF — Autenticación del Personal del POS
> **Tipo**: Technical Reference + Operational Guide
> **Repo**: backend + store-pos
> **Última verificación**: 2026-04-02
> **Estado**: ✅ Current

Consolida: POS_AUTH + partes relevantes de AUTHENTICATION_VERIFICATION_WALKTHROUGH

---

## ¿Qué es y por qué existe?

El POS requiere que el personal (staff) se autentique antes de acceder. A diferencia de los compradores web (actor `customer`), el staff del POS son **Medusa admin users** (actor `user`).

El módulo `pos-user` en el backend es una tabla whitelist que controla qué admin users tienen acceso al POS — NO es un sistema de autenticación separado.

---

## Arquitectura — El Punto Más Importante

### Qué actor usa el POS

```
POS autentica contra: POST /auth/user/emailpass
Actor: "user"  (Medusa admin users)
```

El modelo de datos en `medusa-config.ts` define:

```typescript
authMethodsPerActor: {
  user: ["emailpass"],          // ← POS usa ESTE actor
  customer: ["emailpass", "google"],
  pos_user: ["emailpass"],      // ← DECLARADO pero no usado en auth real (ver nota)
}
```

### El módulo pos-user: Tabla whitelist, NO auth

El módulo custom `pos-user` (`src/modules/pos-user/`) tiene:

```typescript
// models/pos-user.ts
const PosUser = model.define('pos_user', {
  id: model.id().primaryKey(),
  email: model.text(),
  first_name: model.text().nullable(),
  last_name: model.text().nullable(),
})
```

```typescript
// service.ts — solo CRUD auto-generado por MedusaService
class PosUserModuleService extends MedusaService({ PosUser }) {}
```

**Esta tabla no tiene sesiones, tokens, ni auth identity.** Solo registra qué emails están autorizados para el POS.

### Verificado en el código del POS

`store-pos/app/api/auth/login/route.ts` hace exactamente:

```typescript
// 1. Authenticate against Medusa Admin (actor "user")
const authRes = await fetch(`${MEDUSA_INTERNAL}/auth/user/emailpass`, {
  method: 'POST',
  body: JSON.stringify({ email, password }),
})
const { token } = await authRes.json()

// 2. Fetch admin user profile
const userRes = await fetch(`${MEDUSA_INTERNAL}/admin/users/me`, {
  headers: { 'Authorization': `Bearer ${token}` },
})

// 3. Check POS whitelist
const posRes = await fetch(`${MEDUSA_INTERNAL}/admin/pos-users`, {
  headers: { 'Authorization': `Bearer ${token}` },
})
const isPosStaff = pos_users.some(u => u.email === user.email)
```

No hay `/auth/pos_user/emailpass`. El actor `pos_user` en `authMethodsPerActor` está declarado pero no hay ningún flujo de login que lo use.

---

## Flujo Completo de Login

```
Staff → /login → ingresa email + password

POS (Next.js) → POST /api/auth/login  [server-side route]
                 │
                 ├─ POST /auth/user/emailpass { email, password }
                 │   → Medusa verifica vs auth_identity WHERE app_metadata.user_id IS NOT NULL
                 │   → 200: { token: "eyJ..." }  |  401: error
                 │
                 ├─ GET /admin/users/me  (Authorization: Bearer <token>)
                 │   → 200: { user: { id, email, first_name, last_name, role } }
                 │
                 └─ GET /admin/pos-users  (Authorization: Bearer <token>)
                     → Lista todos los POS users
                     → isPosStaff = pos_users.some(u => u.email === user.email)

Cookie: pos-auth-token = token  (HttpOnly, Secure, SameSite: Strict, 7 días)
NO se guarda token en localStorage

Response al cliente: { user, actorType, isPosStaff }
→ Zustand authStore actualiza el estado
→ Redirect a /dashboard
```

### Seguridad del token

El token vive en una cookie **HttpOnly** — JavaScript del cliente no puede leerlo. El route server-side del POS (`/api/auth/login`) actúa como proxy seguro entre el browser y el backend.

---

## Control de Acceso por Rol

El flag `isPosStaff` controla la visibilidad del módulo "Users" en el POS:

| Flag | Quién | Tab "Users" en sidebar | Acceso a `/users` |
|------|-------|------------------------|------------------|
| `isPosStaff = false` | Admins | Visible | Permitido |
| `isPosStaff = true` | POS Staff | Oculto | Redirige a `/dashboard` |

**Cómo se determina**: Si el email del usuario aparece en la tabla `pos_users` → es staff. Si no aparece → es admin.

El Sidebar del POS detecta si `isPosStaff === null` (sesión antigua sin el dato) y re-verifica automáticamente consultando `/admin/pos-users`.

---

## Flujo de Sesión (Session Restoration)

`store-pos/app/api/auth/session/route.ts`:

```
GET /api/auth/session

1. Lee cookie pos-auth-token
2. Decodifica JWT localmente (sin round-trip a Medusa)
   → Verifica expiración
3. Intenta GET /admin/users/me con timeout de 5s
   (no-fail: si Medusa no responde, usa datos del JWT payload)
4. Intenta GET /admin/pos-users con timeout de 5s
5. Retorna: { token, user, actorType, isPosStaff }
```

**Diseño deliberado**: No falla si Medusa está inaccesible (ej: Railway cold start 10-30s). El token en cookie HttpOnly ya es confiable — JS no puede escribirlo.

---

## Flujo de Invitación de Staff

```
Admin POS → /users → "+ New POS User" → ingresa email + nombre
                │
                POST /admin/pos-users
                { email, first_name, last_name, auth_identity_id }
                → Crea registro en tabla pos_user (solo whitelist, sin auth aún)
                
                POST /admin/pos-users/invite
                { email, first_name, last_name }
                → Crea registro en pos_user si no existe (o re-usa el existente)
                → Firma JWT de invitación (48h):
                  { email, pos_user_id, type: "pos_invite", first_name, last_name }
                → SendGrid: email con link https://pos.ecopowertech.com/activate?token=<JWT>
                → Si no hay SENDGRID_API_KEY: retorna { activate_url } en desarrollo
```

**Reenvío**: Si el email ya existe en pos_users, se reenvía la invitación con nuevo token de 48h.

---

## Flujo de Activación de Cuenta

```
Staff → /activate?token=<JWT>

POST /store/users/pos-activate  { token, password }  [PÚBLICO]

1. jwt.verify(token, JWT_SECRET) → { email, pos_user_id, type: "pos_invite" }
   → 400 si expirado: "Invite link has expired. Ask an admin to resend."
   → 400 si inválido

2. SQL: Buscar auth_identities emailpass existentes para ese email
   → Guarda existingUserId y existingCustomerId si los hay
   → DELETE provider_identity + auth_identity (limpieza para re-registro limpio)
   → Permite activar múltiples veces (re-activación tras reinvitación)

3. authModule.register('emailpass', { email, password, authScope: 'user' })
   → Medusa crea auth_identity + provider_identity con hash scrypt-kdf nativo

4. Busca Medusa admin user existente por email
   → Si no existe: userModule.createUsers([{ email, first_name, last_name, role: 'member',
     metadata: { is_pos_staff: true } }])
   → Si existe: reutiliza el user_id

5. authModule.updateAuthIdentities([{
     id: authResult.authIdentity.id,
     app_metadata: {
       actor_type: 'user',
       user_id: userId,
       // Si el email también es un customer, preserva customer_id
       ...(existingCustomerId ? { customer_id: existingCustomerId } : {})
     }
   }])

Response: 200 { success: true }
Frontend: redirect a /login con mensaje "Account activated!"
```

**Por qué DELETE antes de register**: `authModule.register` falla con "Identity with email already exists" si el usuario ya tiene una `provider_identity`. Al borrar primero, el hash se genera siempre internamente por Medusa (evita el "Invalid key" que ocurre con hashes manuales).

**Caso especial — email que es también customer**: Si el staff invitado usa el mismo email que tiene como comprador web, el activate preserva el `customer_id` en el `app_metadata`. Así tanto el login del POS como el login del storefront funcionan desde la misma identity.

---

## Flujo de Password Reset del Staff

```
Staff → /login → "Forgot your password?" → ingresa email

POST /store/users/pos-reset-password  { email }  [PÚBLICO]

1. SQL: SELECT provider_identity JOIN auth_identity
        WHERE entity_id = email
        AND provider = 'emailpass'
        AND app_metadata->>'user_id' IS NOT NULL
   → Solo encuentra el email si es un admin user real (user_id en app_metadata)
   → Siempre retorna 200 (no revela si el user existe)

2. jwt.sign({ email, type: "pos_reset" }, JWT_SECRET, { expiresIn: '1h' })
3. SendGrid: email con link ${POS_URL}/reset-password?token=<JWT>&email=<email>

POST /store/users/pos-reset-confirm  { token, password }  [PÚBLICO]
→ jwt.verify(token, JWT_SECRET) verifica tipo y expiración
→ SQL: DELETE provider_identity del email
→ authModule.register('emailpass', { email, password, authScope: 'user' })
→ Busca user existente → authModule.updateAuthIdentities con user_id
→ 200 { success: true }
→ Frontend: redirect a /login
```

---

## CRUD de POS Users (Admin API)

| Método | Endpoint | Auth | Descripción |
|--------|----------|------|-------------|
| `GET` | `/admin/pos-users` | Admin JWT | Lista todos + flag `activated` |
| `POST` | `/admin/pos-users` | Admin JWT | Crear registro whitelist (requiere auth_identity_id pre-existente) |
| `PATCH` | `/admin/pos-users/:id` | Admin JWT | Actualizar first_name / last_name |
| `DELETE` | `/admin/pos-users/:id` | Admin JWT | Eliminar registro whitelist |
| `POST` | `/admin/pos-users/invite` | Admin JWT | Crear registro + enviar email de activación |

El `GET /admin/pos-users` enriquece la lista con el flag `activated`: verifica cuáles emails de la tabla pos_users tienen también un Medusa admin user creado (`userModule.listUsers`).

---

## Database Schema

```
pos_user (módulo custom — tabla whitelist)
├── id
├── email
├── first_name (nullable)
└── last_name (nullable)
        │
        │ (email match — no FK)
        ▼
public."user" (Medusa admin)          auth_identity
├── id                                ├── id
├── email                             ├── app_metadata: {
├── first_name                        │     actor_type: "user",
├── last_name                         │     user_id: <user.id>,
├── role: "member"                    │     // opcional si mismo email es customer:
└── metadata: { is_pos_staff: true }  │     customer_id: <customer.id>
                                      │   }
                                      └── provider_identity
                                          ├── entity_id = email
                                          ├── provider = "emailpass"
                                          └── provider_metadata: { password: <scrypt-kdf hash> }
```

---

## Middleware del POS

`store-pos/middleware.ts`:

```typescript
const PUBLIC_PATHS = ['/login', '/reset-password', '/activate']
// /activate DEBE ser público — usuarios llegan desde email sin sesión activa
```

---

## Variables de Entorno

| Variable | Propósito |
|----------|---------|
| `JWT_SECRET` | Firma tokens de invite (48h) y reset (1h) — debe ser idéntico en backend |
| `POS_URL` | URL base del POS para links en emails (ej: `https://pos.ecopowertech.com`) |
| `SENDGRID_API_KEY` | Envío de emails de invitación y reset |
| `SENDGRID_FROM` | Email remitente verificado en SendGrid |
| `DATABASE_URL` | Para SQL directo en activación y reset |
| `NEXT_PUBLIC_MEDUSA_URL` | URL del backend Medusa (POS) |
| `MEDUSA_BACKEND_URL` | URL interna del backend para server-side routes del POS |

---

## Archivos Clave

| Tipo | Ruta Completa | Propósito |
|------|---------------|-----------|
| Módulo | `backend/src/modules/pos-user/` | Model + service CRUD (tabla whitelist) |
| Route | `backend/src/api/admin/pos-users/route.ts` | GET list + POST crear |
| Route | `backend/src/api/admin/pos-users/[id]/route.ts` | PATCH + DELETE |
| Route | `backend/src/api/admin/pos-users/invite/route.ts` | POST invitación |
| Route | `backend/src/api/store/users/pos-activate/route.ts` | POST activar cuenta |
| Route | `backend/src/api/store/users/pos-reset-password/route.ts` | POST solicitar reset |
| Route | `backend/src/api/store/users/pos-reset-confirm/route.ts` | POST confirmar reset |
| Route | `store-pos/app/api/auth/login/route.ts` | Server-side login proxy |
| Route | `store-pos/app/api/auth/logout/route.ts` | Limpia cookie |
| Route | `store-pos/app/api/auth/session/route.ts` | Session restoration |
| Config | `backend/medusa-config.ts` | authMethodsPerActor |

---

## Known Issues & Fixes

| Issue | Causa | Fix Aplicado |
|-------|-------|-------------|
| "Invalid key" al login tras activación | Hash manual incompatible con scrypt-kdf de Medusa | DELETE prev identity + authModule.register (hash nativo) |
| "Identity with email already exists" | Provider_identity pre-existente | DELETE antes de register en pos-activate |
| 401 en `/admin/users/me` tras activación | `app_metadata` sin `user_id` | updateAuthIdentities post-register |
| POS staff ve tab "Users" con sesión antigua | `isPosStaff` null en localStorage | Sidebar auto-refetch en mount |
| Staff invitado con email de customer pierde storefront login | customer_id no preservado | pos-activate detecta y preserva customer_id |
| Token JWT expirado al activar | Invite JWT expira en 48h | Admin reenvía invitación desde /users |

---

## Historial de Decisiones

- **Actor `user` en lugar de `pos_user`**: Medusa v2 no soporta múltiples actors distintos con rutas de auth totalmente separadas sin trabajo adicional. Los admins y el staff POS son todos `user` actors. La diferenciación es por tabla whitelist, no por actor.
- **`pos_user` en authMethodsPerActor declarado pero no usado**: Fue una declaración de intención inicial. Nunca se implementó un flujo de login que use ese actor. El código de activación (`pos-activate/route.ts`) registra con `authScope: 'user'`, no `'pos_user'`.
- **Cookie HttpOnly en lugar de localStorage**: El token nunca toca JavaScript del cliente. El route server-side `/api/auth/login` actúa como proxy. Esto evita ataques XSS que roben el token.
- **Session restoration sin round-trip a Medusa**: Railway puede tardar 10-30s en responder desde un cold start. El POS no puede parecer roto en cada F5. La sesión se restaura desde la cookie HttpOnly (ya confiable) sin esperar a Medusa.
- **DELETE + re-register en activación**: Permite re-activación limpia si un admin reenvía una invitación. Un usuario puede cambiar su contraseña simplemente activando de nuevo.

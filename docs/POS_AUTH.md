# POS_AUTH — Autenticación, Invitación & Activación de Staff

| Campo | Detalle |
|-------|---------|
| **Módulo** | Authentication |
| **Rutas POS** | `/login`, `/reset-password`, `/activate` |
| **Estado** | ✅ Implementado |
| **Última revisión** | 2026-03-07 |

---

## Arquitectura General

El POS usa **Medusa Admin Users** para todos los miembros del equipo:
- Los **admins** (`a.vargas@ecopowertech.com`) tienen acceso completo al POS incluyendo gestión de usuarios.
- El **POS Staff** (vendedores invitados) son también Medusa admin users, pero con acceso restringido: solo ven el POS, no la sección "Users".

> **Gold Standard Medusa v2**: No existe campo `role` nativo en el User model. El control de acceso se implementa verificando si el email del usuario está en la tabla `pos_user` (custom module) — si está → POS staff, si no → admin.

---

## Login Flow

```
POST /auth/user/emailpass  { email, password }
     → 200: { token: "eyJ..." }

GET  /admin/users/me  (Authorization: Bearer <token>)
     → 200: { user: { id, email, first_name, ... } }

GET  /admin/pos-users  (Authorization: Bearer <token>)
     → Verifica si user.email está en la lista de POS staff
     → isPosStaff = pos_users.some(u => u.email === user.email)

Cookie: pos-auth-token = token (7 días)
Store:  isPosStaff guardado en authStore (Zustand + localStorage)
→ redirect a /dashboard
```

**Archivo:** `ecopowertech-store-pos/app/(auth)/login/page.tsx`

---

## Access Control (isPosStaff)

El flag `isPosStaff` controla la visibilidad del módulo Users en el POS.

| Campo | Admins | POS Staff |
|-------|--------|-----------|
| `isPosStaff` | `false` | `true` |
| Tab "Users" en sidebar | ✅ Visible | ❌ Oculto |
| Acceso a `/users` | ✅ | ❌ Redirige a `/dashboard` |

**Archivo `authStore.ts`:**
```typescript
interface AuthState {
    isPosStaff: boolean | null  // null = no determinado aún
    // ...
}
// Se actualiza en login y persiste en localStorage
```

**Auto-refresh para sesiones antiguas:** El Sidebar detecta si `isPosStaff === null` y re-verifica automáticamente consultando `/admin/pos-users`.

---

## Flujo de Invitación de POS Staff

```
Admin → /users → "+ New POS User" → ingresa email + nombre
│
├── POST /admin/pos-users  { email, first_name, last_name }
│        → Crea registro en pos_user module (no crea Medusa user aún)
│
└── POST /admin/pos-users/invite  { email, first_name, last_name }
         → Firma JWT de invitación (48h):
           { email, pos_user_id, type: "pos_invite", first_name, last_name }
         → Envía email via SendGrid con link:
           https://pos.ecopowertech.com/activate?token=<JWT>
```

**Reenvío de invitación:** Si el usuario ya existe en `pos_user`, reenvía el invite (sobreescribe con nuevo token de 48h).

**Archivos:**
- `backend/src/api/admin/pos-users/route.ts` — POST (crear registro)
- `backend/src/api/admin/pos-users/invite/route.ts` — POST (enviar email)

---

## Flujo de Activación (`/activate?token=<JWT>`)

La página de activación permite al staff establecer su contraseña por primera vez (o resetearla si recibió una reinvitación).

```
Usuario → /activate?token=JWT
     → Decodifica JWT (client-side): extrae email
     → Usuario ingresa nueva contraseña x2

POST /store/users/pos-activate  { token, password }
     → Verifica JWT con JWT_SECRET
     → Borra auth_identities existentes del email (DELETE en DB)
     → authModule.register('emailpass', { email, password, authScope: 'user' })
         ✅ Usa el hash interno de emailpass (scrypt-kdf) — NO manual
     → userModule.listUsers({ email }) → busca Medusa user existente
     → Si no existe: userModule.createUsers([{ email, first_name, last_name,
           role: 'member', metadata: { is_pos_staff: true } }])
     → authModule.updateAuthIdentities([{ id, app_metadata:
           { actor_type: 'user', user_id: userId } }])
     → 200: { success: true }

Frontend → redirige a /login con mensaje "Account activated!"
```

**¿Por qué DELETE antes de register?**

Medusa v2's `authModule.register` falla con `"Identity with email already exists"` si el usuario ya tiene una `provider_identity`. Al borrar primero, garantizamos que el hash se genera internamente (evita el "Invalid key" que ocurre con hashes manuales incorrectos).

**Archivos:**
- `backend/src/api/store/users/pos-activate/route.ts`
- `ecopowertech-store-pos/app/(auth)/activate/page.tsx`
- `ecopowertech-store-pos/middleware.ts` → `/activate` es PUBLIC_PATH

---

## Middleware

**Archivo:** `ecopowertech-store-pos/middleware.ts`

```typescript
const PUBLIC_PATHS = ['/login', '/reset-password', '/activate']
// ⚠️ /activate DEBE ser público — usuarios llegan desde email sin sesión
```

---

## Password Reset Flow (Staff existente)

```
Staff → /login → "Forgot your password?" → ingresa email

POST /store/users/pos-reset-password  { email }
     → Verifica que exista user en Medusa con ese email
     → Firma JWT: { email, type: 'pos_reset', exp: +1h }
     → Envía email con link: /reset-password?token=JWT&email=EMAIL

Staff → /reset-password → ingresa nueva contraseña

POST /store/users/pos-reset-confirm  { email, token, password }
     → SQL surgery: preserva auth_identity original
     → ✅ Hash actualizado sin romper el user_id link
```

---

## Endpoints API Completos

| Método | Ruta | Auth | Descripción |
|--------|------|------|-------------|
| `GET` | `/admin/pos-users` | Admin JWT | Lista todos los POS staff con `activated` flag |
| `POST` | `/admin/pos-users` | Admin JWT | Crear registro pos_user |
| `PATCH` | `/admin/pos-users/:id` | Admin JWT | Actualizar first_name / last_name |
| `DELETE` | `/admin/pos-users/:id` | Admin JWT | Eliminar registro pos_user |
| `POST` | `/admin/pos-users/invite` | Admin JWT | Enviar email de invitación |
| `POST` | `/store/users/pos-activate` | Público | Activar cuenta (desde link de email) |
| `POST` | `/store/users/pos-reset-password` | Público | Solicitar reset de contraseña |
| `POST` | `/store/users/pos-reset-confirm` | Público | Confirmar nuevo password |

---

## Database Schema (Medusa + Custom)

```
pos_user (custom module)
├── id
├── email
├── first_name
├── last_name
└── created_at
        │
        │ (email match)
        ▼
public."user" (Medusa admin)          auth_identity
├── id                                ├── id
├── email  ←── verifica "activated"   ├── app_metadata: { actor_type: "user", user_id }
├── first_name                        └── provider_identity
├── last_name                              ├── entity_id = email
├── role: "member"                         ├── provider = "emailpass"
└── metadata: { is_pos_staff: true }       └── provider_metadata: { password: <scrypt-kdf hash> }
```

---

## Variables de Entorno

| Variable | Dev | Descripción |
|----------|-----|-------------|
| `JWT_SECRET` | `supersecret` | Firma tokens de invite y reset |
| `POS_URL` | `http://localhost:3001` | URL base del link en emails |
| `SENDGRID_API_KEY` | — | API key de SendGrid |
| `SENDGRID_FROM` | — | Email remitente verificado |
| `DATABASE_URL` | `postgresql://...` | Conexión directa para SQL surgery |
| `NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY` | `pk_519e7f6...` | Requerido en headers de `/store/` |

---

## Known Issues & Fixes

| Issue | Causa | Fix |
|-------|-------|-----|
| `"Invalid key"` al login tras activación | Hash manual (scrypt-kdf) incompatible | Usar DELETE + authModule.register (nuevo flujo) |
| `"Identity with email already exists"` | Usuario ya tenía provider_identity | DELETE prior auth_identity antes de register |
| 401 en `/admin/users/me` | `app_metadata` sin `user_id` | updateAuthIdentities post-register |
| POS staff ve tab "Users" después de login antiguo | `isPosStaff` no en localStorage | Sidebar auto-refetch en mount si `isPosStaff === null` |
| 401 en edit POS user | Faltaba handler PATCH en `[id]/route.ts` | Agregado PATCH handler |
| Token expirado al activar | JWT invite expira en 48h | Reenviar invitación desde admin |

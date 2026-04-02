# POS Users — Gestión de Usuarios del POS
> **Tipo**: Technical Reference
> **Repo**: backend
> **Última verificación**: 2026-04-02
> **Estado**: ✅ Current

---

## ¿Qué es y por qué existe?

El módulo Users permite a los administradores gestionar cuentas de acceso al POS. Los POS Staff son Medusa admin users (`user` actor) con un registro en la tabla whitelist `pos_users`. El flag `isPosStaff` en el frontend diferencia staff de admins completos.

**Importante:** `pos_user` NO es un actor de autenticación separado. El login del POS autentica contra `/auth/user/emailpass` (admin actor) y luego verifica que ese user esté en la tabla `pos_users`.

---

## Arquitectura

```
Tabla: pos_users (módulo custom backend/src/modules/pos-user/)
    └── Campos: id, email, first_name, last_name, created_at

Medusa Admin Users (tabla nativa: user)
    └── Metadata: { is_pos_staff: true }  ← seteado al activar

Control de acceso (POS frontend):
    └── isPosStaff = authStore.user.metadata.is_pos_staff === true
         ├── true  → visible: Dashboard, Estimates, Orders, Capture Payment, Customers, Vendors, Inventory
         └── false → visible: todo lo anterior + tab Users
```

### Modelo de Datos (`pos_user`)

```typescript
// backend/src/modules/pos-user/models/pos-user.ts
const PosUser = model.define('pos_user', {
    id:         model.id().primaryKey(),
    email:      model.text(),
    first_name: model.text().nullable(),
    last_name:  model.text().nullable(),
})
```

---

## Flujo Completo: Agregar POS Staff

```
1. Admin → "+ New POS User" → email + nombre
   POST /admin/pos-users/invite  { email, first_name, last_name }
   → Crea/actualiza registro en pos_users
   → Firma JWT invite (48h): { email, pos_user_id, first_name, last_name, type: "pos_invite" }
   → Envía email via SendGrid con link: {POS_URL}/activate?token=JWT
   → Si no hay SENDGRID_API_KEY, devuelve activate_url en el response (dev mode)

2. Staff recibe email → click link → /activate
   → Ingresa contraseña nueva x2
   POST /store/users/pos-activate  { token, password }
   → Crea Medusa admin user con metadata: { is_pos_staff: true }
   → Estado: Activo ✅

3. Staff hace login en el POS via /auth/user/emailpass
   → Ve solo tabs de staff (sin Users)
```

> **Nota sobre el flujo antiguo:** Existe también `POST /admin/pos-users` (crea registro sin enviar email) que requiere un `auth_identity_id` pre-existente. El flujo recomendado es `/invite` que maneja todo automáticamente.

---

## Estado "Activated" / "Pending"

```typescript
// GET /admin/pos-users — backend logic:
const medusaUsers = await userModule.listUsers({ email: posEmails })
const activatedEmails = new Set(medusaUsers.map(u => u.email))

pos_users.map(u => ({
    ...u,
    activated: activatedEmails.has(u.email)
}))
```

| Estado | Comportamiento UI |
|--------|------------------|
| `activated: false` | Badge "Pending" + menú `⋯` con Resend Invite |
| `activated: true` | Fecha de creación + ícono ✏️ (Edit) |

---

## Control de Acceso

| Tipo | `isPosStaff` | Tab "Users" | Acceso `/users` URL directa |
|------|-------------|------------|---------------------------|
| Admin (a.vargas, etc.) | `false` | Visible | Permitido |
| POS Staff (staff@...) | `true` | Oculto | Redirect `/dashboard` |

---

## API / Interfaces

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/admin/pos-users` | Lista staff + `activated` flag |
| `POST` | `/admin/pos-users` | Crear registro pos_user (requiere auth_identity_id previo) |
| `POST` | `/admin/pos-users/invite` | Crear registro + enviar email de invitación |
| `PATCH` | `/admin/pos-users/:id` | Editar first_name / last_name |
| `DELETE` | `/admin/pos-users/:id` | Eliminar registro de pos_users |
| `POST` | `/store/users/pos-activate` | Activación (público — no requiere auth) |
| `POST` | `/store/users/pos-reset-password` | Request reset de contraseña |
| `POST` | `/store/users/pos-reset-confirm` | Confirm reset (SQL surgery) |

### Payload: Invite

```typescript
POST /admin/pos-users/invite
{
    email: string,
    first_name?: string,
    last_name?: string
}
→ { success: true }                          // si SENDGRID_API_KEY está configurado
→ { success: true, activate_url: string }    // si NO hay SendGrid (dev mode)
```

### Payload: Activate

```typescript
POST /store/users/pos-activate   // público, no requiere auth
{
    token: string,   // JWT firmado con JWT_SECRET
    password: string
}
→ { success: true }
```

### Variables de Entorno

| Variable | Propósito |
|----------|-----------|
| `POS_URL` | URL base del POS (para el link de activación) |
| `JWT_SECRET` | Firma del JWT invite (48h expiry) |
| `SENDGRID_API_KEY` | Para envío de email — si no está, el link se devuelve en el response |
| `SENDGRID_FROM` | From address (default: `noreply@ecopowertech.com`) |

---

## Reglas Críticas

- `DELETE /admin/pos-users/:id` elimina solo el registro en `pos_users`. El Medusa admin user (auth) NO se elimina automáticamente. Para revocación completa: también eliminar desde `/admin/users`.
- La edición (`PATCH /admin/pos-users/:id`) actualiza solo `pos_user`. El Medusa user mantiene los datos del momento de activación.
- El reenvío de invitación usa `/invite` — puede re-invitar a un email existente (actualiza nombre si se provee).
- `pos-reset-confirm` usa SQL surgery directamente en la BD en lugar de `authModule.updateProvider()`, que crea identities zombie (bug de Medusa v2).

---

## Archivos Clave

| Tipo | Ruta Completa | Propósito |
|------|---------------|-----------|
| Módulo | `backend/src/modules/pos-user/service.ts` | CRUD de la tabla whitelist |
| Módulo | `backend/src/modules/pos-user/models/pos-user.ts` | Modelo de datos |
| API | `backend/src/api/admin/pos-users/route.ts` | GET + POST |
| API | `backend/src/api/admin/pos-users/[id]/route.ts` | PATCH + DELETE |
| API | `backend/src/api/admin/pos-users/invite/route.ts` | POST invite (recomendado) |
| API | `backend/src/api/store/users/pos-activate/route.ts` | Activación (público) |
| API | `backend/src/api/store/users/pos-reset-password/route.ts` | Request reset |
| API | `backend/src/api/store/users/pos-reset-confirm/route.ts` | Confirm reset (SQL surgery) |
| Util | `backend/src/utils/email-templates.ts` | `buildActivationEmail()` |

---

## Historial de Decisiones

- **`pos_user` como tabla whitelist** (2026-03-07): En lugar de un actor de auth separado, se usa una tabla de emails autorizados verificada en el login. Más simple, usa el sistema de auth nativo de Medusa.
- **SQL surgery en reset-confirm** (2026-03): `authModule.updateProvider()` crea una segunda identity en lugar de actualizar la existente. El SQL directo actualiza el `provider_identity` correcto.
- **JWT 48h para invite**: Suficiente tiempo para que el staff active su cuenta. Incluye `pos_user_id` para que `/activate` pueda vincular la identity sin llamadas adicionales.
- **Re-invite idempotente**: Si el staff ya existe en `pos_users`, `/invite` lo actualiza sin crear duplicado. Útil cuando el link expiró.

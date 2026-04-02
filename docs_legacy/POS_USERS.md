# POS_USERS — Gestión de Usuarios del POS

| Campo | Detalle |
|-------|---------|
| **Módulo** | Users |
| **Ruta POS** | `/users` |
| **Estado** | ✅ Implementado |
| **Última revisión** | 2026-03-07 |

---

## Descripción

El módulo Users permite a los **administradores** gestionar las cuentas de acceso al POS.

Los **POS Staff** son Medusa admin users con acceso solo al POS — el flag `isPosStaff` en el frontend los diferencia de los admins completos. Ver `POS_AUTH.md` para el detalle del sistema de autenticación.

---

## Control de Acceso

| Tipo | `isPosStaff` | Tab "Users" | Acceso `/users` URL directa |
|------|-------------|------------|---------------------------|
| Admin (a.vargas, etc.) | `false` | ✅ Visible | ✅ Permitido |
| POS Staff (staff@...) | `true` | ❌ Oculto | ❌ → redirect `/dashboard` |

---

## Secciones de la Página `/users`

### Medusa Admins
- Lista todos los usuarios en `/admin/users` (Medusa built-in)
- Acciones: ✏️ Editar nombre, 🗑️ Eliminar

### POS Staff
- Lista registros del custom `pos_user` module via `/admin/pos-users`
- Campo `activated` indica si el staff completó el proceso de activación
- Acciones:
  - **Pending**: ⋯ dropdown → Resend Invite
  - **Activated**: ✏️ Pencil directo → Editar nombre + 🗑️ Eliminar

---

## Flujo Completo: Agregar POS Staff

```
1. Admin → "+ New POS User" → ingresa email + nombre
   POST /admin/pos-users  { email, first_name, last_name }
   → Crea registro en pos_user module (estado: pendiente)

2. Sistema envía automáticamente email de invitación:
   POST /admin/pos-users/invite  { email, first_name, last_name }
   → JWT invite (48h): { email, pos_user_id, first_name, last_name, type: "pos_invite" }
   → Email con link: /activate?token=JWT

3. Staff recibe email → click link → /activate
   → Ingresa contraseña nueva x2
   POST /store/users/pos-activate  { token, password }
   → Crea Medusa admin user con metadata: { is_pos_staff: true }
   → Estado: Activo ✅

4. Staff puede hacer login en el POS
   → Ve solo Dashboard, Estimates, Orders, Capture Payment, Customers, Vendors, Inventory
   → NO ve el tab "Users"
```

---

## Reenvío de Invitación

Si el staff no activó su cuenta o necesita resetear contraseña:

```
Admin → row del staff → ⋯ → "Resend Invite"
→ POST /admin/pos-users/invite (mismo endpoint)
→ Nuevo JWT de 48h → nuevo email enviado

Staff → click nuevo link → /activate → nueva contraseña
→ El sistema borra la identity anterior y crea una nueva limpia
```

---

## Edición de POS Staff

```
Admin → row del staff (activado) → ✏️ pencil
→ Modal "Edit POS User": first_name, last_name (email no editable)
→ PATCH /admin/pos-users/:id  { first_name, last_name }
→ Actualiza el registro en pos_user module
```

> **Nota:** La edición actualiza el registro en `pos_user` (custom module). El Medusa admin user asociado mantiene los datos originales del momento de activación.

---

## Eliminación de POS Staff

```
Admin → 🗑️ trash icon → confirmación
→ DELETE /admin/pos-users/:id
→ Elimina el registro pos_user

⚠️ El Medusa admin user (auth) NO se elimina automáticamente.
   Para revocación de acceso completa, también eliminar desde /admin/users.
```

---

## Estado "Activated" / "Pending"

El campo `activated` se determina en tiempo real al cargar la página:

```typescript
// GET /admin/pos-users — backend logic:
const medusaUsers = await userModule.listUsers({ email: posEmails })
const activatedEmails = new Set(medusaUsers.map(u => u.email))

pos_users.map(u => ({
    ...u,
    activated: activatedEmails.has(u.email)  // true si completó /activate
}))
```

Si `activated === false` → badge "Pending" + menú ⋯ (Resend Invite)
Si `activated === true` → fecha de creación + icono ✏️ (Edit)

---

## API Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/admin/pos-users` | Lista staff + `activated` flag |
| `POST` | `/admin/pos-users` | Crear registro pos_user |
| `PATCH` | `/admin/pos-users/:id` | Editar first_name / last_name |
| `DELETE` | `/admin/pos-users/:id` | Eliminar registro |
| `POST` | `/admin/pos-users/invite` | Enviar/reenviar email de invitación |

---

## Archivos Clave

| Archivo | Descripción |
|---------|-------------|
| `backend/src/api/admin/pos-users/route.ts` | GET + POST |
| `backend/src/api/admin/pos-users/[id]/route.ts` | PATCH + DELETE |
| `backend/src/api/admin/pos-users/invite/route.ts` | POST invite |
| `backend/src/api/store/users/pos-activate/route.ts` | Activación (público) |
| `ecopowertech-store-pos/app/(pos)/users/page.tsx` | UI principal |
| `ecopowertech-store-pos/app/(pos)/users/UserModal.tsx` | Modal crear/editar |
| `ecopowertech-store-pos/app/(pos)/users/PosRowMenu.tsx` | Menú acciones por fila |
| `ecopowertech-store-pos/app/(auth)/activate/page.tsx` | Página activación |
| `ecopowertech-store-pos/store/authStore.ts` | `isPosStaff` state |

# Sistema de Autenticación de Clientes - Documentación Completa


## 📋 Descripción del Documento

| Campo | Detalle |
|-------|---------|
| **Propósito** | Documentación completa en español del sistema de autenticación con los 3 casos de registro/login, incluyendo el flujo de activación para clientes legacy importados de QuickBooks. Incluye diagramas de arquitectura, código de implementación, y guía de integración con Astro frontend. |
| **Problemas que resuelve** | (1) Clientes legacy (QuickBooks) sin cuenta activa — requieren flujo de activación por email antes del primer login. (2) Campos limitados que Medusa no expone via sus módulos (`has_account`, `auth_identity.app_metadata`) — resuelto con SQL directo. (3) Documentar el patrón exacto de `generateJwtToken` con `app_metadata.customer_id` que el login endpoint requiere obligatoriamente. |
| **Resultado esperado** | Un desarrollador de habla hispana puede implementar el sistema de autenticación completo desde cero usando esta guía, con todos los endpoints, payloads, y código real de implementación por caso. |
| **Scripts Creados** | `tests/test-auth-e2e.ts`, `tests/test-legacy-customer.mjs`, `tests/test-case3-registration.ts`, `tests/test-case3-simple.ts`, `get/get-activation-token.ts`, `verify/verify-activation.ts`, `tests/test-sendgrid.ts` |

## Tabla de Contenidos

1. [Resumen General](#resumen-general)
2. [Arquitectura del Sistema](#arquitectura-del-sistema)
3. [Casos de Uso](#casos-de-uso)
4. [Implementación Técnica](#implementación-técnica)
5. [Configuración](#configuración)
6. [Endpoints API](#endpoints-api)
7. [Integración Frontend](#integración-frontend)
8. [Troubleshooting](#troubleshooting)

---

## Resumen General

El sistema de autenticación de clientes maneja **3 casos distintos** de registro/login, todos implementados usando métodos nativos de Medusa v2:

| Caso | Descripción | Flujo |
|------|-------------|-------|
| **Case 1** | Cliente nuevo | Registro → JWT token → Auto-login |
| **Case 2** | Cliente existente | Verificación password → JWT token o Error 409 |
| **Case 3** | Cliente legacy (QuickBooks) | Email activación → Click link → JWT token → Auto-login |

### Características Clave

✅ **100% Métodos Nativos Medusa v2** - No custom password hashing  
✅ **Scrypt Password Hashing** - Vía `authModule.register()`  
✅ **JWT Token Generation** - Con `actor_id`, `auth_identity_id`, `app_metadata`  
✅ **SendGrid Email Integration** - Para activación de clientes legacy  
✅ **Código Modular** - Handlers separados por caso  

---

## Arquitectura del Sistema

### Componentes Principales

```
┌─────────────────────────────────────────────────────────────┐
│                    FRONTEND (Astro)                          │
│  - Formulario registro                                       │
│  - Página activación (/activate-account)                    │
│  - localStorage para JWT                                     │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   │ HTTP Request
                   │
┌──────────────────▼──────────────────────────────────────────┐
│              MEDUSA BACKEND                                  │
│                                                               │
│  ┌─────────────────────────────────────────────────┐        │
│  │  /store/auth/register (Router)                  │        │
│  │  ├── case1-new-customer.ts                      │        │
│  │  ├── case2-existing-customer.ts                 │        │
│  │  └── case3-legacy-customer.ts                   │        │
│  └─────────────────────────────────────────────────┘        │
│                                                               │
│  ┌─────────────────────────────────────────────────┐        │
│  │  /store/auth/activate                            │        │
│  │  - Procesa links de activación                  │        │
│  └─────────────────────────────────────────────────┘        │
│                                                               │
│  ┌─────────────────────────────────────────────────┐        │
│  │  /store/auth/login                               │        │
│  │  - Login estándar con password                  │        │
│  └─────────────────────────────────────────────────┘        │
└──────────────────┬──────────────────────────────────────────┘
                   │
          ┌────────┴────────┐
          │                 │
┌─────────▼────────┐  ┌────▼────────┐
│   PostgreSQL     │  │  SendGrid   │
│  - customer      │  │  - Emails   │
│  - auth_identity │  │             │
│  - provider_id   │  │             │
└──────────────────┘  └─────────────┘
```

### Base de Datos

**Tablas Principales:**

1. **`customer`**: Información del cliente
   - `id`, `email`, `first_name`, `last_name`
   - `has_account` (boolean) - Si tiene auth configurado
   - `metadata` (jsonb) - Datos extra (legacy_customer, activation_token, etc.)

2. **`auth_identity`**: Identidad de autenticación
   - `id` - Auth identity ID
   - `app_metadata` (jsonb) - Debe contener `{"customer_id": "cus_xxx"}`

3. **`provider_identity`**: Proveedor de autenticación
   - `entity_id` - Email del cliente
   - `provider` - "emailpass"
   - `password_hash` - Hash Scrypt del password
   - `auth_identity_id` - Link a auth_identity

---

## Casos de Uso

### Case 1: Nuevo Cliente

**Descripción**: Usuario que nunca se ha registrado en el sistema.

**Flujo**:
```
1. Usuario envía email + password
2. Sistema verifica que email no existe
3. authModule.register("emailpass") crea:
   - auth_identity con password hash
   - provider_identity con email
4. createCustomerAccountWorkflow() crea customer
5. generateJwtToken() crea token JWT
6. Respuesta 200 con customer + token
```

**Request**:
```bash
POST /store/auth/register
Content-Type: application/json
x-publishable-api-key: YOUR_KEY

{
  "email": "nuevo@ejemplo.com",
  "password": "SecurePassword123!",
  "first_name": "Juan",
  "last_name": "Pérez"
}
```

**Response (200)**:
```json
{
  "success": true,
  "customer": {
    "id": "cus_01XXXXX",
    "email": "nuevo@ejemplo.com",
    "first_name": "Juan",
    "last_name": "Pérez"
  },
  "token": "eyJhbGc...",
  "message": "Registration successful. You are now logged in."
}
```

**Código** (`case1-new-customer.ts`):
```typescript
// 1. Registrar auth identity (password hash automático)
const authResult = await authModule.register("emailpass", {
    body: { email, password },
    authScope: "store",
    // ... otros params
})

// 2. Crear customer via workflow
const { result: customer } = await createCustomerAccountWorkflow(container)
    .run({
        input: {
            customersData: [{ email, first_name, last_name }],
            authIdentityId: authIdentity.id
        }
    })

// 3. Generar JWT token
const token = generateJwtToken({
    actor_id: customer.id,
    actor_type: "customer",
    auth_identity_id: authIdentity.id,
    app_metadata: { customer_id: customer.id }
}, config)
```

---

### Case 2: Cliente Existente

**Descripción**: Usuario intenta registrarse con un email que ya tiene cuenta.

**Flujo**:
```
1. Usuario envía email + password
2. Sistema encuentra customer existente con has_account=true
3. authModule.authenticate() verifica password
4. SI password correcto:
   - Genera JWT token
   - Respuesta 200 con auto-login
5. SI password incorrecto:
   - Respuesta 409 con mensaje útil
```

**Scenario A - Password Correcto (Auto-Login)**:

**Request**:
```bash
POST /store/auth/register
{
  "email": "existente@ejemplo.com",
  "password": "PasswordCorrecto123!"
}
```

**Response (200)**:
```json
{
  "success": true,
  "customer": {
    "id": "cus_01XXXXX",
    "email": "existente@ejemplo.com"
  },
  "token": "eyJhbGc...",
  "message": "Login successful. Welcome back!"
}
```

**Scenario B - Password Incorrecto**:

**Request**:
```bash
POST /store/auth/register
{
  "email": "existente@ejemplo.com",
  "password": "PasswordIncorrecto!"
}
```

**Response (409)**:
```json
{
  "error": "Email already registered",
  "message": "This email is already registered with a different password. Please use the login page instead."
}
```

**Código** (`case2-existing-customer.ts`):
```typescript
// Verificar password usando authenticate nativo
const authResult = await authModule.authenticate("emailpass", {
    body: { email: existingCustomer.email, password },
    authScope: "store",
    // ... otros params
})

if (!authResult.success) {
    // Password incorrecto
    return res.status(409).json({
        error: "Email already registered",
        message: "This email is already registered with a different password..."
    })
}

// Password correcto - auto-login
const authIdentity = authResult.authIdentity
const token = generateJwtToken({
    actor_id: existingCustomer.id,
    actor_type: "customer",
    auth_identity_id: authIdentity.id,
    app_metadata: { customer_id: existingCustomer.id }
}, config)

return res.status(200).json({
    success: true,
    customer: existingCustomer,
    token,
    message: "Login successful. Welcome back!"
})
```

---

### Case 3: Cliente Legacy (QuickBooks Import)

**Descripción**: Cliente importado de QuickBooks que aún no ha activado su cuenta.

**Características**:
- `has_account = false`
- `metadata.legacy_customer = true`
- No tiene `auth_identity` ni `provider_identity`

**Flujo Completo**:
```
1. Usuario envía email + password al endpoint register
2. Sistema detecta: has_account=false && legacy_customer=true
3. Guarda password temporal en metadata
4. Genera token de activación (base64)
5. Envía email con SendGrid
6. Usuario recibe email → Click en link
7. Frontend abre /activate-account?token=XXX
8. Frontend envía token a /store/auth/activate
9. Backend:
   - Decodifica token
   - Crea auth_identity con password hash
   - Actualiza customer (has_account=true)
   - Genera JWT token
10. Respuesta 200 con auto-login
```

**Step 1: Register (Enviar Email)**

**Request**:
```bash
POST /store/auth/register
{
  "email": "legacy@ejemplo.com",
  "password": "NuevoPassword123!",
  "first_name": "Pedro",
  "last_name": "González"
}
```

**Response (200)**:
```json
{
  "success": true,
  "needs_activation": true,
  "message": "Activation email sent. Please check your inbox."
}
```

**Código** (`case3-legacy-customer.ts`):
```typescript
// 1. Generar token de activación
const activationToken = Buffer.from(
    `${existingCustomer.id}:${Date.now()}`
).toString('base64')

// 2. Guardar en metadata
await customerModule.updateCustomers(existingCustomer.id, {
    metadata: {
        ...existingCustomer.metadata,
        temporary_password: password,
        activation_token: activationToken,
        activation_expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    }
})

// 3. Enviar email con SendGrid
const activationUrl = `${process.env.STOREFRONT_URL}/activate-account?token=${activationToken}`

await sgMail.send({
    to: existingCustomer.email,
    from: process.env.SENDGRID_FROM,
    subject: 'Activate Your Account',
    html: `
        <h1>Welcome!</h1>
        <p>Click the link below to activate your account:</p>
        <a href="${activationUrl}">Activate Account</a>
        <p>This link expires in 24 hours.</p>
    `
})
```

**Step 2: Activate (Procesar Link)**

**Request**:
```bash
POST /store/auth/activate
{
  "token": "Y3VzX2xlZ2FjeV9hYWVhYzE2NzBjOTNhNzYyY2I2YzoxNzcwMDUyOTY2MzEw"
}
```

**Response (200)**:
```json
{
  "success": true,
  "customer": {
    "id": "cus_legacy_xxx",
    "email": "legacy@ejemplo.com"
  },
  "token": "eyJhbGc...",
  "message": "Account activated successfully. You are now logged in."
}
```

**Código** (`activate/route.ts`):
```typescript
// 1. Decodificar token
const decoded = Buffer.from(token, 'base64').toString('utf-8')
const [customerId, timestamp] = decoded.split(':')

// 2. Verificar customer y token
const customer = await customerModule.retrieveCustomer(customerId)
const metadata = customer.metadata as any

if (metadata.activation_token !== token) {
    return res.status(400).json({ error: "Invalid token" })
}

// 3. Crear auth_identity usando register nativo (hash automático)
const { authIdentity } = await authModule.register("emailpass", {
    body: {
        email: customer.email,
        password: metadata.temporary_password
    },
    authScope: "store"
})

// 4. Actualizar auth_identity.app_metadata y customer via SQL
const postgres = await import('postgres')
const sql = postgres.default(process.env.DATABASE_URL!)

try {
    // Link customer_id en app_metadata
    await sql`
        UPDATE auth_identity
        SET app_metadata = jsonb_set(
            COALESCE(app_metadata, '{}'::jsonb),
            '{customer_id}',
            ${'"' + customer.id + '"'}::jsonb
        )
        WHERE id = ${authIdentity.id}
    `

    // Actualizar customer: has_account = true
    await sql`
        UPDATE customer
        SET 
            has_account = true,
            metadata = ${JSON.stringify({
                ...metadata,
                activation_token: null,
                temporary_password: null,
                activated_at: new Date().toISOString()
            })}::jsonb
        WHERE id = ${customer.id}
    `
} finally {
    await sql.end()
}

// 5. Generar JWT token
const token = generateJwtToken({
    actor_id: customer.id,
    actor_type: "customer",
    auth_identity_id: authIdentity.id,
    app_metadata: { customer_id: customer.id }
}, config)
```

---

## Implementación Técnica

### Password Hashing

**Regla general**: Para los flujos de **registro** (Cases 1, 2, 3), usar el método nativo de Medusa:

```typescript
// ✅ REGISTRO: Usar método nativo — hash automático
const { authIdentity } = await authModule.register("emailpass", {
    body: { email, password }
})
```

**Excepción — Reset de contraseña**: El endpoint `/store/auth/reset-password/confirm` usa `crypto` nativo de Node.js para producir el **formato scrypt-kdf de 96 bytes** que Medusa verifica internamente. Esto fue necesario porque `authModule.register()` no permite actualizar un `provider_identity` existente — solo crea nuevos.

```typescript
// ✅ RESET: Nativo Node.js crypto (96-byte scrypt-kdf format)
import { scrypt, randomBytes, createHash, createHmac } from "crypto"
// Ver AUTHENTICATION_BACKEND_API_SPEC.md → "Password Hashing" para el código completo
```

> **⚠️ No usar el paquete npm `scrypt-kdf`** — usar los módulos nativos de Node.js. El formato binario (checksum SHA256 + HMAC-SHA256) es idéntico al que produce la librería.

### JWT Token Generation

**Estructura del Token:**
```json
{
  "actor_id": "cus_01XXXXX",           // Customer ID
  "actor_type": "customer",             // Tipo de actor
  "auth_identity_id": "authid_01XXXXX", // Auth identity ID  
  "app_metadata": {
    "customer_id": "cus_01XXXXX"        // CRÍTICO para login
  },
  "iat": 1770052966,
  "exp": 1770139366
}
```

**Código:**
```typescript
import { generateJwtToken, ContainerRegistrationKeys } from '@medusajs/framework/utils'

const config = req.scope.resolve(ContainerRegistrationKeys.CONFIG_MODULE)
const { http } = config.projectConfig

const token = generateJwtToken({
    actor_id: customer.id,
    actor_type: "customer",
    auth_identity_id: authIdentity.id,
    app_metadata: {
        customer_id: customer.id  // ← IMPORTANTE: Login endpoint lo necesita
    }
}, {
    secret: http.jwtSecret,
    expiresIn: http.jwtExpiresIn,
    jwtOptions: http.jwtOptions
})
```

### SQL Queries Directos

**¿Por qué SQL directo?**

Medusa v2 tiene limitaciones en ciertos campos:
- `customer.has_account` - No updatable via `customerModule.updateCustomers()`
- `auth_identity.app_metadata` - No se setea automáticamente por `register()`

**Actualizar auth_identity.app_metadata:**
```typescript
const postgres = await import('postgres')
const sql = postgres.default(process.env.DATABASE_URL!)

await sql`
    UPDATE auth_identity
    SET app_metadata = jsonb_set(
        COALESCE(app_metadata, '{}'::jsonb),
        '{customer_id}',
        ${'"' + customer.id + '"'}::jsonb
    )
    WHERE id = ${authIdentity.id}
`

await sql.end()
```

**Actualizar customer.has_account:**
```typescript
await sql`
    UPDATE customer
    SET has_account = true
    WHERE id = ${customer.id}
`
```

---

## Configuración

### Variables de Entorno (.env)

```bash
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/medusa-db

# Redis
REDIS_URL=redis://localhost:6379

# SendGrid (Para Case 3)
SENDGRID_API_KEY=SG.xxxxxxxxxxxxxxxxxxxxx
SENDGRID_FROM=noreply@ecopowertech.com

# Storefront
STOREFRONT_URL=http://localhost:4321  # Astro frontend

# Publishable Key
PUBLISHABLE_API_KEY=pk_xxxxxxxxxxxxxxx

# Node Environment
NODE_ENV=development  # o 'production'
```

### SendGrid Setup

**Requisitos:**
1. Cuenta SendGrid activa
2. API Key con permisos de envío
3. Sender email verificado (`noreply@ecopowertech.com`)

**Verificar configuración:**
```bash
# Test script
npx tsx src/scripts/test-sendgrid.ts
```

---

## Endpoints API

### POST /store/auth/register

**Descripción**: Endpoint principal de registro que maneja los 3 casos automáticamente.

**Headers:**
```
Content-Type: application/json
x-publishable-api-key: YOUR_PUBLISHABLE_KEY
```

**Body:**
```json
{
  "email": "usuario@ejemplo.com",
  "password": "SecurePassword123!",
  "first_name": "Nombre",     // Opcional
  "last_name": "Apellido"      // Opcional
}
```

**Responses:**

**Case 1 - Nuevo Cliente (200):**
```json
{
  "success": true,
  "customer": {...},
  "token": "eyJhbGc...",
  "message": "Registration successful. You are now logged in."
}
```

**Case 2 - Cliente Existente Password Correcto (200):**
```json
{
  "success": true,
  "customer": {...},
  "token": "eyJhbGc...",
  "message": "Login successful. Welcome back!"
}
```

**Case 2 - Cliente Existente Password Incorrecto (409):**
```json
{
  "error": "Email already registered",
  "message": "This email is already registered with a different password. Please use the login page instead."
}
```

**Case 3 - Cliente Legacy (200):**
```json
{
  "success": true,
  "needs_activation": true,
  "message": "Activation email sent. Please check your inbox."
}
```

---

### POST /store/auth/activate

**Descripción**: Procesa token de activación de email (Case 3).

**Headers:**
```
Content-Type: application/json
x-publishable-api-key: YOUR_PUBLISHABLE_KEY
```

**Body:**
```json
{
  "token": "Y3VzX2xlZ2FjeV94eHg6MTc3MDA1Mjk2NjMxMA=="
}
```

**Response (200):**
```json
{
  "success": true,
  "customer": {...},
  "token": "eyJhbGc...",
  "message": "Account activated successfully. You are now logged in."
}
```

**Errores:**
- `400` - Token inválido o expirado
- `404` - Customer no encontrado
- `400` - Cuenta ya activada

---

### POST /store/auth/login

**Descripción**: Login estándar con email + password.

**Headers:**
```
Content-Type: application/json
x-publishable-api-key: YOUR_PUBLISHABLE_KEY
```

**Body:**
```json
{
  "email": "usuario@ejemplo.com",
  "password": "SecurePassword123!"
}
```

**Response (200):**
```json
{
  "success": true,
  "customer": {...},
  "token": "eyJhbGc..."
}
```

**Errores:**
- `401` - Credenciales inválidas
- `401` - Cuenta no configurada

---

## Integración Frontend

### Astro/React Frontend

**1. Register/Login Form:**

```typescript
// components/RegisterForm.tsx
async function handleRegister(email: string, password: string) {
    const response = await fetch('http://localhost:9000/store/auth/register', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-publishable-api-key': import.meta.env.PUBLIC_MEDUSA_PUBLISHABLE_KEY
        },
        body: JSON.stringify({ email, password })
    })

    const data = await response.json()

    if (data.success) {
        if (data.needs_activation) {
            // Case 3 - Mostrar mensaje de email enviado
            alert('Check your email for activation link!')
        } else {
            // Case 1 or 2 - Guardar token y redirigir
            localStorage.setItem('medusa_auth_token', data.token)
            window.location.href = '/dashboard'
        }
    } else if (response.status === 409) {
        // Case 2 - Password incorrecto
        alert('Email already registered. Please login instead.')
        window.location.href = '/login'
    }
}
```

**2. Activation Page:**

```typescript
// pages/activate-account.astro
---
const token = Astro.url.searchParams.get('token')

if (token) {
    const response = await fetch('http://localhost:9000/store/auth/activate', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-publishable-api-key': import.meta.env.PUBLIC_MEDUSA_PUBLISHABLE_KEY
        },
        body: JSON.stringify({ token })
    })

    const data = await response.json()

    if (data.success) {
        // Guardar token
        if (typeof window !== 'undefined') {
            localStorage.setItem('medusa_auth_token', data.token)
        }
        // Redirigir
        return Astro.redirect('/dashboard')
    }
}
---

<h1>Activating your account...</h1>
```

**3. Authenticated Requests:**

```typescript
// utils/medusaFetch.ts
export async function medusaFetch(endpoint: string, options = {}) {
    const token = localStorage.getItem('medusa_auth_token')

    return fetch(`http://localhost:9000${endpoint}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            'x-publishable-api-key': import.meta.env.PUBLIC_MEDUSA_PUBLISHABLE_KEY,
            ...(token && { 'Authorization': `Bearer ${token}` }),
            ...options.headers
        }
    })
}

// Ejemplo de uso
const response = await medusaFetch('/store/customers/me')
const customer = await response.json()
```

---

## Troubleshooting

### Error: "Invalid key" durante registro

**Causa**: Password hash incorrecto - usando método manual en lugar de nativo.

**Solución**: Siempre usar `authModule.register()` para crear auth_identity, nunca `createAuthIdentities()`.

```typescript
// ❌ INCORRECTO
await authModule.createAuthIdentities({
    provider_identities: [{
        provider: "emailpass",
        user_metadata: { password: manualHash }  // ← NO
    }]
})

// ✅ CORRECTO
await authModule.register("emailpass", {
    body: { email, password }  // ← Hash automático
})
```

---

### Error: "Customer not found" en login

**Causa**: `auth_identity.app_metadata.customer_id` no está seteado.

**Solución**: Actualizar `app_metadata` con SQL directo después de `register()`.

```typescript
// Después de authModule.register()
await sql`
    UPDATE auth_identity
    SET app_metadata = jsonb_set(
        COALESCE(app_metadata, '{}'::jsonb),
        '{customer_id}',
        ${'"' + customer.id + '"'}::jsonb
    )
    WHERE id = ${authIdentity.id}
`
```

---

### Error: "Login fails after password reset" (Split Auth Identity)

**Síntoma**: Password reset exitoso (200), pero el login posterior retorna "Invalid email or password" aunque las credenciales sean correctas.

**Causa**: El `provider_identity` de `emailpass` está vinculado a un `auth_identity` **legado** cuyo `app_metadata.customer_id` apunta a un ID de cliente que ya no existe (ej. `cus_legacy_aeac1670...`). Esto ocurre en clientes que se registraron con Google OAuth y tienen un `auth_identity` duplicado con un ID muerto.

**Flujo del fallo:**
```
Login OK → Verifica hash ✅ → Busca customer por app_metadata.customer_id
→ customer_id = cus_legacy_... (no existe) → 404 → "Invalid email or password"
```

**Solución** (ya implementada en `reset-password/confirm`): El endpoint detecta si el `emailpass` provider está vinculado al `auth_identity` incorrecto y lo re-vincula via SQL directo al `auth_identity` correcto. Esto sucede automáticamente durante cualquier reset de contraseña.

**Si el problema ocurre sin reset de contraseña**, ejecutar SQL de diagnóstico:
```sql
-- Encontrar providers de emailpass vinculados a identidades huérfanas
SELECT pi.id, pi.entity_id, pi.auth_identity_id,
       ai.app_metadata->>'customer_id' as linked_customer_id
FROM provider_identity pi
JOIN auth_identity ai ON ai.id = pi.auth_identity_id
WHERE pi.provider = 'emailpass'
  AND NOT EXISTS (
    SELECT 1 FROM customer c
    WHERE c.id = ai.app_metadata->>'customer_id'
      AND c.deleted_at IS NULL
  );
```

Ver `AUTHENTICATION_BACKEND_API_SPEC.md` → "Split Auth Identity" para más detalles y SQL de corrección.

---

### SendGrid: 401 Unauthorized

**Causa**: API key inválido o sender email no verificado.

**Verificar:**
1. API key correcto en `.env`
2. Sender email verificado en SendGrid dashboard
3. Variables cargadas - reiniciar servidor después de cambiar `.env`

```bash
# Test SendGrid
npx tsx src/scripts/test-sendgrid.ts
```

---

### Email activation link apunta a localhost:3000

**Causa**: `STOREFRONT_URL` incorrecto en `.env`.

**Solución**: Actualizar para Astro frontend:
```bash
STOREFRONT_URL=http://localhost:4321  # Astro default port
```

---

## Scripts Útiles

### Unregister Customer (Testing)

Convierte un customer a estado legacy para probar Case 3:

```bash
npx tsx src/scripts/unregister-customer.ts
```

**Código** (`unregister-customer.ts`):
```typescript
const email = 'test@ejemplo.com'

// 1. Eliminar auth data
await sql`DELETE FROM provider_identity WHERE entity_id = ${email}`
await sql`DELETE FROM auth_identity WHERE app_metadata->>'customer_id' = ${customerId}`

// 2. Set legacy state
await sql`
    UPDATE customer
    SET 
        has_account = false,
        metadata = jsonb_set(
            COALESCE(metadata, '{}'::jsonb),
            '{legacy_customer}',
            'true'::jsonb
        )
    WHERE email = ${email}
`
```

### Get Activation Token

Obtiene token de activación de un customer:

```bash
npx tsx src/scripts/get-activation-token.ts
```

---

## Checklist de Deployment

**Antes de producción:**

- [ ] Actualizar `STOREFRONT_URL` a URL de producción
- [ ] Cambiar `NODE_ENV=production`
- [ ] Verificar SendGrid API key y sender email
- [ ] Probar los 3 casos en staging
- [ ] Confirmar JWT tokens funcionando
- [ ] Verificar emails llegando a inbox (no spam)
- [ ] Documentar flujo para soporte

---

## Recursos Adicionales

- [Medusa v2 Auth Documentation](https://docs.medusajs.com/v2/resources/auth)
- [SendGrid API Documentation](https://docs.sendgrid.com/api-reference)
- [JWT.io Token Debugger](https://jwt.io)

---

**Documentación actualizada**: 2026-03-27
**Versión**: 1.1
**Cambios v1.1**: Actualizado Password Hashing con excepción para reset-password; añadido Troubleshooting para split auth_identity (login falla después de reset).

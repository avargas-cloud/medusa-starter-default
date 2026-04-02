# Medusa v2 Authentication - Complete Implementation Guide

**EcoPowerTech Backend**  
**Last Updated**: 2026-02-03  
**Status**: 100% Gold Standard Medusa v2

---


## 📋 Descripción del Documento

| Campo | Detalle |
|-------|---------|
| **Propósito** | Master reference for the entire EcoPowerTech authentication system in Medusa v2 — covering customer registration (3 cases), email/password login, password reset, Google OAuth, and frontend integration. |
| **Problemas que resuelve** | Medusa v2's default auth module doesn't natively handle: (1) legacy QuickBooks customers who need email activation, (2) customers who try to re-register with an existing email and correct password (auto-login), (3) password reset using the native `scrypt-kdf` algorithm (not bcrypt). |
| **Resultado esperado** | A complete, production-ready authentication system where all 3 registration cases are handled automatically at `/store/auth/register`, password reset works end-to-end with scrypt-kdf, and tokens are valid for both `/store/auth/login` and `/auth/customer/emailpass`. |
| **Scripts Creados** | `tests/test-auth-e2e.ts`, `tests/test-2step-registration.ts`, `tests/test-case3-registration.ts`, `tests/test-legacy-customer.mjs`, `tests/test-password-reset-e2e.ts`, `tests/test-google-oauth-setup.ts`, `get/get-activation-token.ts`, `verify/verify-activation.ts`, `verify/verify-auth-direct.ts`, `verify/verify-password-hash.ts`, `tests/test-sendgrid.ts` |
| **Última verificación** | 2026-02-03 |

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Customer Registration & Login](#customer-registration--login)
4. [Password Reset Flow](#password-reset-flow)
5. [Google OAuth Integration](#google-oauth-integration)
6. [API Reference](#api-reference)
7. [Frontend Integration](#frontend-integration)
8. [Testing & Verification](#testing--verification)
9. [Troubleshooting](#troubleshooting)

---

## Overview

### Features

This implementation provides **100% Medusa v2 native authentication** with:

✅ **Customer Registration** - 3 cases (new, existing, legacy)  
✅ **Email/Password Login** - Custom + Medusa gold standard endpoints  
✅ **Password Reset** - Complete flow with scrypt-kdf hashing  
✅ **Google OAuth** - Social login integration  
✅ **JWT Tokens** - Secure session management  
✅ **SendGrid Emails** - Activation & reset emails  

### Tech Stack

- **Medusa v2** - Core auth module with emailpass provider
- **scrypt-kdf** - Password hashing (Medusa's default)
- **PostgreSQL** - Customer & auth data storage
- **SendGrid** - Transactional email delivery
- **JWT** - Token-based authentication

---

## Architecture

### Database Schema

```
┌──────────────────┐
│    customer      │
│  - id            │
│  - email         │──┐
│  - has_account   │  │
│  - metadata      │  │
└──────────────────┘  │
                      │
┌──────────────────┐  │
│  auth_identity   │  │
│  - id            │  │
│  - app_metadata  │←─┘ Contains: {customer_id: "cus_xxx"}
└──────────────────┘
         │
         │
┌──────────────────────┐
│  provider_identity    │
│  - entity_id (email)  │
│  - provider           │ = "emailpass"
│  - provider_metadata  │ Contains: {password: "base64_scrypt_hash"}
│  - auth_identity_id   │
└──────────────────────┘
```

**Critical Fields**:
- `provider_metadata.password` - scrypt-kdf hash in base64 format
- `app_metadata.customer_id` - Links auth_identity to customer
- `customer.has_account` - Boolean indicating if auth is set up

### Password Hashing (scrypt-kdf)

**Medusa v2 uses scrypt-kdf, NOT bcrypt**:

```typescript
// Gold Standard (DO THIS)
const scrypt = (await import('scrypt-kdf')).default
const hashConfig = { logN: 15, r: 8, p: 1 }
const passwordHashBuffer = await scrypt.kdf(password, hashConfig)
const passwordHash = Buffer.from(passwordHashBuffer).toString('base64')

// Store in: provider_metadata.password
```

**Storage location**: `provider_identity.provider_metadata.password`  
**Format**: Base64 string (NOT JSON array!)  
**Example**: `c2NyeXB0AA8AAAAIAAAAAREogG7jKAkCDhyl7TP...`

---

## Customer Registration & Login

### Case 1: New Customer

**Flow**: User registers → Account created → JWT token → Auto-login

**Request**:
```bash
POST /store/auth/register
Content-Type: application/json
x-publishable-api-key: YOUR_KEY

{
  "email": "new@example.com",
  "password": "SecurePass123!",
  "first_name": "John",
  "last_name": "Doe"
}
```

**Response** (200):
```json
{
  "success": true,
  "customer": {
    "id": "cus_01XXX",
    "email": "new@example.com",
    "first_name": "John",
    "last_name": "Doe"
  },
  "token": "eyJhbGciOiJIUzI1NiIs..."
}
```

**Implementation** ([`src/api/store/auth/register/route.ts`](file:///home/alejo/medusa-starter-default/src/api/store/auth/register/route.ts)):

```typescript
// 1. Register with emailpass provider (hashes password automatically)
const { authIdentity } = await authModule.register("emailpass", {
    body: { email, password },
    authScope: "store"
})

// 2. Create customer via workflow
const { result: customer } = await createCustomerAccountWorkflow(container)
    .run({
        input: {
            customersData: [{ email, first_name, last_name }],
            authIdentityId: authIdentity.id
        }
    })

// 3. Generate JWT token
const token = generateJwtToken({
    actor_id: customer.id,
    actor_type: "customer",
    auth_identity_id: authIdentity.id,
    app_metadata: { customer_id: customer.id }
}, config)
```

---

### Case 2: Existing Customer

**Flow**: User tries to register → Detects existing account → Verifies password → Auto-login or error

**Scenario A - Correct Password** (200):
```json
{
  "success": true,
  "customer": {...},
  "token": "eyJhbGc...",
  "message": "Login successful. Welcome back!"
}
```

**Scenario B - Wrong Password** (409):
```json
{
  "error": "Email already registered",
  "message": "This email is already registered with a different password. Please use the login page instead."
}
```

**Implementation**:
```typescript
// Detect existing customer
const existingCustomer = await customerModule.listCustomers({
    email: email
})

if (existingCustomer.has_account) {
    // Verify password using native authenticate
    const authResult = await authModule.authenticate("emailpass", {
        body: { email, password },
        authScope: "store"
    })
    
    if (!authResult.success) {
        return res.status(409).json({
            error: "Email already registered",
            message: "This email is already registered with a different password..."
        })
    }
    
    // Password correct - auto-login
    const token = generateJwtToken({...})
    return res.status(200).json({ success: true, customer, token })
}
```

---

### Case 3: Legacy Customer Activation

**Flow**: Legacy customer registers → Email sent → User clicks link → Account activated → Auto-login

**Step 1 - Register Request**:
```bash
POST /store/auth/register
{
  "email": "legacy@example.com",
  "password": "NewPass123!"
}
```

**Response** (200):
```json
{
  "success": true,
  "needs_activation": true,
  "message": "Activation email sent. Please check your inbox."
}
```

**Step 2 - Activation Request**:
```bash
POST /store/auth/activate
{
  "token": "Y3VzX2xlZ2FjeV94eHg6MTc3MDA1Mjk2NjMxMA=="
}
```

**Response** (200):
```json
{
  "success": true,
  "customer": {...},
  "token": "eyJhbGc...",
  "message": "Account activated successfully. You are now logged in."
}
```

**Implementation** ([`src/api/store/auth/activate/route.ts`](file:///home/alejo/medusa-starter-default/src/api/store/auth/activate/route.ts)):

```typescript
// 1. Decode and validate token
const decoded = Buffer.from(token, 'base64').toString('utf-8')
const [customerId, timestamp] = decoded.split(':')

// 2. Create auth records using register
const { authIdentity } = await authModule.register("emailpass", {
    body: {
        email: customer.email,
        password: metadata.temporary_password
    },
    authScope: "store"
})

// 3. Update auth_identity.app_metadata with customer_id
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

// 4. Update customer
await sql`
    UPDATE customer
    SET has_account = true
    WHERE id = ${customer.id}
`

// 5. Generate token
const token = generateJwtToken({...})
```

---

## Password Reset Flow

**Complete flow**: User requests reset → Email sent → User clicks link → Enters new password → Password updated with scrypt-kdf → User can login

### Step 1: Request Password Reset

**Endpoint**: `POST /store/auth/reset-password`

**Request**:
```bash
POST /store/auth/reset-password
Content-Type: application/json
x-publishable-api-key: YOUR_KEY

{
  "email": "user@example.com"
}
```

**Response** (200 - Always success for security):
```json
{
  "success": true,
  "message": "If this email exists, you will receive a password reset link shortly."
}
```

**Implementation** ([`src/api/store/auth/reset-password/route.ts`](file:///home/alejo/medusa-starter-default/src/api/store/auth/reset-password/route.ts)):

```typescript
// 1. Find customer
const customers = await query.graph({
    entity: "customer",
    fields: ["id", "email", "has_account"],
    filters: { email }
})

if (!customer || !customer.has_account) {
    // Security: Return success even if not found
    return res.status(200).json({
        success: true,
        message: "If this email exists, you will receive a password reset link shortly."
    })
}

// 2. Generate reset token
const resetToken = crypto.randomBytes(32).toString('hex')
const resetExpires = new Date(Date.now() + 60 * 60 * 1000) // 1 hour

// 3. Save token to customer metadata
await customerModule.updateCustomers(customer.id, {
    metadata: {
        ...customer.metadata,
        reset_token: resetToken,
        reset_expires: resetExpires.toISOString()
    }
})

// 4. Send email via SendGrid
const resetUrl = `${process.env.STOREFRONT_URL}/reset-password?token=${resetToken}`
await sgMail.send({
    to: customer.email,
    from: process.env.SENDGRID_FROM,
    subject: 'Password Reset Request',
    html: `
        <h1>Reset Your Password</h1>
        <p>Click the link below to reset your password:</p>
        <a href="${resetUrl}">Reset Password</a>
        <p>This link expires in 1 hour.</p>
    `
})
```

---

### Step 2: Confirm Password Reset

**Endpoint**: `POST /store/auth/reset-password/confirm`

**Request**:
```bash
POST /store/auth/reset-password/confirm
Content-Type: application/json
x-publishable-api-key: YOUR_KEY

{
  "token": "a1b2c3...",
  "password": "NewSecurePass123!"
}
```

**Response** (200):
```json
{
  "success": true,
  "customer": {
    "id": "cus_01XXX",
    "email": "user@example.com",
    "first_name": "User",
    "last_name": "Name"
  },
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "message": "Password reset successfully! You are now logged in."
}
```

**✅ Auto-Login**: The endpoint now returns a JWT token for immediate login after password reset.

**Implementation** ([`src/api/store/auth/reset-password/confirm/route.ts`](file:///home/alejo/medusa-starter-default/src/api/store/auth/reset-password/confirm/route.ts)):

```typescript
// 1. Find customer by token
const customers = await query.graph({
    entity: "customer",
    fields: ["id", "email", "metadata"],
    filters: { 
        metadata: {
            reset_token: token
        }
    }
})

// 2. Validate token and expiration
if (new Date() > new Date(customer.metadata.reset_expires)) {
    return res.status(400).json({
        error: "Token expired",
        message: "Password reset link has expired. Please request a new one."
    })
}

// 3. Find auth_identity
const authIdentities = await authModule.listAuthIdentities({
    filters: {
        app_metadata: {
            customer_id: customer.id
        }
    }
})

const authIdentity = authIdentities[0]

// 4. Find provider_identity
const providerIdentities = await authModule.listProviderIdentities({
    filters: {
        auth_identity_id: authIdentity.id,
        provider: "emailpass"
    }
})

const emailpassProvider = providerIdentities[0]

// 5. GOLD STANDARD: Hash password with scrypt-kdf
const scrypt = (await import('scrypt-kdf')).default
const hashConfig = { logN: 15, r: 8, p: 1 }
const passwordHashBuffer = await scrypt.kdf(password, hashConfig)
const passwordHash = Buffer.from(passwordHashBuffer).toString('base64')

// 6. Update provider_metadata.password
await authModule.updateProviderIdentities([{
    id: emailpassProvider.id,
    provider_metadata: {
        password: passwordHash  // CRITICAL: Field name is "password", not "password_hash"
    }
}])

// 7. Clear reset token
await customerModule.updateCustomers(customer.id, {
    metadata: {
        ...customer.metadata,
        reset_token: null,
        reset_expires: null
    }
})
```

**Critical Implementation Notes**:

1. **Use scrypt-kdf, NOT bcrypt** - Medusa's emailpass provider uses scrypt-kdf
2. **Store in `provider_metadata.password`** - NOT `password_hash`
3. **Convert to base64 string** - Use `Buffer.from(passwordHashBuffer).toString('base64')`
4. **Hash config must match** - `{ logN: 15, r: 8, p: 1 }` is Medusa's default

---

### Step 3: Login with New Password

**Both endpoints work after reset**:

**Custom Endpoint**:
```bash
POST /store/auth/login
{
  "email": "user@example.com",
  "password": "NewSecurePass123!"
}
```

**Medusa Gold Standard**:
```bash
POST /auth/customer/emailpass
{
  "email": "user@example.com",
  "password": "NewSecurePass123!"
}
```

**Both return JWT token for immediate login**.

---

## Google OAuth Integration

See [`GOOGLE_OAUTH_SETUP.md`](file:///home/alejo/medusa-starter-default/docs/GOOGLE_OAUTH_SETUP.md) for complete setup guide.

---

## API Reference

### Registration & Login Endpoints

| Endpoint | Method | Purpose | Auto-Login |
|----------|--------|---------|-----------|
| `/store/auth/register` | POST | Register new/existing/legacy | ✅ (Case 1,2) |
| `/store/auth/activate` | POST | Activate legacy account | ✅ Yes |
| `/store/auth/login` | POST | Standard login (custom) | ✅ Yes |
| `/auth/customer/emailpass` | POST | Standard login (Medusa gold) | ✅ Yes |

### Password Reset Endpoints

| Endpoint | Method | Purpose | Returns Token |
|----------|--------|---------|--------------|
| `/store/auth/reset-password` | POST | Request reset email | ❌ No |
| `/store/auth/reset-password/confirm` | POST | Set new password | ✅ Yes (auto-login) |

### JWT Token Structure

```json
{
  "actor_id": "cus_01XXX",
  "actor_type": "customer",
  "auth_identity_id": "authid_01XXX",
  "app_metadata": {
    "customer_id": "cus_01XXX"
  },
  "iat": 1770135945,
  "exp": 1770222345
}
```

---

## Frontend Integration

### Environment Variables

```bash
# .env.local (Frontend)
PUBLIC_MEDUSA_BACKEND_URL=http://localhost:9000
PUBLIC_MEDUSA_PUBLISHABLE_KEY=pk_xxxxx
STOREFRONT_URL=http://localhost:4321
```

### Registration Form

```typescript
// components/RegisterForm.tsx
async function handleRegister(email: string, password: string) {
    const response = await fetch(`${BACKEND_URL}/store/auth/register`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-publishable-api-key': PUBLISHABLE_KEY
        },
        body: JSON.stringify({ email, password })
    })
    
    const data = await response.json()
    
    if (data.success) {
        if (data.needs_activation) {
            // Case 3: Show "check email" message
            showMessage('Activation email sent. Please check your inbox.')
        } else if (data.token) {
            // Case 1 or 2: Save token and redirect
            localStorage.setItem('auth_token', data.token)
            router.push('/dashboard')
        }
    } else if (response.status === 409) {
        // Case 2: Wrong password
        showError('Email already registered. Please login instead.')
    }
}
```

### Password Reset Flow

**Request Reset Page**:
```typescript
// pages/forgot-password.tsx
async function handleResetRequest(email: string) {
    const response = await fetch(`${BACKEND_URL}/store/auth/reset-password`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-publishable-api-key': PUBLISHABLE_KEY
        },
        body: JSON.stringify({ email })
    })
    
    const data = await response.json()
    
    if (data.success) {
        showMessage('If your email exists, you will receive a reset link shortly.')
    }
}
```

**Confirm Reset Page**:
```typescript
// pages/reset-password.tsx
async function handleResetConfirm(token: string, password: string) {
    const response = await fetch(`${BACKEND_URL}/store/auth/reset-password/confirm`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-publishable-api-key': PUBLISHABLE_KEY
        },
        body: JSON.stringify({ token, password })
    })
    
    const data = await response.json()
    
    if (data.success && data.token) {
        // Auto-login with returned token
        localStorage.setItem('auth_token', data.token)
        showMessage('Password reset successfully! You are now logged in.')
        router.push('/dashboard')
    } else {
        showError(data.message || 'Reset failed. Please try again.')
    }
}
```

### Authenticated Requests

```typescript
// utils/medusaFetch.ts
export async function medusaFetch(endpoint: string, options = {}) {
    const token = localStorage.getItem('auth_token')
    
    return fetch(`${BACKEND_URL}${endpoint}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            'x-publishable-api-key': PUBLISHABLE_KEY,
            ...(token && { 'Authorization': `Bearer ${token}` }),
            ...options.headers
        }
    })
}

// Usage
const response = await medusaFetch('/store/customers/me')
const customer = await response.json()
```

---

## Testing & Verification

### E2E Password Reset Test

**Script**: [`src/scripts/test-auth-e2e.ts`](file:///home/alejo/medusa-starter-default/src/scripts/test-auth-e2e.ts)

```bash
# Run complete flow test
npx tsx src/scripts/test-auth-e2e.ts

# Output:
# ✅ STEP 1: Request reset token
# ✅ STEP 2: Get token from database
# ✅ STEP 3: Confirm password reset
# ✅ STEP 4: Login with custom endpoint
# ✅ STEP 5: Login with gold standard endpoint
# 🎉 ALL TESTS PASSED
```

**Test credentials**:
- Email: `a.vargas@ecopowertech.com`
- Password: `TestPassword123!`

### Manual Testing

**Test Registration**:
```bash
curl -X POST http://localhost:9000/store/auth/register \
  -H "Content-Type: application/json" \
  -H "x-publishable-api-key: pk_..." \
  -d '{
    "email": "test@example.com",
    "password": "Test123!",
    "first_name": "Test",
    "last_name": "User"
  }'
```

**Test Password Reset**:
```bash
# 1. Request reset
curl -X POST http://localhost:9000/store/auth/reset-password \
  -H "Content-Type: application/json" \
  -H "x-publishable-api-key: pk_..." \
  -d '{"email": "test@example.com"}'

# 2. Get token from database
npx tsx -e "
import { getSql } from './src/lib/db.js';
const sql = getSql();
const result = await sql\`SELECT metadata FROM customer WHERE email = 'test@example.com'\`;
console.log(result[0].metadata.reset_token);
process.exit(0);
"

# 3. Confirm reset
curl -X POST http://localhost:9000/store/auth/reset-password/confirm \
  -H "Content-Type: application/json" \
  -H "x-publishable-api-key: pk_..." \
  -d '{
    "token": "TOKEN_FROM_STEP_2",
    "password": "NewPassword123!"
  }'

# 4. Login with new password
curl -X POST http://localhost:9000/store/auth/login \
  -H "Content-Type: application/json" \
  -H "x-publishable-api-key: pk_..." \
  -d '{
    "email": "test@example.com",
    "password": "NewPassword123!"
  }'
```

---

## Troubleshooting

### Password Reset Fails - "Invalid key"

**Symptom**: Login returns `401 "Invalid key"` after password reset

**Cause**: Password hash not stored correctly or using wrong algorithm

**Solution**:
1. Verify scrypt-kdf is used (NOT bcrypt)
2. Check field name is `provider_metadata.password` (NOT `password_hash`)
3. Ensure hash is base64 string (NOT JSON array)

**Verify in database**:
```sql
SELECT provider_metadata 
FROM provider_identity 
WHERE provider = 'emailpass' 
AND entity_id = 'user@example.com';

-- Should return:
-- {"password": "c2NyeXB0AA8AAAAIAAAAAREogG7jKAkC..."}
```

### "Invalid email or password" after reset

**Cause**: Hash format incorrect (JSON array instead of base64 string)

**Fix**:
```typescript
// ❌ WRONG - Creates JSON array
const passwordHash = passwordHashBuffer.toString('base64')

// ✅ CORRECT - Creates base64 string
const passwordHash = Buffer.from(passwordHashBuffer).toString('base64')
```

### Reset email not sending

**Check**:
1. SendGrid API key is valid
2. `SENDGRID_FROM` email is verified in SendGrid
3. `STOREFRONT_URL` is set correctly
4. Check server logs for SendGrid errors

**Test SendGrid**:
```bash
npx tsx src/scripts/test-sendgrid.ts
```

### Token expired errors

**Default expiration**:
- Activation tokens: 24 hours
- Reset tokens: 1 hour
- JWT tokens: 24 hours

**Clear expired tokens**:
```sql
UPDATE customer
SET metadata = jsonb_set(
  metadata,
  '{reset_token}',
  'null'::jsonb
)
WHERE metadata->>'reset_expires' < NOW()::text;
```

---

## Environment Variables Reference

```bash
# Backend (.env)
DATABASE_URL=postgresql://user:pass@localhost:5432/medusa
REDIS_URL=redis://localhost:6379
PUBLISHABLE_API_KEY=pk_xxxxx
JWT_SECRET=your-secret-key
COOKIE_SECRET=your-cookie-secret

# SendGrid
SENDGRID_API_KEY=SG.xxxxx
SENDGRID_FROM=noreply@ecopowertech.com

# Frontend URL
STOREFRONT_URL=http://localhost:4321

# Google OAuth (optional)
GOOGLE_CLIENT_ID=xxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=xxxxx
GOOGLE_CALLBACK_URL=http://localhost:9000/auth/google/callback
```

---

## Implementation Checklist

### Registration & Login
- [x] Case 1: New customer registration
- [x] Case 2: Existing customer auto-login
- [x] Case 3: Legacy customer activation
- [x] JWT token generation
- [x] Custom login endpoint
- [x] Gold standard login endpoint

### Password Reset
- [x] Request reset endpoint
- [x] SendGrid email integration
- [x] Confirm reset endpoint
- [x] scrypt-kdf password hashing
- [x] Token validation and expiration
- [x] E2E test script

### Security
- [x] Password hashing with scrypt-kdf
- [x] Secure token generation
- [x] Email enumeration prevention
- [x] Token expiration handling
- [x] JWT secret configuration

### Documentation
- [x] Complete API reference
- [x] Frontend integration examples
- [x] Testing procedures
- [x] Troubleshooting guide

---

**Last Verified**: 2026-02-03  
**Test User**: `a.vargas@ecopowertech.com` / `TestPassword123!`  
**Status**: ✅ All flows tested and working in production

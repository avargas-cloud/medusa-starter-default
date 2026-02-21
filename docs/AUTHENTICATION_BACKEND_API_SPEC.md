---
**Purpose:** Precise technical spec for all authentication API endpoints — request/response schemas, HTTP status codes, implementation code snippets, database schema, and scrypt-kdf password hashing details for the 3-case registration system.

**Solves:** Provides a contract-level reference for frontend and backend developers integrating with the auth system, including edge cases like metadata parsing (string vs. array vs. object), password reuse validation, and the exact field name (`provider_metadata.password`, not `password_hash`).

**Expected Result:** Any developer can implement or debug any auth endpoint using this spec without needing to read the application code, with full visibility into database schema, error codes, and security behaviors.

---

# Backend API Specification - Customer Authentication

## Overview

Three-case authentication system for Medusa v2 handling new customers, existing customers, and legacy customer activation via email.

---

## Architecture

### Components
- **Medusa v2 Auth Module**: Native `emailpass` provider for Scrypt password hashing
- **SendGrid**: Email delivery for legacy customer activation
- **PostgreSQL**: Customer data and auth tables
- **Direct SQL**: Used for metadata operations and auth table management

### Database Tables

#### `customer`
```sql
id              TEXT PRIMARY KEY
email           TEXT NOT NULL
has_account     BOOLEAN DEFAULT FALSE
metadata        JSONB
first_name      TEXT
last_name       TEXT
created_at      TIMESTAMP
updated_at      TIMESTAMP

UNIQUE CONSTRAINT: (email, has_account) WHERE has_account = TRUE
```

#### `auth_identity`
```sql
id              TEXT PRIMARY KEY
app_metadata    JSONB  -- Contains: {customer_id: "cus_..."}
created_at      TIMESTAMP
updated_at      TIMESTAMP
```

#### `provider_identity`
```sql
id                  TEXT PRIMARY KEY
entity_id           TEXT NOT NULL  -- Customer email
provider            TEXT NOT NULL  -- "emailpass"
auth_identity_id    TEXT NOT NULL  -- FK to auth_identity
provider_metadata   JSONB          -- Contains: {password: "base64hash"}
created_at          TIMESTAMP
updated_at          TIMESTAMP

UNIQUE CONSTRAINT: (entity_id, provider)
```

---

## Endpoints

### 1. Registration - `/store/auth/register`

**Method**: `POST`

**Headers**:
```
Content-Type: application/json
x-publishable-api-key: <api_key>
```

**Request**:
```json
{
  "email": "user@example.com",
  "password": "SecurePass123!",
  "first_name": "John",
  "last_name": "Doe"
}
```

**Responses**:

#### Case 1: New Customer (200)
```json
{
  "success": true,
  "customer": {
    "id": "cus_01HXX...",
    "email": "user@example.com",
    "first_name": "John",
    "last_name": "Doe"
  },
  "token": "eyJhbGciOiJIUzI1NiIs..."
}
```

**Implementation**:
- Uses `authModule.register("emailpass", authData)`
- Scrypt hashing handled by Medusa
- JWT token generated via `generateJwtToken()`

#### Case 2: Existing Customer - Correct Password (200)
```json
{
  "success": true,
  "auto_logged_in": true,
  "customer": {
    "id": "cus_01HXX...",
    "email": "user@example.com",
    "first_name": "John",
    "last_name": "Doe"
  },
  "token": "eyJhbGciOiJIUzI1NiIs..."
}
```

**Implementation**:
- Detects `has_account = true`
- Uses `authModule.authenticate("emailpass", authData)`
- Returns existing customer + token

#### Case 2: Existing Customer - Wrong Password (409)
```json
{
  "error": "Wrong password",
  "message": "An account already exists with this email. Please login with your password."
}
```

#### Case 3: Legacy Customer (200)
```json
{
  "success": true,
  "needs_activation": true,
  "message": "Activation email sent. Please check your inbox."
}
```

**Implementation**:
- Detects `has_account = false` + `legacy_customer = true` in metadata
- Generates activation token: `base64(customer_id:timestamp)`
- Stores in metadata:
  ```json
  {
    "legacy_customer": true,
    "activation_token": "Y3VzX2xlZ2FjeV8uLi4=",
    "activation_expires": "2026-02-03T18:00:00.000Z",
    "temporary_password": "hashedPassword"
  }
  ```
- Sends email via SendGrid with activation link
- **No token returned** (requires activation first)

---

### 2. Activation - `/store/auth/activate`

**Method**: `POST`

**Headers**:
```
Content-Type: application/json
x-publishable-api-key: <api_key>
```

**Request**:
```json
{
  "token": "Y3VzX2xlZ2FjeV9hYWVhYzE2NzBjOTNhNzYyY2I2YzoxNzcwMDU2NDUxMjA2"
}
```

**Success Response (200)**:
```json
{
  "success": true,
  "customer": {
    "id": "cus_legacy_...",
    "email": "user@example.com",
    "first_name": "Legacy",
    "last_name": "Guest"
  },
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "message": "Account activated successfully. You are now logged in."
}
```

**Error Response (400)**:
```json
{
  "error": "Invalid token" | "Token expired",
  "message": "The activation link is invalid or has expired. Please register again."
}
```

**Implementation**:
1. Decode token to extract `customer_id` and `timestamp`
2. Validate token exists in customer metadata
3. Check expiration (24 hours)
4. Create `auth_identity`:
   ```sql
   INSERT INTO auth_identity (id, app_metadata)
   VALUES ('authid_...', '{"customer_id": "cus_..."}')
   ```
5. Create `provider_identity` with Scrypt-hashed password:
   ```sql
   INSERT INTO provider_identity (
     id, entity_id, provider, auth_identity_id, provider_metadata
   )
   VALUES (
     '...', 'email@example.com', 'emailpass', 'authid_...', 
     '{"password": "base64ScryptHash"}'
   )
   ```
6. Update customer:
   ```sql
   UPDATE customer 
   SET has_account = true,
       metadata = metadata - 'activation_token' - 'activation_expires' - 'temporary_password'
   WHERE id = 'cus_...'
   ```
7. Generate and return JWT token

---

### 3. Password Reset Request - `/store/auth/reset-password`

**Method**: `POST`

**Headers**:
```
Content-Type: application/json
x-publishable-api-key: <api_key>
```

**Request**:
```json
{
  "email": "user@example.com"
}
```

**Success Response (200)** - Always returns success for security:
```json
{
  "success": true,
  "message": "If this email exists, you will receive a password reset link shortly."
}
```

**Implementation**:
1. Find customer with `has_account = true`
2. Generate reset token: `crypto.randomBytes(32).toString('hex')`
3. Store in metadata:
   ```json
   {
     "reset_token": "a1b2c3...",
     "reset_expires": "2026-02-03T18:00:00.000Z"
   }
   ```
4. Send email via SendGrid with reset link
5. **Always return success** (prevents email enumeration)

**SendGrid Email**:
```
Subject: Password Reset Request
Link: ${STOREFRONT_URL}/reset-password?token=${resetToken}
Expiration: 1 hour
```

---

### 4. Password Reset Confirm - `/store/auth/reset-password/confirm`

**Method**: `POST`  
**Auth Required**: No  
**Headers**:
- `x-publishable-api-key`: Required

**Request Body**:
```json
{
  "token": "reset_token_from_email",
  "password": "new_secure_password"
}
```

**Success Response** (200):
```json
{
  "success": true,
  "customer": {
    "id": "cus_...",
    "email": "user@example.com"
  },
  "token": "eyJhbG...",
  "message": "Password reset successfully! You are now logged in."
}
```

**✅ Auto-Login**: Returns JWT token for immediate login after password reset.

**🔒 Security Features**:
- **Password Reuse Validation**: Prevents reusing current password
- **Token Expiration**: 1 hour validity
- **Single Use**: Token invalidated after use

**Error Responses**:

**400 - Password Reuse Not Allowed**:
```json
{
  "error": "Password reuse not allowed",
  "message": "Your new password cannot be the same as your current password. Please choose a different password."
}
```

**400 - Expired Token**:
```json
{
  "error": "Reset token expired",
  "message": "Password reset link has expired. Please request a new one."
}
```

**404 - Invalid Token**:
```json
{
  "error": "Invalid reset token",
  "message": "Password reset link is invalid. Please request a new one."
}
```

**💡 Technical Implementation**:
- Uses `authModule.register()` - same method as account creation
- Password hashed with scrypt-kdf (Medusa native)
- Validates new password ≠ current password using `authModule.authenticate()`
- Auto-generates JWT with 24h expiration

**Implementation** (Gold Standard - scrypt-kdf):
```typescript
// 1. Find customer by reset token
const customer = await query.graph({
    entity: "customer",
    filters: { metadata: { reset_token: token } }
})

// 2. Validate token expiration
if (new Date() > new Date(customer.metadata.reset_expires)) {
    return res.status(400).json({ error: "Token expired" })
}

// 3. Find auth_identity
const authIdentities = await authModule.listAuthIdentities({
    filters: { app_metadata: { customer_id: customer.id } }
})

// 4. Find provider_identity (emailpass)
const providerIdentities = await authModule.listProviderIdentities({
    filters: {
        auth_identity_id: authIdentity.id,
        provider: "emailpass"
    }
})

// 5. Hash password with scrypt-kdf (Medusa native)
const scrypt = (await import('scrypt-kdf')).default
const hashConfig = { logN: 15, r: 8, p: 1 }
const passwordHashBuffer = await scrypt.kdf(password, hashConfig)
const passwordHash = Buffer.from(passwordHashBuffer).toString('base64')

// 6. Update provider_metadata.password
await authModule.updateProviderIdentities([{
    id: providerIdentity.id,
    provider_metadata: {
        password: passwordHash  // Field is "password", NOT "password_hash"
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

**Critical Notes**:
- ✅ Use `scrypt-kdf` (NOT bcrypt) - Medusa's native hasher
- ✅ Store in `provider_metadata.password` (NOT `password_hash`)
- ✅ Convert hash to base64 string with `Buffer.from().toString('base64')`
- ✅ Hash config must be `{ logN: 15, r: 8, p: 1 }`

---

## Password Hashing

### Scrypt Format (Medusa v2 Compatible)

```typescript
const salt = randomBytes(16)
const hashedPassword = await scryptAsync(password, salt, 64) as Buffer
const passwordHash = Buffer.concat([
  Buffer.from('scrypt'),                           // 6 bytes: identifier
  Buffer.from([0, 15, 0, 0, 0, 8, 0, 0, 0, 1]),   // 10 bytes: params header
  salt,                                             // 16 bytes: salt
  hashedPassword                                    // 64 bytes: hash
]).toString('base64')                               // Final: 128 char base64
```

**Example hash**:
```
c2NyeXB0AA8AAAAIAAAAAREogG7jKAkCDhyl7TP2vgyOKs/nMGHFS48g1BVcZCbl69ptZSWgDvVysuk7DpqBgiryw3Z8HxiNhFGlDtjq1n0qzs7ZdRVE1REoi3TIvbTZ
```

---

## JWT Token Structure

```typescript
{
  actor_id: "cus_...",              // Customer ID
  actor_type: "customer",
  auth_identity_id: "authid_...",
  app_metadata: {
    customer_id: "cus_..."
  },
  iat: 1770056455,                  // Issued at
  exp: 1770142855                   // Expires (24h default)
}
```

**Generation**:
```typescript
import { generateJwtToken } from "@medusajs/framework/utils"

const token = generateJwtToken({
  actor_id: customer.id,
  actor_type: "customer",
  auth_identity_id: authIdentityId,
  app_metadata: { customer_id: customer.id }
}, {
  secret: http.jwtSecret,
  expiresIn: http.jwtExpiresIn
})
```

---

## Metadata Handling

### Challenge
Customer `metadata` stored as JSONB can be:
- A string containing JSON
- An array of mixed types
- A direct object

### Solution
```typescript
let rawMetadata = customer.metadata

// Parse if string
if (typeof rawMetadata === 'string') {
  rawMetadata = JSON.parse(rawMetadata)
}

// Handle array vs object
if (Array.isArray(rawMetadata)) {
  // Search through array items
  for (const item of rawMetadata) {
    if (typeof item === 'string') {
      try {
        const parsed = JSON.parse(item)
        if (parsed.activation_token) {
          activationToken = parsed.activation_token
        }
      } catch {}
    } else if (item?.activation_token) {
      activationToken = item.activation_token
    }
  }
} else if (typeof rawMetadata === 'object') {
  // Direct access
  activationToken = rawMetadata.activation_token
}
```

---

## SendGrid Configuration

### Environment Variables
```bash
SENDGRID_API_KEY=SG.xxxxxxxxxxxxx
SENDGRID_FROM=noreply@ecopowertech.com
STOREFRONT_URL=http://localhost:4321
```

### Email Template

**Subject**: `Activate Your EcoPowerTech Account`

**Body**:
```html
<p>Hi there!</p>
<p>Welcome to EcoPowerTech! Please activate your account by clicking the link below:</p>
<p><a href="${activationLink}">Activate Account</a></p>
<p>This link will expire in 24 hours.</p>
```

**Activation Link Format**:
```
${STOREFRONT_URL}/activate-account?token=${activationToken}
```

---

## Key Implementation Files

### Main Registration Handler
**Path**: `/src/api/store/auth/register/route.ts`

**Responsibilities**:
- Customer lookup with direct SQL (bypass cache)
- Case detection logic
- Routes to Case 1, 2, or 3 handlers

### Legacy Customer Handler
**Path**: `/src/api/store/auth/register/case3-legacy-customer.ts`

**Responsibilities**:
- Token generation
- Metadata update with activation data
- SendGrid email dispatch

### Activation Endpoint
**Path**: `/src/api/store/auth/activate/route.ts`

**Responsibilities**:
- Token validation and expiration check
- Auth table record creation (direct SQL)
- Customer account activation
- JWT token generation

---

## Testing

### Reset Customer to Legacy State
```bash
npx tsx src/scripts/unregister-customer.ts
```

**Actions**:
- Deletes `auth_identity` and `provider_identity`
- Sets `has_account = false`
- Adds `legacy_customer: true` to metadata

### Get Activation Token
```bash
npx tsx src/scripts/get-activation-token.ts
```

**Returns**: Current activation token from customer metadata

### Test Complete Flow
```bash
# 1. Reset customer
npx tsx src/scripts/unregister-customer.ts

# 2. Register (triggers email)
curl -X POST http://localhost:9000/store/auth/register \
  -H "Content-Type: application/json" \
  -H "x-publishable-api-key: pk_..." \
  -d '{"email": "test@example.com", "password": "Test123!"}'

# 3. Get token
TOKEN=$(npx tsx src/scripts/get-activation-token.ts | grep activation_token | ...)

# 4. Activate
curl -X POST http://localhost:9000/store/auth/activate \
  -H "Content-Type: application/json" \
  -H "x-publishable-api-key: pk_..." \
  -d "{\"token\": \"$TOKEN\"}"
```

---

## Error Handling

### Common Issues

#### Duplicate Customer on Activation
**Error**: `IDX_customer_email_has_account_unique` constraint violation

**Cause**: Customer with same email already has `has_account = true`

**Solution**: Ensure cleanup scripts delete duplicate customers

#### Provider Identity Exists
**Error**: `IDX_provider_identity_provider_entity_id` constraint violation

**Cause**: `provider_identity` not deleted during reset

**Solution**: Unregister script must delete both `auth_identity` and `provider_identity`

#### Metadata Parsing Failure
**Error**: Cannot access `metadata.activation_token`

**Cause**: Metadata is array or stringified JSON

**Solution**: Use robust parsing (see Metadata Handling section)

---

## Security Considerations

### Password Storage
- ✅ Scrypt hashing via Medusa's native auth module
- ✅ 16-byte random salt per password
- ✅ 64-byte hash output
- ✅ Base64 encoding for storage

### Token Security
- ✅ Activation tokens expire in 24 hours
- ✅ Tokens stored in database metadata (not in URL permanently)
- ✅ Token validation checks customer_id match
- ✅ One-time use (cleared after activation)

### API Security
- ✅ Publishable API key required for all requests
- ✅ JWT tokens for authenticated requests
- ✅ Password never returned in responses

---

## Dependencies

```json
{
  "@medusajs/framework": "^2.x",
  "@sendgrid/mail": "^8.x",
  "postgres": "^3.x"
}
```

---

## Environment Setup

```bash
# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/medusa

# Redis
REDIS_URL=redis://localhost:6379

# SendGrid
SENDGRID_API_KEY=SG.xxxxx
SENDGRID_FROM=noreply@ecopowertech.com

# Frontend URL for activation links
STOREFRONT_URL=http://localhost:4321

# Medusa
JWT_SECRET=your-secret-key
COOKIE_SECRET=your-cookie-secret
```

---

## API Summary Table

| Endpoint | Case | Status | Response Fields | Auto-Login |
|----------|------|--------|----------------|--------------|
| `/store/auth/register` | 1: New | 200 | `success`, `customer`, `token` | ✅ Yes |
| `/store/auth/register` | 2: Existing (OK) | 200 | `success`, `auto_logged_in`, `customer`, `token` | ✅ Yes |
| `/store/auth/register` | 2: Existing (Bad) | 409 | `error`, `message` | ❌ No |
| `/store/auth/register` | 3: Legacy | 200 | `success`, `needs_activation`, `message` | ❌ No |
| `/store/auth/activate` | 3: Success | 200 | `success`, `customer`, `token`, `message` | ✅ Yes |
| `/store/auth/activate` | 3: Error | 400 | `error`, `message` | ❌ No |
| `/store/auth/reset-password` | Request Reset | 200 | `success`, `message` | ❌ No |
| `/store/auth/reset-password/confirm` | Reset Success | 200 | `success`, `customer`, `token`, `message` | ✅ Yes (auto-login) |
| `/store/auth/reset-password/confirm` | Token Expired | 400 | `error`, `message` | ❌ No |
| `/store/auth/reset-password/confirm` | Invalid Token | 404 | `error`, `message` | ❌ No |
| `/store/auth/login` | Standard Login | 200 | `success`, `customer`, `token` | ✅ Yes |
| `/auth/customer/emailpass` | Gold Standard Login | 200 | `token` | ✅ Yes |

---

## Production Checklist

### Before Deployment
- [ ] SendGrid API key configured and verified
- [ ] STOREFRONT_URL points to production domain
- [ ] JWT_SECRET is strong and secure
- [ ] Database backup strategy in place
- [ ] Email templates tested and branded
- [ ] Rate limiting configured for auth endpoints
- [ ] Monitoring/logging set up for auth failures

### Post-Deployment
- [ ] Test all 3 authentication cases in production
- [ ] Verify emails deliver successfully
- [ ] Monitor activation success rates
- [ ] Set up alerts for auth failures
- [ ] Document customer support procedures for activation issues

---

## Support Documentation

### For Customer Support

**Legacy Customer Can't Activate**:
1. Check if activation email was sent (backend logs)
2. Verify token hasn't expired (24 hours)
3. Use reset script to regenerate activation email
4. Check spam folder

**Customer Can't Login After Activation**:
1. Verify `has_account = true` in database
2. Check `auth_identity` and `provider_identity` exist
3. Verify password hash format is correct
4. Try password reset flow

---

**Implementation Complete**:
- ✅ Registration (3 cases) - Tested 2026-02-02
- ✅ Activation - Tested 2026-02-02  
- ✅ Password Reset - Tested 2026-02-03
- ✅ Login (custom + gold standard) - Tested 2026-02-03

**Last Updated**: 2026-02-03


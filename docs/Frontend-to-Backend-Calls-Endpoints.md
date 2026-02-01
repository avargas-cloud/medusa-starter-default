# Frontend to Backend API Calls - Customer Authentication

This document tracks all frontend-to-backend API calls for customer authentication and registration flows.

---

## Customer Registration & Activation

### 1. Check Email Status

**Endpoint:** `GET /store/customers/check-email`

**Purpose:** Check if email exists and account status before registration

**Request:**
```bash
GET /store/customers/check-email?email=user@example.com
Headers:
  x-publishable-api-key: pk_xxx
```

**Response:**
```json
{
  "exists": true,
  "has_account": false,
  "is_legacy": true
}
```

---

### 2. Register New Customer

**Endpoint:** `POST /store/auth/register`

**Purpose:** Create new customer account or trigger legacy activation

**Request:**
```typescript
POST /store/auth/register
Headers:
  x-publishable-api-key: pk_xxx
Body: {
  email: string
  password: string
  first_name: string
  last_name: string
}
```

**Response - New Customer:**
```json
{
  "success": true,
  "needs_activation": false,
  "message": "Account created successfully",
  "customer": {
    "id": "cus_xxx",
    "email": "user@example.com",
    "first_name": "John",
    "last_name": "Doe"
  }
}
```

**Response - Legacy Customer:**
```json
{
  "success": true,
  "needs_activation": true,
  "message": "Activation email sent. Please check your inbox to complete registration.",
  "email": "legacy@example.com"
}
```

**Response - Duplicate Email:**
```json
{
  "error": "Email already registered",
  "message": "This email is already associated with an account. Please login instead."
}
```

---

### 3. Activate Legacy Customer Account

**Endpoint:** `POST /store/auth/activate`

**Purpose:** Process activation token from email and set password

**Request:**
```typescript
POST /store/auth/activate
Body: {
  token: string,      // From email link query param
  password: string    // New password (min 8 chars)
}
```

**Response - Success:**
```json
{
  "success": true,
  "message": "Account activated successfully! You can now login.",
  "customer": {
    "id": "cus_xxx",
    "email": "user@example.com",
    "first_name": "John",
    "last_name": "Doe"
  }
}
```

**Response - Expired Token:**
```json
{
  "error": "Token expired",
  "message": "Activation link has expired. Please request a new one."
}
```

**Response - Already Activated:**
```json
{
  "error": "Account already activated",
  "message": "This account has already been activated. Please login instead."
}
```

---

## Password Reset Flow

### 4. Request Password Reset

**Endpoint:** `POST /store/auth/reset-password`

**Purpose:** Send password reset email with secure token

**Request:**
```typescript
POST /store/auth/reset-password
Body: {
  email: string
}
```

**Response (Always Success):**
```json
{
  "success": true,
  "message": "If this email exists, you will receive a password reset link shortly."
}
```

**Note:** Returns same response regardless of whether email exists (security best practice to prevent email enumeration)

---

### 5. Confirm Password Reset

**Endpoint:** `POST /store/auth/reset-password/confirm`

**Purpose:** Process reset token and update password

**Request:**
```typescript
POST /store/auth/reset-password/confirm
Body: {
  token: string,      // From reset email link
  password: string    // New password (min 8 chars)
}
```

**Response - Success:**
```json
{
  "success": true,
  "message": "Password reset successfully! You can now login with your new password."
}
```

**Response - Invalid/Expired Token:**
```json
{
  "error": "Reset token has expired",
  "message": "Please request a new password reset link."
}
```

---

## Frontend Integration Guide

### Registration Flow

```typescript
// 1. Check email status first
const checkResponse = await fetch(
  `/store/customers/check-email?email=${email}`,
  { headers: { 'x-publishable-api-key': API_KEY } }
)
const { exists, has_account, is_legacy } = await checkResponse.json()

// 2. Handle different scenarios
if (exists && has_account) {
  // Show error: "Email already registered"
  return
}

// 3. Attempt registration
const registerResponse = await fetch('/store/auth/register', {
  method: 'POST',
  headers: { 
    'Content-Type': 'application/json',
    'x-publishable-api-key': API_KEY 
  },
  body: JSON.stringify({ email, password, first_name, last_name })
})

const result = await registerResponse.json()

if (result.needs_activation) {
  // Legacy customer: Show "Check your email" message
  navigate('/check-email')
} else {
  // New customer: Auto-login and redirect
  navigate('/dashboard')
}
```

### Activation Flow

```typescript
// Page: /activate-account?token=xxx

const token = new URLSearchParams(window.location.search).get('token')

// Show password form, on submit:
const response = await fetch('/store/auth/activate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token, password })
})

const result = await response.json()

if (result.success) {
  // Show success, redirect to login
  navigate('/login')
}
```

### Password Reset Flow

```typescript
// Page 1: /forgot-password
const response = await fetch('/store/auth/reset-password', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email })
})
// Always shows success, redirect to "check email" page


// Page 2: /reset-password?token=xxx
const token = new URLSearchParams(window.location.search).get('token')

const response = await fetch('/store/auth/reset-password/confirm', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token, password })
})

const result = await response.json()
if (result.success) {
  navigate('/login')
}
```

---

## Email Templates

### Activation Email (Legacy Customers)

**Subject:** "Activate Your Account - Ecopower Tech"

**Content:**
- Welcome message
- Blue "Activate Account" button
- Link: `/activate-account?token=xxx`
- Expires in 24 hours

### Password Reset Email

**Subject:** "Reset Your Password - Ecopower Tech"

**Content:**
- Reset password message
- Blue "Reset Password" button
- Link: `/reset-password?token=xxx`
- Expires in 1 hour

---

## Security Notes

1. **Token Expiry:**
   - Activation tokens: 24 hours
   - Reset tokens: 1 hour

2. **Password Requirements:**
   - Minimum 8 characters
   - Enforced on both frontend and backend

3. **Email Enumeration Protection:**
   - Reset password always returns success
   - Never reveals if email exists or not

4. **One-Time Tokens:**
   - All tokens invalidated after use
   - Expired tokens cleaned up from metadata

---

## Error Handling

All endpoints return consistent error format:

```json
{
  "error": "Error type",
  "message": "User-friendly error message"
}
```

Common HTTP status codes:
- `200` - Success
- `400` - Bad request (validation error)
- `401` - Unauthorized
- `409` - Conflict (duplicate email)
- `500` - Server error

---
**Purpose:** Complete implementation guide for Google OAuth social login in Medusa v2 — covering Google Cloud Console setup, OAuth callback handling, customer linking, and JWT token issuance for auto-login after Google authentication.

**Solves:** Medusa v2's Google OAuth plugin requires specific Google Cloud Console configuration (authorized redirect URIs, consent screen) that's not documented. Also covers the Medusa-side setup: provider registration in `medusa-config.ts` and the callback route for linking Google accounts to existing customers.

**Expected Result:** Customers can click "Sign in with Google", authorize via Google OAuth, and be automatically logged in (or have their existing account linked) with a valid JWT token returned to the storefront.

---

# Google OAuth Authentication - Complete Implementation Guide

**Last Updated:** February 5, 2026  
**Status:** ✅ Fully Functional  
**Medusa Version:** v2

---

## 📋 Overview

This document describes the complete implementation of Google OAuth authentication for customer login. The implementation follows Medusa v2's "Gold Standard" patterns and handles three distinct cases:

1. **Case 1:** New customer (created automatically by Auth Module)
2. **Case 2:** Existing customer (normal login)
3. **Case 3:** Legacy customer activation (QuickBooks import)

---

## 🏗️ Architecture

### Backend Components

1. **Initiate Endpoint:** `/auth/customer/google`
   - Starts OAuth flow
   - Redirects user to Google authorization

2. **Callback Endpoint:** `/auth/customer/google/callback`
   - Handles Google's callback
   - Validates authentication
   - Generates JWT token
   - Redirects to frontend

### Frontend Components

1. **Login Buttons:** Direct `<a>` links to initiate endpoint
2. **Callback Page:** `/auth/callback` - Handles token storage and redirection

---

## 🔧 Backend Implementation

### 1. Initiate Endpoint

**File:** `src/api/auth/customer/google/route.ts`

```typescript
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { Modules } from "@medusajs/framework/utils";

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
    const authModuleService = req.scope.resolve(Modules.AUTH);
    
    const redirectUrl = await authModuleService.getAuthUrl("google", {
        authScope: "store",
        protocol: req.protocol,
        host: req.headers.host,
    });

    return res.redirect(redirectUrl);
}
```

### 2. Callback Endpoint

**File:** `src/api/auth/customer/google/callback/route.ts`

**Critical Requirements:**
- ✅ Use `validateCallback()` method (NOT `authenticate()`)
- ✅ Extract email from `provider_identities[0].user_metadata.email`
- ✅ Use `customer.id` as `actor_id` in JWT (NEVER `authIdentity.id`)
- ✅ Include `customer_id` in `app_metadata`

```typescript
export async function GET(req: MedusaRequest, res: MedusaResponse) {
    const authService = req.scope.resolve(Modules.AUTH);
    const query = req.scope.resolve("query");
    
    // Step 1: Validate callback
    const { success, authIdentity } = await authService.validateCallback("google", {
        url: req.url,
        headers: req.headers,
        query: req.query,
        protocol: req.protocol,
    });

    // Step 2: Extract email
    const email = authIdentity.provider_identities?.[0]?.user_metadata?.email;

    // Step 3: Find or wait for customer
    let customer = await findCustomer(email);
    
    // Step 4: Generate JWT with CUSTOMER ID
    const token = jwt.sign({
        actor_id: customer.id,           // ← CRITICAL: Use customer.id
        actor_type: "customer",
        auth_identity_id: authIdentity.id,
        app_metadata: {
            customer_id: customer.id,    // ← Required for /api/auth/me
            provider: "google",
        },
    }, jwtSecret, { expiresIn: "24h" });

    // Step 5: Redirect to frontend
    return res.redirect(`${STOREFRONT_URL}/auth/callback?token=${token}`);
}
```

### 3. Configuration

**File:** `medusa-config.ts`

```typescript
modules: [
    {
        resolve: "@medusajs/auth",
        options: {
            providers: [{
                resolve: "@medusajs/auth-google",
                id: "google",
                options: {
                    clientId: process.env.GOOGLE_CLIENT_ID,
                    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
                    callbackUrl: `${process.env.MEDUSA_BACKEND_URL}/auth/customer/google/callback`
                }
            }]
        }
    }
]
```

---

## 🎨 Frontend Implementation

### 1. Login Button

**Files:** 
- `src/components/auth/LoginModal.astro`
- `src/pages/register.astro`
- `src/pages/es/registro.astro`

```html
<a
    href="{BACKEND_URL}/auth/customer/google"
    onclick="localStorage.setItem('oauth_return_path', window.location.pathname)"
    class="google-login-button"
>
    Continue with Google
</a>
```

**Important:** 
- Use direct `<a>` link (NOT `fetch()`)
- Store current path before redirect
- Filter out `/404` from return paths

### 2. Callback Handler

**File:** `src/pages/auth/callback.astro`

```javascript
const token = new URLSearchParams(window.location.search).get('token');

if (token) {
    // Store token
    localStorage.setItem('medusa_auth_token', token);
    
    // Smart redirect logic
    const returnPath = localStorage.getItem('oauth_return_path');
    localStorage.removeItem('oauth_return_path');
    
    let redirectTo = '/';
    
    if (returnPath && returnPath !== '/404') {
        if (returnPath === '/register') {
            redirectTo = '/my-account';
        } else {
            redirectTo = returnPath;
        }
    }
    
    window.location.href = redirectTo;
}
```

---

## 🔐 Environment Variables

### Backend `.env`

```bash
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
MEDUSA_BACKEND_URL=http://localhost:9000
STOREFRONT_URL=http://localhost:4321
```

### Frontend `.env`

```bash
PUBLIC_MEDUSA_URL=http://localhost:9000
PUBLIC_MEDUSA_BACKEND_DEV_URL=http://localhost:9000
```

---

## 🔍 Google Cloud Console Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create/Select Project
3. Enable **Google+ API**
4. Create **OAuth 2.0 Client ID** credentials
5. Add **Authorized redirect URIs:**
   ```
   http://localhost:9000/auth/customer/google/callback
   https://yourdomain.com/auth/customer/google/callback
   ```

---

## ✅ Verification

### Script Verification

Run the verification script to test JWT generation:

```bash
npx medusa exec ./src/scripts/verify/verify-google-oauth-jwt.ts
```

**Expected Output:**
```
✅ CASO 2 (Existente): JWT debe usar customer.id como actor_id
✅ CASO 1 (Nuevo): JWT debe buscar y usar el customer.id creado por Auth Module
✅ CORRECTO: actor_id === customer.id
✅ CORRECTO: app_metadata.customer_id === customer.id
```

### Manual Testing

1. Navigate to `http://localhost:4321`
2. Click "Login" → "Continue with Google"
3. Authorize with Google
4. Verify:
   - ✅ Redirected back to frontend
   - ✅ Token stored in localStorage
   - ✅ User appears logged in
   - ✅ `/api/auth/me` returns customer data

---

## 🐛 Common Issues & Solutions

### Issue: "Failed to connect to authentication server"

**Cause:** Frontend using `fetch()` instead of direct link  
**Solution:** Use `<a href=...>` instead of JavaScript fetch

### Issue: "Request already authenticated as a customer"

**Cause:** JWT `actor_id` is `authIdentity.id` instead of `customer.id`  
**Solution:** Ensure callback uses `customer.id` in JWT token data

### Issue: Redirect to 404 after login

**Cause:** `oauth_return_path` was "/404"  
**Solution:** Filter `/404` in redirect logic (already implemented)

### Issue: User not appearing logged in

**Cause:** Token not stored or JWT structure incorrect  
**Solution:** 
1. Check browser localStorage for `medusa_auth_token`
2. Decode JWT and verify `actor_id` === `customer.id`
3. Run verification script

---

## 📊 Flow Diagram

```
User clicks "Continue with Google"
    ↓
Direct link to /auth/customer/google
    ↓
Backend redirects to Google OAuth
    ↓
User authorizes on Google
    ↓
Google redirects to /auth/customer/google/callback
    ↓
Backend validates, finds/creates customer, generates JWT
    ↓
Backend redirects to frontend /auth/callback?token=XXX
    ↓
Frontend stores token in localStorage
    ↓
Frontend redirects to original page or /my-account
    ↓
User is logged in ✅
```

---

## 🔒 Security Considerations

1. **JWT Structure:** Always use `customer.id` as `actor_id`
2. **Redirect Validation:** Only allow local paths (no external URLs)
3. **Token Storage:** Use `medusa_auth_token` key in localStorage
4. **HTTPS Required:** Use HTTPS in production
5. **Secrets:** Never commit Google credentials to git

---

## 📚 Related Documentation

- `AUTHENTICATION_COMPLETE_GUIDE.md` - Complete auth system overview
- `CUSTOMER_AUTH_3_CASES_COMPLETE_GUIDE.md` - Password-based authentication
- `AUTH_DOCUMENTATION_INDEX.md` - Auth documentation index

---

## 🔄 Migration from Legacy

If migrating from the old `medusa-plugin-auth`, note:

1. ❌ Remove `medusa-plugin-auth` from `medusa-config.ts`
2. ✅ Use `@medusajs/auth-google` instead
3. ✅ Update callback to use `validateCallback()` method
4. ✅ Ensure JWT uses `customer.id` as `actor_id`

---

**Questions?** Contact the development team or see related auth documentation.

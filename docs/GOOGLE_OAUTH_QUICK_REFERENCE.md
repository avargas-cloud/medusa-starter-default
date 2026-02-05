# Google OAuth Authentication - Quick Reference

**Status:** ✅ Production Ready  
**Last Updated:** February 5, 2026

---

## 🎯 What It Does

Allows customers to log in using their Google accounts. Handles:
- New customer registration via Google
- Existing customer login via Google  
- Legacy customer activation (QuickBooks imports)

---

## 📁 Key Files

### Backend
- **Initiate:** `src/api/auth/customer/google/route.ts`
- **Callback:** `src/api/auth/customer/google/callback/route.ts`
- **Config:** `medusa-config.ts` (Auth module configuration)
- **Verification:** `src/scripts/verify/verify-google-oauth-jwt.ts`

### Frontend
- **Login Modal:** `src/components/auth/LoginModal.astro`
- **Register (EN):** `src/pages/register.astro`
- **Register (ES):** `src/pages/es/registro.astro`
- **Callback Handler:** `src/pages/auth/callback.astro`

---

## 🚀 Quick Start

### 1. Environment Setup

**Backend `.env`:**
```bash
GOOGLE_CLIENT_ID=your-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-secret
MEDUSA_BACKEND_URL=http://localhost:9000
STOREFRONT_URL=http://localhost:4321
```

**Frontend `.env`:**
```bash
PUBLIC_MEDUSA_URL=http://localhost:9000
```

### 2. Google Cloud Console

1. Create OAuth 2.0 credentials
2. Add redirect URI: `http://localhost:9000/auth/customer/google/callback`

### 3. Test

```bash
# 1. Start backend
cd backend && npm run dev

# 2. Start frontend  
cd frontend && npm run dev

# 3. Visit http://localhost:4321
# 4. Click "Login" → "Continue with Google"
```

---

## ✅ Verification

Run backend verification script:

```bash
cd backend
npx medusa exec ./src/scripts/verify/verify-google-oauth-jwt.ts
```

Expected output:
```
✅ CORRECTO: actor_id === customer.id
✅ CORRECTO: app_metadata.customer_id === customer.id
```

---

## 🔑 Critical Implementation Details

### Backend
- ✅ Use `validateCallback()` not `authenticate()`
- ✅ Extract email from `provider_identities[0].user_metadata.email`
- ✅ JWT must use `customer.id` as `actor_id` (NOT `authIdentity.id`)
- ✅ Include `customer_id` in `app_metadata`

### Frontend  
- ✅ Use direct `<a href>` link (NOT fetch)
- ✅ Store `oauth_return_path` before redirect
- ✅ Filter `/404` from return paths
- ✅ Store token in `medusa_auth_token` localStorage key

---

## 🐛 Common Issues

| Issue | Solution |
|-------|----------|
| "Failed to connect" error | Use `<a>` link instead of fetch |
| "Already authenticated" error | Check JWT `actor_id` is `customer.id` |
| Redirects to 404 | Filter `/404` from return paths |
| User not logged in | Verify token in localStorage |

---

## 📚 Full Documentation

- **Backend Guide:** `backend/docs/GOOGLE_OAUTH_COMPLETE_GUIDE.md`
- **Frontend Guide:** `frontend/docs/GOOGLE_OAUTH_FRONTEND_GUIDE.md`

---

## 🔧 Maintenance Notes

### Adding New Login Button

```html
<a
    href="{BACKEND_URL}/auth/customer/google"
    onclick="localStorage.setItem('oauth_return_path', window.location.pathname)"
>
    Continue with Google
</a>
```

### Modifying Redirect Logic

Edit `frontend/src/pages/auth/callback.astro` line 122-143

### Updating JWT Structure

Edit `backend/src/api/auth/customer/google/callback/route.ts` line 117-127

---

**Questions?** See full documentation or contact development team.

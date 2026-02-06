# Google OAuth Fix - Railway Environment Variables

## 🔧 Changes Made

Updated `medusa-config.ts` to use environment variables for CORS configuration instead of hardcoded values.

## ✅ Required Railway Environment Variables

Update these variables in Railway Dashboard:

### 1. AUTH_CORS (CRITICAL for OAuth)
```
AUTH_CORS=https://ecopowertech-headless-medusa.vercel.app,https://medusa-starter-default-production-b69e.up.railway.app
```

**Why:** This controls which domains can authenticate via OAuth. Must include:
- Frontend domain (Vercel)
- Backend domain (Railway) - for the callback

### 2. STORE_CORS (Customer API)
```
STORE_CORS=https://ecopowertech-headless-medusa.vercel.app
```

**Why:** Remove localhost URLs from production. Only production frontend should access the store API.

### 3. ADMIN_CORS (Admin Dashboard)
```
ADMIN_CORS=https://medusa-starter-default-production-b69e.up.railway.app
```

**Why:** Only the Railway-hosted admin should access admin APIs.

---

## 📋 Full Variable List for Production

Here are ALL the variables that should be set in Railway for OAuth to work:

| Variable | Value |
|----------|-------|
| `GOOGLE_CLIENT_ID` | `(your Google OAuth Client ID from Google Console)` |
| `GOOGLE_CLIENT_SECRET` | `(your Google OAuth Client Secret from Google Console)` |
| `GOOGLE_CALLBACK_URL` | `https://medusa-starter-default-production-b69e.up.railway.app/auth/customer/google/callback` |
| `MEDUSA_BACKEND_URL` | `https://medusa-starter-default-production-b69e.up.railway.app` |
| `AUTH_CORS` | `https://ecopowertech-headless-medusa.vercel.app,https://medusa-starter-default-production-b69e.up.railway.app` |
| `STORE_CORS` | `https://ecopowertech-headless-medusa.vercel.app` |
| `ADMIN_CORS` | `https://medusa-starter-default-production-b69e.up.railway.app` |
| `NODE_ENV` | `production` |

---

## 🚀 Deployment Steps

1. **Update Variables in Railway:**
   - Go to Railway Dashboard → medusa-starter-default → Variables
   - Update `AUTH_CORS`, `STORE_CORS`, `ADMIN_CORS` with values above
   
2. **Commit and Push Code:**
   ```bash
   cd backend
   git add medusa-config.ts
   git commit -m "fix: use env vars for CORS configuration in OAuth"
   git push
   ```

3. **Wait for Railway Redeploy:**
   - Railway will auto-deploy (takes ~2-3 minutes)
   - Check logs for successful startup

4. **Test OAuth Login:**
   - Go to https://ecopowertech-headless-medusa.vercel.app
   - Click "Login with Google"
   - Should redirect properly and authenticate

---

## 🐛 If Still Failing

Check Railway logs after attempting login:
1. Railway Dashboard → medusa-starter-default → Deployments → Latest → View Logs
2. Look for errors related to "Google OAuth" or "callback"
3. Share the error message for further debugging

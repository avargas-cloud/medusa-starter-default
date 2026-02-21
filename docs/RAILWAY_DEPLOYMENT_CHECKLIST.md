---
**Purpose:** Pre-deployment checklist for Railway — all required environment variables with descriptions, Railway service configuration steps, and confirmation commands to verify the backend is serving correctly before going live.

**Solves:** Missing environment variables on Railway caused silently broken functionality (auth, image uploads, search) that was hard to debug post-deploy. This checklist ensures every required variable is set before marking the deployment complete.

**Expected Result:** All env vars are set in Railway before deploy. Backend starts correctly, migrations auto-run on startup, and all integrations (PostgreSQL, Redis, MinIO, Meilisearch, SendGrid) are verified working.

---

# ⚠️ IMPORTANTE: Variables de Entorno para Railway (Producción)

Antes de hacer el deployment, **DEBES agregar estas variables en Railway**:

## 🔐 Google OAuth (NUEVAS - CRÍTICAS)

```bash
GOOGLE_CLIENT_ID=YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-YOUR_SECRET_HERE
STOREFRONT_URL=http://localhost:3000  # ← CAMBIAR a tu URL de producción cuando esté lista
```


## 📋 Cómo Agregarlas en Railway:

1. Ve a: https://railway.app/project/your-project
2. Click en tu servicio `medusa-starter-default`
3. Tab "Variables"
4. Click "+ New Variable"
5. Agregar las 3 variables arriba
6. Click "Deploy" (re-deploy automáticamente)

---

## ✅ Variables que YA deberías tener en Railway:

```bash
# Base
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
JWT_SECRET=supersecret
COOKIE_SECRET=supersecret

# CORS
STORE_CORS=http://localhost:3000,https://tu-frontend.vercel.app
ADMIN_CORS=http://localhost:9000,https://medusa-starter-default-production-b69e.up.railway.app
AUTH_CORS=http://localhost:3000,https://tu-frontend.vercel.app

# Backend
MEDUSA_BACKEND_URL=https://medusa-starter-default-production-b69e.up.railway.app

# MeiliSearch
MEILISEARCH_HOST=https://meilisearch-production-1237.up.railway.app
MEILISEARCH_API_KEY=tu_master_key

# Worker
MEDUSA_WORKER_MODE=shared
```

---

## 🎯 Después de Agregar las Variables:

Railway hará **auto-redeploy**. Espera ~2-3 minutos y verifica:

```bash
# Test OAuth endpoint
curl https://medusa-starter-default-production-b69e.up.railway.app/health

# Si responde 200 OK, el backend está vivo
```

---

## 🚨 Si el Deploy Falla:

1. **Revisa logs en Railway:** Click en "Deployments" → Última deployment → "View Logs"
2. **Errores comunes:**
   - `GOOGLE_CLIENT_ID is not defined` → Falta variable
   - `Module not found: medusa-plugin-auth` → Yarn install falló (raro)
   - `Worker mode required` → Falta MEDUSA_WORKER_MODE

---

**¿Listo para hacer push?** Confirma que agregaste las variables en Railway primero.

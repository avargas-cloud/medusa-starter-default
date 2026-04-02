# Deploy — Railway
> **Tipo**: Operational Guide
> **Repo**: backend
> **Ultima verificacion**: 2026-04-02
> **Estado**: Current

---

## Que es y por que existe

Guia operacional completa para deployar el backend de EcoPowerTech en Railway: variables de entorno requeridas, scripts de deploy, verificacion post-deploy, y troubleshooting de errores comunes.

---

## Prerequisitos

- Acceso al proyecto en Railway: https://railway.app
- Codigo pusheado a GitHub (Railway hace deploy automatico desde `main`)
- Backend URL de Railway: `https://medusa-starter-default-production-b69e.up.railway.app`

---

## Paso 1 — Variables de Entorno en Railway

Ir a Railway → Proyecto → Servicio `medusa-starter-default` → Tab "Variables"

### Base (requeridas)

```bash
DATABASE_URL=postgresql://...         # Auto-provisto por Railway PostgreSQL
REDIS_URL=redis://...                 # Auto-provisto por Railway Redis
JWT_SECRET=<openssl rand -hex 32>     # Generar: openssl rand -hex 32
COOKIE_SECRET=<openssl rand -hex 32>  # Generar: openssl rand -hex 32
NODE_ENV=production
MEDUSA_BACKEND_URL=https://medusa-starter-default-production-b69e.up.railway.app
```

### CORS (ajustar a URLs reales)

```bash
STORE_CORS=https://ecopowertech.com,https://pos.ecopowertech.com
ADMIN_CORS=https://medusa-starter-default-production-b69e.up.railway.app
AUTH_CORS=https://ecopowertech.com,https://pos.ecopowertech.com
```

### Worker Mode

```bash
WORKER_MODE=shared
# "shared" = HTTP + jobs + subscribers en un solo proceso (Railway usa un solo servicio)
# Ver DEPLOY_WORKER_MODE.md para la arquitectura de 3 capas
```

### Meilisearch

```bash
MEILISEARCH_HOST=https://meilisearch-production-1237.up.railway.app
MEILISEARCH_API_KEY=<master-key>
```

### MinIO (Storage)

```bash
MINIO_ENDPOINT=https://bucket-production-2e09.up.railway.app
MINIO_ACCESS_KEY=<access-key>
MINIO_SECRET_KEY=<secret-key>
MINIO_BUCKET=medusa-media
```

### Payment (Authorize.Net)

```bash
AUTHORIZENET_API_LOGIN_ID=<login-id>
AUTHORIZENET_TRANSACTION_KEY=<transaction-key>
AUTHORIZENET_ENVIRONMENT=production    # o "sandbox" para testing
```

### Email (SendGrid)

```bash
SENDGRID_API_KEY=<api-key>
SENDGRID_FROM=noreply@ecopowertech.com
```

### UPS Shipping

```bash
UPS_CLIENT_ID=<client-id>
UPS_CLIENT_SECRET=<client-secret>
UPS_SHIPPER_NUMBER=<account-number>
UPS_ORIGIN_NAME=Ecopowertech Inc
UPS_ORIGIN_ADDRESS=2760 W 84th St Unit 4
UPS_ORIGIN_CITY=Hialeah
UPS_ORIGIN_STATE=FL
UPS_ORIGIN_ZIP=33016
UPS_ORIGIN_COUNTRY=US
```

### Google OAuth (solo si Google login esta activo)

```bash
GOOGLE_CLIENT_ID=<client-id>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<client-secret>
GOOGLE_CALLBACK_URL=https://medusa-starter-default-production-b69e.up.railway.app/auth/customer/google/callback
STOREFRONT_URL=https://ecopowertech.com
```

### QuickBooks Bridge

```bash
QB_BRIDGE_URL=https://qb.eptbridge.com
QB_API_KEY=<api-key>
```

---

## Paso 2 — Scripts de Deploy (package.json)

```json
"predeploy": "medusa db:migrate --execute-safe-links",
"deploy": "medusa start",
"build": "medusa build && node scripts/post-build.js",
"postinstall": "patch-package"
```

### Mecanismo de patches en Railway (Railpack)

```
1. yarn install --frozen-lockfile
   → postinstall: patch-package (aplica patches a node_modules) ✓

2. medusa build
   → genera .medusa/server/ con npm install FRESCO (borra patches)
   → node scripts/post-build.js:
       • Copia patches/ → .medusa/server/patches/
       • Inyecta "postinstall": "npx --yes patch-package" en .medusa/server/package.json

3. cd .medusa/server && npm install --omit=dev --legacy-peer-deps
   → postinstall: npx --yes patch-package ← patches aplicados en produccion ✓

4. medusa start (usa .medusa/server/)
```

**IMPORTANTE:** Railpack 0.19.0 ignora `nixpacks.toml`. Solo se puede customizar via el script `"build"` en `package.json`. Cambios solo a `scripts/post-build.js` (archivo `.js`) NO triggean redeploy — tambien hay que cambiar `package.json`.

### Migraciones automaticas

`predeploy` corre `medusa db:migrate --execute-safe-links` antes de iniciar el servidor. El flag `--execute-safe-links` evita prompts interactivos en Railway.

---

## Paso 3 — Verificar Deploy

```bash
# Health check
curl https://medusa-starter-default-production-b69e.up.railway.app/health
# Debe responder: OK

# Admin panel
curl https://medusa-starter-default-production-b69e.up.railway.app/app
# Debe retornar HTML

# Store API
curl https://medusa-starter-default-production-b69e.up.railway.app/store/products \
  -H "x-publishable-api-key: pk_..."
```

---

## Cómo Agregar Variables en Railway

1. Railway Dashboard → Seleccionar proyecto
2. Click en servicio `medusa-starter-default`
3. Tab "Variables"
4. Click "+ New Variable" para cada variable
5. Al guardar, Railway hace auto-redeploy (~2-3 minutos)

Si el redeploy no se triggero: Railway → Deployments → "Trigger Redeploy" manualmente.

---

## Troubleshooting

### Cómo ver los logs del error

1. Railway Dashboard → Proyecto → Click en deployment fallido
2. Click "View Logs"
3. **Scroll hasta el FINAL** — el error real esta al final, no al principio
4. Buscar: `error`, `ELIFECYCLE`, `out of memory`, `Module not found`

### Error: Memoria insuficiente en build

```
FATAL ERROR: Reached heap limit - JavaScript heap out of memory
```

Solucion: Railway Settings → Resources → Memory → subir a 2GB o mas.

### Error: Lockfile desincronizado

```
error Your lockfile needs to be updated
```

```bash
yarn install
git add yarn.lock
git commit -m "chore: update yarn.lock"
git push
```

### Error: Build timeout

Railway tiene timeout de ~10 minutos. Si `yarn install` demora demasiado:
- Intentar "Clear Build Cache" en Railway Settings → Trigger Redeploy

### Error: Variables de entorno faltantes

```
Error: DATABASE_URL is not defined
```

Agregar la variable en Railway → Variables tab. Ver la seccion de variables arriba.

### Error: Migrations colgadas

```
Running migrations... ? Sync database schema changes?  [hangs]
```

Verificar que `predeploy` en `package.json` usa `--execute-safe-links`. Si el flag no esta, agregar y hacer push.

### Error: medusa-plugin-auth causa build failure

El plugin (v1.11.1) esta en `package.json` pero esta **comentado** en `medusa-config.ts`. Si aparece en logs como causa de fallo — no descomentar. Google OAuth usa `@medusajs/auth-google` nativo.

### Error: CORS en produccion

```
Access to fetch at '...' has been blocked by CORS policy
```

1. Verificar `STORE_CORS`, `ADMIN_CORS`, `AUTH_CORS` en Railway Variables
2. Incluir todas las URLs del frontend/POS (sin trailing slash)
3. Railway hace redeploy automatico al guardar variables

### Error: Redis connection timeout en startup

1. Verificar `REDIS_URL` en Railway Variables
2. Si Railway Redis esta linkeado, la URL se propaga automaticamente
3. Si es externo, verificar que el host sea accesible desde Railway

### Error: MinIO upload fails

Verificar las 4 variables `MINIO_*`. Testear acceso al endpoint desde Railway logs:
```bash
curl $MINIO_ENDPOINT
```

### Startup lento (>30 segundos en Railway)

Ver `DEPLOY_PERFORMANCE.md` para diagnostico detallado.

Causas comunes:
- `workerMode` mal configurado (debe ser `"shared"` o `"server"`)
- Meilisearch plugin conectando a host incorrecto al startup

---

## Archivos Clave

| Tipo | Ruta Completa | Proposito |
|------|---------------|-----------|
| Config | `/home/alejo/webapps/ecopowertech-workspace/backend/medusa-config.ts` | Configuracion central del backend |
| Config | `/home/alejo/webapps/ecopowertech-workspace/backend/package.json` | Scripts predeploy, build, postinstall |
| Script | `/home/alejo/webapps/ecopowertech-workspace/backend/scripts/post-build.js` | Copia patches a .medusa/server/ |
| Patches | `/home/alejo/webapps/ecopowertech-workspace/backend/patches/` | Patches de Medusa packages |

---

## Historial de Decisiones

- **WORKER_MODE=shared en un proceso**: En lugar de dos servicios Railway separados (server + worker), se usa un solo servicio con `workerMode: "shared"`. Reduce costos y simplifica el deploy. El worker separado se puede reactivar si la carga lo requiere.
- **medusa-plugin-auth comentado**: El plugin v1 causa conflictos con Medusa v2. Se usa `@medusajs/auth-google` nativo en lugar del plugin.
- **post-build.js para patches**: El build de Medusa genera un directorio `.medusa/server/` con un `npm install` fresco que borra los patches. El script post-build copia los patches e inyecta el postinstall hook para que se apliquen en produccion.

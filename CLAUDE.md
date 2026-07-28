# EcoPowerTech Backend — CLAUDE.md
*Last updated: 2026-05-13*

## 🌍 Arquitectura Global: El Rol del Backend
El directorio `backend/` es el **núcleo compartido (backbone)** de todo el ecosistema EcoPowerTech. Es el sistema central de verdad para el inventario, órdenes, clientes, facturación de caja, pagos y sincronía contable.
- El **Frontend Web (`web/`)** lo consume usando el Store API libremente (`/store/*`).
- El **POS Web App (`store-pos/`)** lo consume usando el Admin API (`/admin/*`) autenticado nativamente vía JWT Bearer Tokens.
- La **App de Backlighting (`backlighting/`)** interactúa con esta central para unificar catálogos de producto.

## 📚 Directrices Globales (Referencia)
**ATENCIÓN AGENTE:** Para reglas transversales de manejo de la terminal, lineamientos de confirmaciones en GitHub o cómo crear herramientas globales, DEBES usar el policy original en:
👉 `../.agent/Agent-Policy.md`

**Slash commands del workspace** (ej. `/finish`, `/test`, `/sync-memory`) viven en `../.claude/commands/` — el resolver de Claude Code los descubre solo si el cwd es la raíz del workspace. Si estás dentro de `backend/` y un `/comando` falla con "Unknown skill", `cd ..` al workspace antes de invocarlo.

Toda la documentación debajo de esta línea es **exclusiva para desarrollo dentro de `backend/`**.

---

## 🖥️ Local dev vs Preview snapshot — DOS backends, DOS puertos

Hay **dos** backends Medusa en esta máquina, separados a propósito para que nunca se mezclen:

| Modo | Puerto | tmux | Wrapper | DATABASE_URL | Uso |
|---|---|---|---|---|---|
| **Local PC dev** | `9090` | `medusa-dev` | `./back` → `backend/dev.sh` | Railway prod (`.env`) | Tu sesión normal en esta PC. Frontends locales (`./pos` 3001, `./front` 4321) le pegan a `localhost:9090`. |
| **Preview snapshot** | `9000` | `medusa-preview` | `./back-preview` → `backend/dev-preview.sh` | Container local (`127.0.0.1:5501/ecopowertech_preview`, vía `.env.preview`) | Lo que sirve `https://medusa.eptbridge.com` (Cloudflare Tunnel) para los Vercel preview deploys. Lo arranca también el `avernuz-bridge` desde `/previews` del OS. |

Pueden correr **en paralelo** (puertos distintos, tmux distintos). El bridge solo toca el preview.

### ⚠️ El gotcha de `loadEnv` que motivó este split

`@medusajs/utils/loadEnv()` **sólo** conoce `staging | production | test`. Con `NODE_ENV=development` carga **únicamente** `.env`. NUNCA lee `.env.development.local` ni `.env.preview` — esos nombres no son mágicos para Medusa. Por eso:

- `dev.sh` corre con `.env` puro (Railway).
- `dev-preview.sh` hace `set -a; source .env.preview; set +a` ANTES del `exec medusa develop`, así las overrides del snapshot quedan en el environ del proceso y el `dotenv.config()` interno de Medusa las respeta (mostrará `injecting env (0) from .env`).
- Antes de eso `dev-preview.sh` hace `unset DATABASE_URL REDIS_URL NODE_ENV` para que no quede contaminación de la shell anterior.

Mezclar los archivos manualmente (`source .env.preview` desde una shell y después correr `./back`) es la forma exacta en la que en 2026-05-26 el server arrancó con `tax_provider does not exist`: el shell tenía un `DATABASE_URL` posiblemente envenenado que no matcheaba ninguna DB completa. Usá los wrappers; no hagas `yarn dev` directo.

### 🔴 Reglas duras del preview

1. **NUNCA correr `medusa db:migrate` en preview mode**. La migración escribiría al snapshot local (inútil — se borra en el próximo refresh) o, peor, podría escribir a prod si confundís el env file. Migraciones van por Railway deploy normal.
2. **NUNCA correr `yarn seed`, `yarn sync:meili`, o cualquier script de `scripts/{migrations,fix,sync}`** mientras el preview esté activo. Esos scripts asumen escribir a prod-shaped data y sus side effects (Meili, Redis, MinIO) sí impactan prod.
3. **El snapshot expira cada 6 horas**. Cron: `0 */6 * * *` ejecutando `scripts/refresh-prod-snapshot.sh`. Datos escritos a la DB local durante el preview window se pierden en el próximo refresh — ESPERADO.
4. **`./back-preview` ABORTA** si `backend/.env.preview` no existe o si el container `pos-preview-postgres` no está UP. No intenta caer a Railway silenciosamente.

### Qué NO está aislado en preview (compartido con prod)
- Redis (sesiones, cache, event bus) — un write en preview invalida cache de prod
- MeiliSearch — un reindex en preview reescribe los índices de búsqueda de prod
- MinIO — uploads de preview escriben al bucket prod
- JWT/COOKIE secrets — mismo crypto que prod
- Email — SMTP de prod

### Qué SÍ está aislado
- `DATABASE_URL` → container local (Docker `pos-preview-postgres`)
- `WC_URL` → `http://127.0.0.1:1` (sync a WP queda noop)
- `QB_BRIDGE_URL` → `http://127.0.0.1:1` + `QB_DRY_RUN=true` (no toca QuickBooks real)

### Comandos útiles

| Acción | Comando |
|---|---|
| Levantar local PC dev (Railway, :9090) | `./back` |
| Levantar preview (snapshot, :9000) | `./back-preview` |
| Refrescar snapshot manualmente | `scripts/refresh-prod-snapshot.sh` |
| Ver último log de snapshot | `cat /tmp/prod-snapshot-$(date +%F).log` |
| Inspeccionar DB snapshot | `docker exec -it pos-preview-postgres psql -U postgres -d ecopowertech_preview` |
| Parar el container del snapshot | `docker stop pos-preview-postgres` (cron sigue intentando) |
| Reset total del snapshot | `docker rm -fv pos-preview-postgres && docker volume rm pos-preview-pg-data` |
| Ver el cron | `crontab -l` |

### Verificación de aislamiento

Para confirmar qué DB ve cada backend en runtime:

```bash
# Buscar conexiones del proceso medusa develop al puerto N:
for pid in $(pstree -p $(lsof -ti:9000 | head -1) | grep -oE '\([0-9]+\)' | tr -d '()'); do
  ss -tnp 2>/dev/null | grep "pid=$pid" | awk '{print $5}'
done | sort -u
# :9000 (preview) debe contener 127.0.0.1:5501. :9090 (dev) debe contener interchange.proxy.rlwy.net:34919.
```

Si :9090 muestra `127.0.0.1:5501` o :9000 muestra Railway, algo está cruzado — matar ambas tmux sessions y rearrancar via wrappers.

---

## 🛠️ Stack & Herramientas
- **Medusa v2.13** (Node.js, TypeScript) — Framework headless node e-commerce.
- **PostgreSQL** — Relacional principal.
- **Redis** — Triple rol: bus de eventos, workflows temporales y caché.
- **MeiliSearch** — Motor ultrarrápido para índices dinámicos de producto.
- **MinIO** — CDN de Assets (S3-Compatible).
- **Yarn Exclusivo** — ¡NO uses NPM! Bloqueado vía `.npmrc`.

## 💽 Consultas a Base de Datos (Uso obligatorio de `psql`)
Para checar registros sin gastar miles de tokens en tablas de texto inútiles con `psql`:
DENTRO del subdirectorio `backend/`:
```bash
psql $(grep DATABASE_URL .env | cut -d '=' -f2-) -A -t -c "SELECT id, email FROM \"user\" LIMIT 5;"
```
- `-A -t` son de uso estrictamente obligatorio. 
- Extraer directamente del archivo `.env` precaviene errores de rutas.

---

## 🔑 Variables de Entorno del Ecosistema Backend
| Variable Relevante | Funcionalidad en Backend |
|--------------------|--------------------------|
| `DATABASE_URL` | Cadena PG de conexión |
| `REDIS_URL` | Socket para cache / event-bus |
| `MEILISEARCH_HOST` | Index de search service |
| `JWT_SECRET` / `COOKIE_SECRET` | Cripto de sesión base interna |
| `STORE_CORS` / `ADMIN_CORS` | Allowed Origins explícitos |
| `AUTHORIZENET_API_LOGIN_ID` | Main Payment processor auth |
| `MINIO_ENDPOINT` | Credenciales de S3 Storage |
| `QB_BRIDGE_URL` | Windows VM Sync Endpoint |

---

## 🚀 Comandos de Despliegue y Local
```bash
yarn dev          # NO USAR directo — usar wrappers ./back (Railway, :9090) o ./back-preview (snapshot, :9000)
yarn build        # Production build
yarn start        # Production server
yarn type-check   # Verificación TSDoc sin emitir binarios
yarn code-quality # type-check + lint + format (Pipeline pre-push)
yarn seed         # Corre fixtures en DB
yarn sync:meili   # Suministro forzado a Search index
```

---

## 🏛️ Arquitectura Medusa v2 (Reglas y Convenciones)

### 1. APIs Públicas y Privadas
- **Admin API** (`src/api/admin/`): Operaciones maestras. Contiene endpoints creados para la caja (`invoices`, `pos-users`, `quickbooks`).
- **Store API** (`src/api/store/`): Operaciones para clientes ("checkout-v2", "fast-checkout", "branding").

### 2. Autenticación (3 Actores aislados)
- `customer`: Navegadores B2C, rutas `/store/`, identificados en `customer`.
- `user`: Rutas `/admin/`. Corresponde al staff del panel de administración.
- *Nota del POS:* El cajero también es un `user`. Sin embargo, tenemos la tabla **whitelist `pos_users`** (`pos-user` module). Un empleado solo entra al Store POS si su id de `user` figura insertado en `pos_users`.

### 3. Organización Interna Obligatoria de Scripts
Nunca escribas `.ts` sueltos en el roor. Los helpers y arreglos los debes guardar ordenadamente:
`src/scripts/{checks, verify, debug, tests, diagnostics, migrations, sync, fix}/script-name.ts`

**Unit specs (`*.unit.spec.ts`): NUNCA dentro de dirs de recurso** (`src/{workflows,jobs,api,subscribers,modules}/**/__tests__/`). `medusa develop` importa todo archivo cuyo path contenga ese substring → ejecuta `describe`/`jest` en runtime → crashea el boot local (`describe is not defined`, puerto 9000 muerto; prod inmune porque el build excluye specs). Poné los specs en `src/__tests__/<nombre>/` — jest los detecta igual (`**/src/**/__tests__/**/*.unit.spec.ts`).

### 4. Type Safety Extrema
El proyecto usa TypeScript restrictivo. Cero uso de `: any`. Cero de "implicit returns". Si un tipo no existe en en paquete oficial `@medusajs/types`, constrúyelo localmente simulando sus interfaces base.

---

## 🧩 Módulos Custom (Específicos de este proyecto)
A diferencia de Medusa base puro, construimos una sólida lista de módulos locales (ubicados en `src/modules/`) para soportar B2B, flujos de POS y finanzas.
**Regla:** El Agente *debe* revisar si un problema se atiende utilizando estos módulos y sus Workflows nativos antes de sugerir herramientas externas genéricas.

| Módulo Local | Funcionalidad Clave |
|---|---|
| `authorize-net` | Proveedor propio de captura externa de tarjetas. |
| `pos-user` | *Whitelist* registrando qué `users` administrativos acceden físicamente a caja. |
| `invoices` | Instantáneas fiscales inmutables para tickets de caja con su propia numeración. |
| `credit_memos` | Módulo de Notas de Crédito; emite "saldo a favor" durante devoluciones (Returns). |
| `finance` | El ledger corporativo; trackea balance real entre pagos, cuentas por cobrar, y créditos de un Customer B2B. |
| `document-templates` | Renderizador HTML programático interno para facturas e impresos. |
| `pos-tax` | Tax calculation provider en seco para el POS. |
| `product-attributes` | Taxonomías y metadatos técnicos extensivos (Volts, Lumens, Temperatura de color) organizados en Attribute Sets. |
| `smart-storage` | S3 File Provider propio con puente de caída fallback (MinIO → Local Directory). |
| `store-pickup` / `ups-*` | Lógica de fulfillment estática y pasarelas de cotización UPS en tiempo real. |
| `shipping-settings-*` | Exclusiones condicionales de despacho y overrides globales de admin. |
| `category-filters` | Daemon interno cruzando qué metadatos (attributes) pertenecen localmente a qué Categoría. |

---

## 🌉 QuickBooks Bridge — Integración Contable (QB Desktop)
No usamos las APIs O-Auth corporativas de (QBO). Nos enlazamos con un **QuickBooks Desktop** Windows alojado localmente en la IP corporativa (`qb.eptbridge.com`).

**Arquitectura de la Cola**
1. Un evento atómico de estado detona (ej. `order.placed`).
2. Un *Subscriber* medusiano registra esa firma en frío a la tabla universal de paso `qb_order_pipeline`.
3. *Cron Jobs* cíclicos peinan el pipeline e interactúan con el microservicio puente de Node.js alojado en el Windows del cliente de contabilidad.
4. El paquete pasa a estado `processing`, un XML builder dialoga vía Desktop SDK, y la orden se marca `completed`.
- Cualquier falla en los pasos asíncronos puede visualizarse en el Admin UI y forzarse de nuevo bajo diagnósticos. Ver documentación entera (`docs/QB_INTEGRATION_BIBLE.md`).

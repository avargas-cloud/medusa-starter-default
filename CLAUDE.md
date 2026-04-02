# EcoPowerTech Backend — CLAUDE.md

## Qué es este repo

El **núcleo compartido** de toda la plataforma EcoPowerTech. Es el sistema de verdad para inventario, órdenes, clientes, precios, pagos y contabilidad. Tanto el frontend web (`web/`) como el POS (`pos/`) y Backlighting (`backlighting/`) consumen sus APIs.

**No es "el backend del web"** — es el backbone de todo.

---

## Stack

- **Medusa v2.13** (Node.js, TypeScript) — framework headless e-commerce
- **PostgreSQL** — base de datos principal
- **Redis** — 3 roles: event bus + workflow engine + caché
- **Meilisearch** — índices de búsqueda para productos y clientes
- **MinIO** — almacenamiento de imágenes/assets (S3-compatible, self-hosted)
- **Yarn exclusivamente** — `npm install` está bloqueado por `.npmrc`

---

## Comandos

```bash
yarn dev          # Dev server (nodemon + medusa develop) → puerto 9000
yarn build        # Production build
yarn start        # Production server
yarn type-check   # TypeScript check (sin emitir)
yarn lint         # ESLint
yarn lint:fix     # ESLint auto-fix
yarn format       # Prettier
yarn code-quality # type-check + lint + format:check
yarn seed         # Seed base de datos
yarn sync:meili   # Force Meilisearch sync
yarn test:unit    # Unit tests
yarn test:integration:modules  # Módulos (sin servidor)
yarn test:integration:http     # HTTP API (requiere servidor corriendo)
```

Ver logs en dev: `tmux capture-pane -t medusa-dev -p -S -50`

---

## Autenticación — 3 Actors Separados

| Actor | Endpoint | Uso |
|---|---|---|
| `customer` | `/auth/customer/emailpass` | Compradores en la tienda web |
| `user` | `/auth/user/emailpass` | Admin panel de Medusa + staff del POS |
| `pos_user` | Módulo custom (tabla whitelist) | **No es un auth actor real** — ver nota |

> **IMPORTANTE sobre `pos_user`**: El módulo `pos-user` es una tabla que lista qué admin users (`user` actor) tienen acceso al POS. El login del POS autentica contra `/auth/user/emailpass` y luego verifica si ese user existe en la tabla `pos_users`. NO hay un sistema de auth separado para `pos_user` — son admin users con un flag extra.

---

## Módulos Custom (src/modules/)

| Módulo | Propósito |
|---|---|
| `authorize-net` | Proveedor de pagos con tarjeta (Authorize.Net) |
| `pos-user` | Tabla whitelist de staff autorizado para el POS |
| `invoices` | Facturas POS con snapshots inmutables y numeración secuencial |
| `credit_memos` | Notas de crédito por devoluciones — saldo aplicable a futuras compras |
| `finance` | Ledger financiero — balance por cliente, pagos, créditos |
| `document-templates` | Templates configurables para impresión (facturas, estimados, devoluciones) |
| `pos-tax` | Proveedor de impuestos custom para el canal POS |
| `product-attributes` | Atributos técnicos con Attribute Sets (voltaje, lumens, etc.) |
| `smart-storage` | Storage provider S3 con fallback (MinIO → local) |
| `store-pickup` | Fulfillment: recoger en tienda (siempre gratis) |
| `ground-shipping` | Fulfillment: envío terrestre con reglas condicionales |
| `ups-ground-shipping` | UPS Ground real-time rates (serviceCode 03) |
| `ups-next-day-air` | UPS Next Day Air (serviceCode 01) |
| `ups-2nd-day-air` | UPS 2nd Day Air (serviceCode 02) |
| `ups-3-day-select` | UPS 3 Day Select (serviceCode 12) |
| `shipping-settings-module` | Config centralizada de shipping |
| `category-filters` | Pre-calcula filtros por categoría |

---

## APIs

**Admin API** (`/api/admin/`) — para POS y admin panel:
`orders`, `invoices`, `customer-payments`, `pos-users`, `customers`, `products`, `inventory`, `draft-orders`, `finance`, `credit_memos`, `document-templates`, `quickbooks`, `dashboard`, `media`, `pos-discount`, `pos-promotions`, `shipping-settings`, `ups-rate-preview`, `pos-transfer`, `search`

**Store API** (`/api/store/`) — para el frontend web:
`products`, `carts`, `checkout-v2`, `customers`, `product-categories`, `branding`, `document-templates`, `fast-checkout`, `shipping-options`, `auth`

---

## QuickBooks Bridge — La integración más compleja

El backend sincroniza con **QuickBooks Desktop** via un bridge externo en `qb.eptbridge.com`. Es una arquitectura de cola asíncrona:

1. Medusa genera eventos → subscribers crean rows en `qb_order_pipeline`
2. Jobs schedulados leen el pipeline y llaman al bridge via HTTP
3. El bridge (Node.js en Windows) usa QBXML SDK para inyectar/leer datos en QB Desktop
4. El pipeline trackea estado por step (pending → processing → completed/failed)

**Regla crítica**: Después de hacer push al backend, pedirle al usuario que haga `git pull` en el servidor del bridge y reiniciarlo.

---

## Conexiones Externas

| Servicio | Env Var | Propósito |
|---|---|---|
| PostgreSQL | `DATABASE_URL` | Base de datos principal |
| Redis | `REDIS_URL` | Event bus + workflow + caché |
| Meilisearch | `MEILISEARCH_HOST`, `MEILISEARCH_API_KEY` | Search |
| MinIO | `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_BUCKET` | Storage |
| Authorize.Net | `AUTHORIZENET_API_LOGIN_ID`, `AUTHORIZENET_TRANSACTION_KEY` | Pagos |
| Resend | `RESEND_API_KEY`, `RESEND_FROM` | Emails transaccionales |
| UPS | `UPS_CLIENT_ID`, `UPS_CLIENT_SECRET` | Shipping rates |
| QB Bridge | `QB_BRIDGE_URL`, `QB_API_KEY` | QuickBooks sync |
| Google OAuth | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Auth social (customers) |

---

## Organización de Scripts (OBLIGATORIO)

```
src/scripts/
├── checks/       # check-*.ts
├── verify/       # verify-*.ts
├── tests/        # test-*.ts
├── debug/        # debug-*.ts
├── diagnostics/  # diagnose-*.ts, inspect-*.ts
├── migrations/   # migrate-*.ts
├── sync/         # sync-*.ts
└── fix/          # fix-*.ts
```

**Nunca** crear scripts en la raíz del proyecto ni sin el prefijo correcto.

---

## Arquitectura Medusa v2

- Módulos custom en `src/modules/` — cada uno tiene `service.ts`, `index.ts`, `models/`, `migrations/`
- Registrar en `medusa-config.ts`
- Workflows en `src/workflows/` (lógica transaccional con rollback automático)
- Subscribers en `src/subscribers/` (reaccionan a eventos del event bus)
- Jobs schedulados en `src/jobs/`
- Admin routes: `src/api/admin/*/route.ts`
- Store routes: `src/api/store/*/route.ts`

---

## Reglas Críticas

- **MEDUSA V2 ÚNICAMENTE** — nunca usar patrones/APIs de Medusa v1
- Siempre referenciar `@medusajs/framework` y `@medusajs/medusa` v2
- `workerMode: "shared"` en medusa-config es crítico — sin esto los subscribers no cargan
- Pool de conexiones: `min: 0` para evitar drops de Railway proxy en idle
- Redis: `pingInterval: 20000` para mantener viva la conexión con el proxy de Railway
- TypeScript strict — no `any`, no implicit returns, no unused locals
- Ver `backend/docs/INDEX.md` para documentación completa (101 docs)

---

## Docs de referencia

- `docs/INDEX.md` — índice completo (57 docs verificados contra código)
- `docs/QB_INTEGRATION_BIBLE.md` — QB Bridge arquitectura y pipeline
- `docs/POS_ARCHITECTURE.md` — arquitectura del POS
- `docs/AUTH_COMPLETE_GUIDE.md` — autenticación completa (3 actors, dual identity)

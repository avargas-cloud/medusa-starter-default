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

Toda la documentación debajo de esta línea es **exclusiva para desarrollo dentro de `backend/`**.

---

## 🗺️ graphify — Knowledge Graph (OBLIGATORIO)

El workspace tiene un grafo de conocimiento en `../graphify-out/` que cubre todos los proyectos incluyendo backend.

**ANTES de hacer Grep/Glob/Read exploratorio, consulta el grafo:**

| Necesitas | Acción |
|-----------|--------|
| ¿Dónde está implementado X? | `../graphify-out/wiki/index.md` → artículo relevante |
| ¿Qué archivos tocan feature Y? | `../graphify-out/graph.json` → campo `source_file` |
| ¿Cómo se conectan A y B? | `../graphify-out/GRAPH_REPORT.md` → "Surprising Connections" o "Communities" |
| Arquitectura general | `../graphify-out/GRAPH_REPORT.md` completo |

**Flujo correcto:**
1. Nueva sesión → leer `../graphify-out/GRAPH_REPORT.md`
2. Pregunta específica → navegar `../graphify-out/wiki/index.md`
3. **Solo si el grafo no tiene la info** → usar Grep/Glob/Read en archivos fuente

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
yarn dev          # Dev server (nodemon + medusa develop) → puerto 9000
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

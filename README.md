<p align="center">
  <a href="https://www.medusajs.com">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://user-images.githubusercontent.com/59018053/229103275-b5e482bb-4601-46e6-8142-244f531cebdb.svg">
    <source media="(prefers-color-scheme: light)" srcset="https://user-images.githubusercontent.com/59018053/229103726-e5b529a3-9b3f-4970-8a1f-c6af37f087bf.svg">
    <img alt="Medusa logo" src="https://user-images.githubusercontent.com/59018053/229103726-e5b529a3-9b3f-4970-8a1f-c6af37f087bf.svg">
    </picture>
  </a>
</p>
<h1 align="center">
  Medusa Starter & Product Attributes Implementation
</h1>

<h4 align="center">
  <a href="https://docs.medusajs.com">Documentation</a> |
  <a href="https://www.medusajs.com">Website</a>
</h4>

## 📅 Project Status: January 22, 2026

We have successfully implemented a custom **Product Attributes Module** to handle technical specifications (Voltage, Material, IP Rating, etc.) for EcoPowerTech products.

### ✅ Features Implemented

#### 1. Data Model (Backend)
- **Attribute Key**: Renamable definitions (e.g., "Color", "Voltage").
- **Attribute Value**: Options for each key (e.g., "Red", "12V").
- **Attribute Set**: Groups for organizing attributes (e.g., "Electrical Specs").
- **Product Link**: Many-to-many relationship linking products + attribute values.

#### 2. Admin UI (Frontend)
- **Main List Page** (`/app/attributes`):
  - **Accordion Layout**: Attributes grouped by Sets (or "Unassigned").
  - **Create Attribute**: Direct button to create new attributes instantly.
  - **Create Set**: Create groups to organize your specifications.
  - **Bulk Actions**: Select multiple attributes and move them between sets easily.
  - **Dark Mode Support**: UI fully adapted to Medusa's official dark/light themes.

- **Detail Page** (`/app/attributes/[id]`):
  - **Inline Renaming**: Rename attributes and option values directly on the page.
  - **Values Management**: Add, remove, and update valid options for each attribute.
  - **Safety Prompts**: Deletions are protected by confirmation modals to prevent accidents.

#### 3. Import & Migration Tools
- **Inspector Script**: `npx medusa exec ./src/scripts/inspect-product-options.ts` shows the current state of products and attributes.
- **Import Script**: `npx medusa exec ./src/scripts/import-wc-attributes.ts` migrates attributes from legacy WooCommerce JSON data into the new structure.

---

## 🛠️ Local Development

### Prerequisites
- Node.js v20+
- Git
- Access to the Railway Dashboard (for DB credentials if connecting to prod)

### Setup Steps

1.  **Clone the Repo**:
    ```bash
    git clone <your-repo-url>
    cd medusa-starter-default
    ```

2.  **Install Dependencies**:
    ```bash
    npm install --legacy-peer-deps
    ```

3.  **Start the Server**:
    ```bash
    npm run dev
    ```
    Accessed at: `http://localhost:9000/app`

---

## 🚀 Deployment Guide (Railway)

### Critical Configuration (`medusa-config.ts`)

These configurations are **REQUIRED** for Railway deployment to ensure persistence and stability.

```typescript
module.exports = defineConfig({
  projectConfig: {
    // ... DB and Redis URLs
  },
  modules: [
    // ✅ CRITICAL: Redis Modules for Persistence
    { resolve: "@medusajs/medusa/event-bus-redis", ... },
    { resolve: "@medusajs/medusa/locking", ... },
    { resolve: "@medusajs/medusa/cache-redis", ... },
    { resolve: "@medusajs/medusa/workflow-engine-redis", ... },
  ],
})
```

### Environment Variables

| Variable | Value | Importance |
|----------|-------|------------|
| `NODE_ENV` | `production` | Enables secure cookies |
| `PORT` | `9000` | Required by Railway |
| `JWT_SECRET` | [Secure String] | Session security |
| `COOKIE_SECRET` | [Secure String] | Session security |

---

## 📝 Technical Implementation Report: Product Attributes Module (Jan 22, 2026)

### 🎯 Objective
Implement a custom module to handle **technical specifications** (Voltage, Material, IP Rating) for EcoPowerTech products, fully integrated into the Medusa v2 Admin Dashboard.

### 🎯 Objective
Implement a custom module to handle **technical specifications** (Voltage, Material, IP Rating) for EcoPowerTech products, fully integrated into the Medusa v2 Admin Dashboard.

> [!IMPORTANT]
> **Rescue Manual**: For troubleshooting database issues or 1:N link failures, refer to the [Rescue Manual & Architecture Guide](./docs/product-attributes-architecture.md).

---

### ⚙️ Backend Architecture (The "Engine")

We built this feature using Medusa v2's **Module System** to ensure scalability and separation of concerns.

#### 1. Database Schema (Models)
We defined 4 core models in `src/modules/product-attributes/models`:

| Model | File | Purpose |
|-------|------|---------|
| **AttributeKey** | `attribute-key.ts` | Defines the attribute itself (e.g., "Color", "Voltage"). Contains `id`, `label`, `handle`. |
| **AttributeValue** | `attribute-value.ts` | Valid options for a key (e.g., "Red", "24V"). Linked to a Key. |
| **AttributeSet** | `attribute-set.ts` | Grouping container (e.g., "Electrical Specs"). Can contain multiple Keys. |
| **ProductAttributeValue** | `product-attribute-value.ts` | The link between a **Product** and a specific **AttributeValue**. |

#### 2. Module Registration
We registered the module in `medusa-config.ts` so the Medusa container knows about it:
```ts
{
  resolve: "./src/modules/product-attributes",
  options: { ... }
}
```

#### 3. API Actions & Workflows
In Medusa v2, we don't just write services; we write **Workflows**. This ensures data consistency.

*   **Creation**: `createAttributeKeyWorkflow`
    *   Step 1: Validate input (label, handle).
    *   Step 2: Create the Key in the database.
    *   Step 3: Return the result.
*   **Updates**: `updateAttributeKeyWorkflow`
    *   **Logic**: We had to be careful here. If we update the Name, we must NOT delete the Values.
    *   **Fix**: We implemented a check `if (input.options)` to only update options when explicitly provided.

#### 4. Custom API Routes
We exposed the logic via Admin API routes in `src/api/admin`:
*   `GET /admin/attributes`: Lists all attributes with their options.
*   `POST /admin/attributes`: Triggered the creation workflow.
*   `POST /admin/attributes/bulk-move`: A custom route to move multiple attributes into a Set at once.

---

### 🖥️ Frontend Implementation (The UI)

We built a custom page at `src/admin/routes/attributes/page.tsx`.

*   **Accordion Layout**: We opted for a collapsible list grouped by "Sets" (e.g., General, Dimensional, Electrical) to keep the UI clean.
*   **Unassigned Bucket**: A special group for attributes that haven't been categorized yet.
*   **Bulk Actions**: A blue toolbar appearing when items are selected, allowing mass-migration to Sets.
*   **Safety Prompts**: Implemented `usePrompt` to ask *"Are you sure?"* before deleting anything.

---

### 🐛 Challenges & Solutions Log

Development wasn't a straight line. Here are the specific hurdles we hit and how we fixed them:

#### 1. 🚨 The "Data Loss" Incident
*   **Problem**: When renaming an attribute (e.g., "Voltage" -> "Input Voltage"), all its values (12V, 24V) were deleted.
*   **Why**: The `updateAttribute` workflow was receiving `options: undefined` and interpreting it as "delete all options".
*   **Fix**: We modified the workflow to **ignore** the options field if it wasn't sent in the payload. Now renaming is safe.

#### 2. 🚨 The "Page Crash" (White Screen)
*   **Problem**: The Admin Page suddenly showed "An Unexpected Error Occurred".
*   **Why**: During a refactor to add the "Create Attribute" modal, we accidentally deleted the `import` statements for the *other* modals (Create Set, Rename, etc.).
*   **Fix**: We audited `page.tsx`, found the missing imports, and restored them.

#### 3. 🚨 The "Ghost Menu"
*   **Problem**: The "Attributes" link disappeared from the Sidebar.
*   **Why**: The `defineRouteConfig` block (which tells Medusa where to put the link) was deleted.
*   **Fix**: Restored the config export:
    ```ts
    export const config = defineRouteConfig({ label: "Attributes", ... })
    ```

#### 4. 🚨 The "Unused Logic" Warning
*   **Problem**: TypeScript warned that `handleBulkMove` was unused.
*   **Why**: The function existed, but the visual "Bulk Action Bar" (HTML) had been removed.
*   **Fix**: We put the Bulk Action Bar JSX back into the render method.

---

### ✅ Final Status (Jan 22, 2026 Update)
The module is **fully functional** and production-ready.

#### Recent Polish & Fixes:
1.  **Data Migration Success**:
    *   Executed `organize-attributes.ts` to sort 100+ raw attributes into 6 distinct Sets (Electrical, Physical, etc.).
    *   Implemented robust "Get or Create" logic for Sets to prevent duplication.

2.  **Creation Handlers**:
    *   Fixed "Failed to Create Set" error by modifying the API to auto-generate machine-readable handles (e.g., "My Set" -> `my-set`).

3.  **UI Refinements**:
    *   **Performance**: Enabled 5-minute React Query caching. Page loads instantly now.
    *   **UX**: Replaced "Three Dots" menu with intuitive **Pencil** (Rename) and **Trash** (Delete) icons visible on hover.
    *   **Filtering**: Verified "missing sets" were due to API 404s, created missing `attribute-sets/route.ts` to solve it.

You can now manage the entire product specification lifecycle from the Admin Dashboard. 🚀

---

## 🛠️ Railway Deployment & Build Fixes (Jan 23, 2026)

We encountered and resolved significant build and deployment issues on Railway. Here is the successful configuration for future reference.

### 1. Build Timeout & Hangs (`npm ci`)
**Problem:** The build process was hanging indefinitely during dependency installation due to memory constraints and `npm` inefficiency in the CI environment.
**Solution:**
*   **Switched to pnpm:** Migrated the project to `pnpm` (v9.15.9) for faster, more memory-efficient installs.
*   **Optimized `nixpacks.toml`:**
    *   Explicitly defined `pnpm` in the build phases.
    *   Added `NODE_OPTIONS="--max-old-space-size=4096"` to prevent OOM errors.
    *   Included build tools (`python3`, `make`, `gcc`, `g++`) for native modules.
*   **Hoisting Fix:** Created `.npmrc` with `shamefully-hoist=true` to resolve phantom dependency issues (missing `@medusajs/dashboard`).

### 2. Deployment Freeze (`db:migrate`)
**Problem:** The deployment hung during the `predeploy` phase because `medusa db:migrate` was waiting for interactive user confirmation to sync database links.
**Solution:**
*   Updated `package.json` predeploy script to use the `--execute-safe-links` flag:
    ```json
    "predeploy": "medusa db:migrate --execute-safe-links"
    ```
    This automatically accepts safe schema synchronizations without blocking the CI/CD pipeline.

### 3. TypeScript Compilation Errors
**Problem:** `attribute_value` property access caused a build failure.
**Solution:** Fixed typo in `src/scripts/verify-query-graph.ts` (changed to `attribute_values`).

### ✅ Final Successful Configuration
*   **Build Command:** `pnpm run build`
*   **Install Command:** `pnpm install --frozen-lockfile --prefer-offline`
*   **Engine:** Node v20
*   **PackageManager:** `pnpm@9.15.9`

## 🏗️ Guía de Instalación Detallada (Home Setup / Replicación)

Esta guía explica **exactamente** cómo instalar este proyecto en un entorno Windows con WSL (Ubuntu) para evitar los problemas de "bloqueo" de NPM.

### El Problema
WSL (Subsistema Linux para Windows) tiene un rendimiento de disco (I/O) lento cuando maneja los miles de archivos pequeños que `npm` intenta escribir en paralelo. Además, usar el `node.exe` de Windows dentro de Linux causa conflictos de rutas.

### La Solución
Usaremos **Node Nativo de Linux** (vía NVM) y **Yarn** (que es más eficiente).

---

### Paso 1: Limpieza (Si ya intentaste instalar antes)
Desde tu terminal en la carpeta del proyecto:
```bash
# Borra todo rastro de intentos anteriores
rm -rf node_modules package-lock.json yarn.lock .npmrc
```

### Paso 2: Instalar NVM y Node Nativo (CRÍTICO)
No uses el Node de Windows. Instala el gestor de versiones de Linux:

1.  **Instalar NVM:**
    ```bash
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
    ```
2.  **Activar NVM (o cierra y abre la terminal):**
    ```bash
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    ```
3.  **Instalar Node v20 (LTS):**
    ```bash
    nvm install 20
    nvm use 20
    ```
4.  **Verificar:**
    Escribe `which node`. Debería decir algo como `/home/tu_usuario/.nvm/...`. **NO** debe decir `/mnt/c/Program Files/...`.

### Paso 3: Activación de Yarn
Con Node nativo activo, instalamos Yarn globalmente en Linux:
```bash
npm install -g yarn
```

### Paso 4: Instalación del Proyecto
Ahora sí, instalamos las dependencias. Yarn es mucho más rápido y no se cuelga.
```bash
yarn install
```
*(Esto tomará unos 2-3 minutos y mostrará una barra de progreso)*.

### Paso 5: Build y Ejecución
Compilamos el backend y el frontend administrativo:
```bash
yarn build
```

Finalmente, levanta el servidor:
```bash
yarn dev
```

---

### Resumen para el Día a Día
Cada vez que abras tu terminal para trabajar:
```bash
nvm use 20
yarn dev
```

# 🛡️ Agent Policy: Ecopowertech Medusa Backend Architecture (Railway)

# ⚠️ CRITICAL CHECKS - READ FIRST BEFORE ANY ACTION

## 🚨 Package Manager: YARN ONLY
- ✅ **Use**: `yarn install`, `yarn add`, `yarn dev`, `yarn build`
- ❌ **NEVER use**: `npm install`, `npm i`, `npm ci`, `npm run`, `npx`
- **Why**: NPM has I/O performance issues on WSL
- **Enforcement**: `.npmrc` blocks npm completely with `engine-strict=true`
- **Check**: Look for `yarn.lock` (✅) vs `package-lock.json` (❌ delete it)

## 🚨 Database & Services (Railway)
- **Source of truth**: `.env` file contains Railway credentials
- Never hardcode connection strings in code
- Always use `DATABASE_URL`, `REDIS_URL`, `MEILISEARCH_HOST` from environment

## 🚨 TypeScript Strict Mode
- No `any` types allowed
- All code must be strictly typed
- Use types from `@medusajs/framework` and `@medusajs/medusa`

---

Actúa como un **Senior Backend Architect** y **Medusa V2 Expert**. Tu misión es mantener la integridad, escalabilidad y seguridad del motor de comercio headless de Ecopowertech, desplegado sobre infraestructura **Railway**.


## 1. Reglas de Oro para Infraestructura y Secretos (Crítico)

**Infraestructura Railway**:
-   **Postgres & Redis**: Asume que estos servicios están provistos por Railway.
-   **Source of Truth**: El archivo `.env` local y las variables de entorno de Railway en producción contienen la configuración correcta. **NO** intentes reconfigurar puertos o hosts de base de datos manualmente en el código; usa siempre las variables.

**Jerarquía de Variables de Entorno**:

-   **`DATABASE_URL`**: Conexión a Postgres (Railway Protocol).
-   **`REDIS_URL`**: Bus de eventos y caché (Railway Protocol).
-   **`STORE_CORS` / `ADMIN_CORS` / `AUTH_CORS`**: Asegura que los orígenes del frontend (Astro) estén permitidos aquí.
-   **`JWT_SECRET` / `COOKIE_SECRET`**: Claves maestras para la seguridad de sesión.

**Reglas de Entorno Local (WSL/Linux)**:
-   **NodeJS**: Usar estrictamente **Node v20+ Nativo de Linux** (NVM). `node.exe` de Windows está PROHIBIDO.
-   **Package Manager**: **Yarn**. NPM está prohibido por problemas de rendimiento I/O en WSL.
-   **Instalación**: Siempre desde la terminal Linux (`$`), no desde PowerShell.

**Conciencia de Entorno**:
-   **Producción (Railway)**: `cookieOptions.secure` = `true`, `sameSite` = `none`.
-   **Desarrollo**: Confía en tu `.env` local.

## 2. Estándares de Desarrollo de Medusa V2

-   **TypeScript Estricto**: Todo debe estar tipado. No aceptes `any`. Usa los tipos exportados de `@medusajs/framework` y `@medusajs/medusa`.
-   **Arquitectura Modular**:
    -   **Nuevos Dominios = Nuevos Módulos**: Si agregas funcionalidad que no encaja en el core, crea un módulo en `src/modules`.
    -   **Atomicidad**: Usa **Workflows** (`@medusajs/framework/workflows-sdk`) para lógica de negocio compleja que requiera pasos transaccionales.
-   **Subscriber Pattern**: Para reacciones a eventos (ej: "pedido creado" -> "enviar email"), usa Subscribers.

## 3. Protocolo de Base de Datos y Migraciones

-   **Schema First**: Todo cambio de esquema requiere migración.
-   **Comando de Migración**: `yarn medusa db:migrate`.
-   **Seeders**: Scripts en `src/scripts/seed.ts`.

## 4. API & Rutas (Headless)

-   **Custom API Routes**: `src/api/store/...` (Público) y `src/api/admin/...` (Panel).
-   **Validation**: Usa **Zod** o validadores tipados.
-   **Response Format**: `{ "key": { ...data... } }`.

## 5. Protocolo de Comunicación (Vibe Coding)

-   **Modo Planning**: Antes de modificar el esquema de base de datos o crear un nuevo módulo, presenta un plan.
-   **Verificación**: Antes de cerrar una tarea, verifica que el servidor inicie (`yarn dev`) y que los nuevos endpoints respondan.

## 6. Global Skills Index (Backend Focused)

A continuación se listan lose skills instalados globalmente disponibles para potenciar el desarrollo:
/home/alejo/.agent/skills/

*(Lista de skills altamente relevantes)*
- `backend-dev-guidelines`
- `nodejs-best-practices`
- `typescript-expert`
- `postgres-best-practices`
- `api-security-best-practices`
- `test-driven-development`

## 7. Critical Skills Protocol (MANDATORY)

Para asegurar la máxima calidad y coherencia en cada iteración, el agente **DEBE** consultar y aplicar los principios de los siguientes skills.

### 🧠 Arquitectura & Core
*   **`senior-architect`**: Valida que los nuevos módulos no rompan la arquitectura hexagonal/modular de Medusa V2.
*   **`nodejs-best-practices`** & **`typescript-expert`**: El código debe ser idiomatic Node.js y usar TS avanzado (Generics, Utility Types) cuando sea necesario.
*   **`database-design`**: Antes de crear tablas, normaliza y piensa en índices.

### 🛡️ Seguridad
*   **`api-security-best-practices`**: Rate limiting, validación de inputs y sanitización.
*   **`broken-authentication`**: Gestión robusta de Auth.
*   **`idor-testing`**: Validación estricta de propiedad de recursos.

### 🧪 Verificación (OBLIGATORIO) -- `verification-before-completion`
*   **`systematic-debugging`**: Si algo falla, aísla el problema paso a paso.
*   **Smoke Test**: Al menos muestra un `curl` exitoso a tu nuevo endpoint o una ejecución de consola limpia.

## 8. Consultas a la Base de Datos

Instrucción para el Agente: Cuando necesites buscar información real en la base de datos de Medusa, NO alucines datos. Ejecuta este comando en la terminal: node ~/.agent/skills/medusa-db-tool/query.js "TU CONSULTA SQL AQUI"

## 9. Agent Policy: Code Modularization

### Core Principle

**NEVER create monolithic files. ALWAYS fragment code into small, focused modules.**

### Why This Matters

When you restore a large file from git, you lose ALL changes:
- ❌ Lost validation logic
- ❌ Lost confirmation handlers
- ❌ Lost helper functions
- ❌ Everything in that file is gone

With modular code:
- ✅ Restore affects only one small file
- ✅ Other modules remain intact
- ✅ Easier to test and maintain
- ✅ Clearer responsibilities

### Mandatory Rules

#### Rule 1: Maximum File Size

**Absolute Maximum**: 300 lines per file

If a file exceeds 200 lines, strongly consider refactoring.

#### Rule 2: One Responsibility Per File

Each file should have ONE clear purpose:
- ✅ `useVariantValidation.ts` - Validation logic only
- ✅ `useConfirmation.ts` - Confirmation modal logic only
- ❌ `manage-attributes-modal.tsx` - Everything (BAD)

#### Rule 3: Extract Functions to Separate Files

Instead of:
```typescript
// manage-attributes-modal.tsx (600 lines)
const ManageModal = () => {
    const validateVariant = () => { /* 50 lines */ }
    const handleConfirm = () => { /* 30 lines */ }
    const groupByKey = () => { /* 40 lines */ }
    // ... 400+ more lines
}
```

Do this:
```typescript
// hooks/useVariantValidation.ts (50 lines)
export const useVariantValidation = () => { /* logic */ }

// hooks/useConfirmation.ts (30 lines)
export const useConfirmation = () => { /* logic */ }

// utils/groupAttributes.ts (40 lines)
export const groupAttributesByKey = () => { /* logic */ }

// ManageAttributesModal.tsx (100 lines)
import { useVariantValidation } from './hooks/useVariantValidation'
import { useConfirmation } from './hooks/useConfirmation'
import { groupAttributesByKey } from './utils/groupAttributes'

const ManageModal = () => {
    const validate = useVariantValidation()
    
#### Rule 4: Standard Folder Structure

For any complex component, use this structure:
├── index.ts                    # Public exports
├── [Feature]Container.tsx      # Main container (UI only)
├── hooks/
│   ├── use[Feature]Data.ts     # Data fetching
│   ├── use[Feature]Actions.ts  # Actions/mutations
│   └── use[Feature]State.ts    # Local state management
├── components/
│   ├── [Feature]Form.tsx       # Sub-components
│   ├── [Feature]List.tsx
│   └── [Feature]Item.tsx
└── utils/
    ├── validation.ts           # Validation logic
    ├── formatting.ts           # Formatters
    └── constants.ts            # Constants
```

Example for attributes:
```
src/admin/components/attribute-management/
├── index.ts
├── ManageAttributesModal.tsx   # 100 lines - just UI structure
├── hooks/
│   ├── useAttributeData.ts     # Fetching attributes
│   ├── useVariantValidation.ts # Min 2 values check
│   ├── useConfirmation.ts      # Confirmation logic
│   └── useAttributeActions.ts  # Add/remove/toggle
├── components/
│   ├── AttributeRow.tsx        # Single attribute row
│   ├── AddAttributeForm.tsx    # Add new form
│   └── ConfirmationDialog.tsx  # Confirmation UI

#### Rule 5: When Implementing New Features

**BEFORE writing code**, ask yourself:

1. Will this file exceed 200 lines?
   - If YES: Plan module structure first
   
2. Does this have multiple responsibilities?
   - If YES: Split into separate files
   
3. Could this logic be reused?
   - If YES: Extract to utils/ or hooks/

4. Will editing this file risk breaking other functionality?
   - If YES: It's too large, refactor first

#### Rule 6: Refactoring Trigger Points

Refactor immediately when:
- File reaches 200 lines
- Adding new feature to existing large file
- Function is used in multiple places
- Logic is complex (>50 lines for one function)
- You need to restore file from git

#### Rule 7: Git Restore Safety

When you need to restore a file:

**Before Restore**:
1. Extract all custom logic to separate files
2. Commit those files
3. NOW restore the main file
4. Re-import the extracted logic

**Example**:
```bash
# DON'T do this:
git checkout HEAD -- manage-attributes-modal.tsx  # Loses everything

# DO this:
# 1. Extract first
cp manage-attributes-modal.tsx manage-attributes-modal.backup.tsx
# Create useConfirmation.ts with confirmation logic
git add hooks/useConfirmation.ts
git commit -m "Extract confirmation logic"
# 2. Now safe to restore

### Practical Examples

#### Example 1: Attribute Management (Current Bad State)

**BEFORE** (Monolithic):
manage-attributes-modal.tsx - 610 lines
- UI structure
- Data fetching
- Validation logic
- Confirmation handling
- Add/remove logic
- Sync functionality
```

**AFTER** (Modular):
```
ManageAttributesModal.tsx - 100 lines (UI only)
hooks/useAttributeData.ts - 50 lines
hooks/useVariantValidation.ts - 40 lines
hooks/useConfirmation.ts - 30 lines
hooks/useAttributeActions.ts - 60 lines
components/AttributeRow.tsx - 50 lines

#### Example 2: API Routes

**BEFORE** (Monolithic):
- POST handler
- Cleanup logic
- Variant generation
- Pricing integration
```

**AFTER** (Modular):
route.ts - 50 lines (route definitions only)
handlers/getAttribute.ts - 30 lines
handlers/syncAttributes.ts - 40 lines

#### Migration Strategy

For existing large files:

##### Phase 1: Identify Responsibilities
List all functions and group by purpose

##### Phase 2: Create Module Files
One file per responsibility group

##### Phase 3: Extract & Test
Move one group at a time, test after each

##### Phase 4: Update Main File
Import and use extracted modules

##### Phase 5: Document
Add comments explaining module structure

## Enforcement

This is a **MANDATORY** policy for:
- All new features
- Any file edits that bring size >200 lines
- Before major refactors
- When requested by user

## Benefits Checklist

When code is properly modularized:
- [ ] Each file <200 lines
- [ ] Clear file naming shows purpose
- [ ] Easy to find specific logic
- [ ] Can restore single file safely
- [ ] Tests are isolated and simple
- [ ] Reduces merge conflicts
- [ ] Easier code review
- [ ] Better TypeScript performance

## Anti-Patterns to Avoid

### ❌ DON'T: "Everything in one file for convenience"
### ❌ DON'T: "I'll refactor later" (you won't)
### ❌ DON'T: Copy-paste logic instead of extracting to shared file
### ❌ DON'T: Mix concerns (UI + business logic + data fetching in one file)

### ✅ DO: Extract early and often
### ✅ DO: Use TypeScript to enforce module boundaries
### ✅ DO: Create index.ts to expose public API
### ✅ DO: Keep related files close in folder structure

---

**Remember**: Time spent organizing code saves 10x time later debugging and maintaining.

**Last Updated**: 2026-01-24

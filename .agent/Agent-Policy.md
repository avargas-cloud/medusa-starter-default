# 🛡️ Agent Policy: Ecopowertech Medusa Backend Architecture (Railway)

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
-   **Comando de Migración**: `npx medusa db:migrate`.
-   **Seeders**: Scripts en `src/scripts/seed.ts`.

## 4. API & Rutas (Headless)

-   **Custom API Routes**: `src/api/store/...` (Público) y `src/api/admin/...` (Panel).
-   **Validation**: Usa **Zod** o validadores tipados.
-   **Response Format**: `{ "key": { ...data... } }`.

## 5. Protocolo de Comunicación (Vibe Coding)

-   **Modo Planning**: Antes de modificar el esquema de base de datos o crear un nuevo módulo, presenta un plan.
-   **Verificación**: Antes de cerrar una tarea, verifica que el servidor inicie (`npm run dev`) y que los nuevos endpoints respondan.

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
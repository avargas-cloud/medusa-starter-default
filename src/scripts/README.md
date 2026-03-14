# EcoPowerTech Scripts Organization Guide

## ⚠️ Agente Antigravity: Reglas de Creación de Scripts
Cuando el USER o el sistema te pida crear o diagnosticar algo mediante un script (archivo `.js`, `.ts`, `.mjs`, `.sql`), **NUNCA** lo debes soltar en la raíz de `scripts/` ni de `src/scripts/`.

Deberás ubicar el script dentro de una de las siguientes subcategorías principales (o crear una nueva subcarpeta específica dentro del Dominio principal) dependiendo del **Dominio de Responsabilidad** que toque dicho script.

### 1. `scripts/frontend/`
Scripts que impacten el Store Frontend Público (Next.js).
- `seo_prerender/`: Actualizaciones de Metadatos SSG, re-generación de rutas, cachés.
- `auth/`: Diagnósticos de autenticación B2C, Google OAuth, reset tokens.
- `data_sync/`: Testing de información que fluye del backend al frontend.

### 2. `scripts/pos/`
Scripts que impacten exclusivamente a la aplicación EcoPowerTech Store POS.
- `estimates_and_orders/`: Conversiones, facturas, y metadatos de ventas hechas en escritorio.
- `auth_and_routing/`: Testing sobre guards, layouts híbridos y empleados.

### 3. `scripts/admin/`
Scripts operacionales orientados a manipular entidades de la UI de Medusa Admin (Backoffice).
- `user_mgmt/`: Administradores nativos, recuperación de clave `admin@...`.
- `shipping_rules/`: Test de módulos de fulfillment, UPS, custom calculations.
- `data_fixes/`: Corrección manual de data (borrar tests accounts, records huerfanos).

### 4. `scripts/qb_sync/`
Herramientas que giran en torno al QuickBooks Desktop Web Connector Bridge.
- `core_jobs/`: Comandos raw para forzar sincronizaciones (Prices, Inventory, Customers).
- `data_rescue/`: Arreglo de IDs rotos, SKUs huérfanos que el cronjob rebotó o anomalías post-sync.
- `tests_debug/`: Comprobantes matemáticos ("dry-run") o lecturas puras para diagnosticar el webhook XML.

### 5. `scripts/medusa_core/`
Scripts de bajo nivel que alteran o interactúan con la arquitectura pura del Backend (Medusa v2), independiente de las aplicaciones que lo consuman.
- `database_migration/`: Los scripts formales de iteración local, pases a PRD, y migraciones SQL.
- `search_engine/`: Re-indexaciones de Meilisearch o testeo de search records.
- `pricing_tax/`: Cambios de Tax Rates, Wholesale, o estructura de listas de precios masivas.
- `products_inventory/`: Reestructuraciones de modelos de producto, metadata compleja, variantes o links.
- `customers_users/`: Queries raw para verificar identidades subyacentes.

**Nota para el LLM**: Asegúrate de agrupar todos los scripts que crees lógicamente, creando las carpetas hijo (ejs. `admin/shipping_rules/`) en lugar de poner todo en los folders mayores que mezclan responsabilidades.

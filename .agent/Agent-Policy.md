# 🛡️ Agent Policy: Ecopowertech Headless Architecture

Actúa como un Senior Frontend Architect y Expert Vibe Coder. Tu misión es mantener la coherencia técnica y estética del sitio Ecopowertech (Astro + Headless WordPress).

## 1. Reglas de Oro para el Manejo de URLs (Crítico)

**Prohibición de Hardcoding**: Queda estrictamente prohibido escribir cadenas de texto fijas como `ecopowertech.com` o la URL de Cloudways dentro de cualquier componente o script.

**Jerarquía de Variables de Entorno**:

-   **`PUBLIC_WORDPRESS_URL`**: Úsala únicamente para llamadas a la API de WPGraphQL y para el origen de archivos multimedia (imágenes/videos).
-   **`PUBLIC_WP_SITE_URL`**: Úsala como la URL base obligatoria para todos los enlaces de navegación interna, etiquetas `<link rel="canonical">`, y metadatos de redes sociales (Open Graph/Twitter).

**Diferenciación de Rutas**:

-   **Navegación**: Todo enlace `<a>` debe generarse usando la lógica de Astro o concatenando con `PUBLIC_WP_SITE_URL` para asegurar que el usuario nunca abandone el frontend.
-   **Recursos**: Las imágenes deben servirse desde el dominio de WordPress definido en la API, pero el link que rodea a la imagen debe apuntar al sitio en Astro.

**Conciencia de Entorno**: Debes reconocer dinámicamente si estás en Producción (usando el dominio final), Preview de Vercel (usando la URL de la rama), o Localhost (usando `localhost:4321`), ajustando los enlaces automáticamente para no romper el flujo de navegación.

## 2. Estándares de Desarrollo

-   **TypeScript Estricto**: No aceptes `any`. Define interfaces para todas las respuestas de WPGraphQL antes de mapear los datos a los componentes.
-   **Tailwind CSS Only**: No crees archivos `.css` adicionales. Estiliza todo usando clases de utilidad de Tailwind para mantener la ligereza del proyecto.
-   **Astro Islands**:
    -   Usa componentes de Astro (`.astro`) por defecto para máximo SEO y rendimiento (Zero JS).
    -   Reserva React/Next.js solo para componentes que requieran estado complejo o interactividad del lado del cliente, marcándolos con la directiva `client:load` o `client:visible` adecuadamente.

## 3. SEO y Performance

-   **Canonical Tags**: Cada página debe generar su propia URL canónica concatenando `PUBLIC_WP_SITE_URL` con el `Astro.url.pathname`.
-   **Optimización de Imágenes**: Usa el componente `<Image />` de Astro para procesar las imágenes que vienen de WordPress, garantizando WebP y carga diferida (lazy loading).

## 4. Protocolo de Comunicación (Vibe Coding)

-   **Modo Planning**: Antes de realizar cambios estructurales, debes usar el modo Planning para presentar un plan de acción. No toques el código hasta que el usuario apruebe el plan.
-   **Verificación de Contexto**: Antes de cada tarea, confirma que tienes acceso a las variables de entorno de Vercel configuradas (`PUBLIC_WORDPRESS_URL` y `PUBLIC_WP_SITE_URL`).

## 5. Estrategia de Layouts (Headless)

El proyecto utiliza una estrategia de enrutamiento dinámico unificado en `src/pages/[slug].astro`.

**Jerarquía de Decisión (Automática):**

1.  **Productos (`Product`, `SimpleProduct`, `VariableProduct`)**:
    -   Layout: **`HeadlessProductLayout.astro`**
    -   Uso: Renderizado automático para cualquier slug que sea un producto en WooCommerce.

2.  **Categorías (`ProductCategory`)**:
    -   Layout: **`HeadlessCategoryLayout.astro`**
    -   Uso: Renderizado automático para cualquier slug que sea una categoría de productos.

3.  **Páginas (`Page`)**:
    -   **App Layout (`AppLayout.astro`)**: Se activa si el campo ACF `enableVisualLayoutapp` es `true`. Para páginas ricas visualmente ("Applications").
    -   **Category Layout Legacy (`CategoryLayout.astro`)**: Se activa si el campo ACF `enableVisualLayoutCategory` es `true` (Legacy manual).
    -   **Plain Layout (`Layout.astro`)**: Default para páginas informativas simples.

## 6. Protocolo de Estabilidad y Enrutamiento Headless (OBLIGATORIO)

### 1. Prevención de Sobrecarga (Anti-Hang)

*   **Límites de Consulta**: Queda estrictamente prohibido realizar queries a `products` o `productCategories` sin el argumento `(first: XX)`. El valor por defecto debe ser 50.
*   **Paginación Eficiente**: Ante conjuntos de datos mayores a 50 elementos, es obligatorio el uso de cursores (`after`, `hasNextPage`) en lugar de intentar traer colecciones completas.
*   **Lean Data Fetching**: En listados generales, solicita solo campos esenciales (`id`, `name`, `uri`). Los datos pesados (descripciones largas, meta-campos complejos) deben solicitarse solo en las rutas de detalle específicas.

### 2. Enrutamiento y SEO (Anti-404)

*   **Prioridad de URI**: Para generar rutas en Astro, se debe ignorar el campo `slug` y utilizar exclusivamente el campo `uri` de WPGraphQL. El `uri` es el único que garantiza la jerarquía correcta de categorías anidadas.
*   **Catch-all Routes**: Toda implementación de categorías de producto debe usar el patrón de archivo `src/pages/product-category/[...categoryPath].astro`. Esto permite capturar paths de profundidad infinita sin romper el enrutamiento.
*   **Limpieza de Paths**: Al procesar el `uri` en `getStaticPaths`, se deben eliminar los slashes iniciales y finales para asegurar la coincidencia exacta con los parámetros de Astro.

### 3. Gestión de Rendimiento del Backend

*   **Consciencia de Caché**: El agente debe asumir que existen capas de Varnish y Redis. Si un cambio en WordPress no se refleja, el agente debe sugerir o ejecutar la purga de estas capas antes de intentar modificar el código.
*   **Timeouts**: Si una respuesta de la API de WordPress tarda más de 5 segundos, el agente debe abortar la ejecución, analizar la complejidad de la query y proponer una versión simplificada.

### 4. Formato de Código y Debug

*   Cada nueva ruta dinámica debe incluir un bloque de validación: `if (!data) return Astro.redirect('/404');`.
*   Incluir `console.log` descriptivos en la fase de `getStaticPaths` para auditar la generación de rutas durante el build.

## 7. Global Skills Index

A continuación se listan lose skills instalados globalmente disponibles para potenciar el desarrollo:
%USERPROFILE%\.gemini\antigravity\skills


- active-directory-attacks
- address-github-comments
- agent-manager-skill
- algorithmic-art
- api-fuzzing-bug-bounty
- app-store-optimization
- autonomous-agent-patterns
- aws-penetration-testing
- backend-dev-guidelines
- blockrun
- brainstorming
- brand-guidelines-anthropic
- brand-guidelines-community
- broken-authentication
- bun-development
- burp-suite-testing
- canvas-design
- claude-code-guide
- claude-d3js-skill
- cloud-penetration-testing
- concise-planning
- content-creator
- core-components
- dispatching-parallel-agents
- doc-coauthoring
- docx-official
- ethical-hacking-methodology
- executing-plans
- file-organizer
- file-path-traversal
- finishing-a-development-branch
- frontend-design
- frontend-dev-guidelines
- git-pushing
- github-workflow-automation
- html-injection-testing
- idor-testing
- internal-comms-anthropic
- internal-comms-community
- javascript-mastery
- kaizen
- linux-privilege-escalation
- linux-shell-scripting
- llm-app-patterns
- loki-mode
- mcp-builder
- metasploit-framework
- network-101
- notebooklm
- pdf-official
- pentest-checklist
- pentest-commands
- planning-with-files
- playwright-skill
- pptx-official
- privilege-escalation-methods
- product-manager-toolkit
- prompt-engineering
- prompt-library
- react-best-practices
- react-ui-patterns
- receiving-code-review
- red-team-tools
- requesting-code-review
- scanning-tools
- senior-architect
- senior-fullstack
- shodan-reconnaissance
- skill-creator
- skill-developer
- slack-gif-creator
- smtp-penetration-testing
- software-architecture
- sql-injection-testing
- sqlmap-database-pentesting
- ssh-penetration-testing
- subagent-driven-development
- systematic-debugging
- test-driven-development
- test-fixing
- testing-patterns
- theme-factory
- top-web-vulnerabilities
- ui-ux-pro-max
- using-git-worktrees
- using-superpowers
- verification-before-completion
- web-artifacts-builder
- web-design-guidelines
- webapp-testing
- windows-privilege-escalation
- wireshark-analysis
- wordpress-penetration-testing
- workflow-automation
- writing-plans
- writing-skills
- xlsx-official
- xss-html-injection

## 8. Critical Skills Protocol (MANDATORY)

Para asegurar la máxima calidad y coherencia en cada iteración, el agente **DEBE** consultar y aplicar los principios de los siguientes skills en cada paso del proceso de desarrollo. No es opcional.

### 🧠 Cerebro y Estrategia
*   **`senior-architect`**: Antes de cualquier cambio estructural, valida que no rompa la integridad del sistema Headless.
*   **`senior-fullstack`**: Mantén la visión global de la conexión Astro <-> WordPress.
*   **`writing-plans`**: OBLIGATORIO para el modo Planning. Todo plan debe seguir esta estructura.
*   **`systematic-debugging`**: Si encuentras un error, sigue rigurosamente este protocolo antes de intentar "adivinar" la solución.

### 🎨 Frontend & "Wow" Factor
*   **`ui-ux-pro-max`**: **NUEVO ESTÁNDAR**. Úsalo para elevar el nivel de diseño de interfaces. Contiene patrones avanzados de UI/UX.
*   **`frontend-design`**: Aplica esto para cumplir con la regla de "Diseño Premium".
*   **`web-design-guidelines`**: Referencia para tipografía, color y espaciado.
*   **`react-best-practices`**: Estándar para cualquier componente interactivo (React/Preact).

### 🛡️ Seguridad
*   **`wordpress-penetration-testing`**: Ten en mente las vulnerabilidades comunes de WP al exponer endpoints.


### 🧪 Verificación y Control de Calidad (OBLIGATORIO)
*   **`verification-before-completion`**: **REGLA DE ORO**. Nunca cierres un ticket o tarea ("Task Complete") sin haber probado tu código.
    *   Si puedes probarlo tú mismo (unit tests, curl, inspección de archivos): **HAZLO** y muestra la evidencia.
    *   Si requiere intervención humana (UI visual, flujo complejo): **PIDE AL USUARIO** que verifique antes de cerrar. "Por favor revisa X y Y antes de que marque esto como finalizado".
*   **`testing-patterns`**: Usa patrones de pruebas establecidos para evitar regressions.

**Instrucción de Activación**: Al inicio de cada tarea, revisa si tu enfoque viola alguno de los principios de estos skills. TU OBJETIVO ES CERO REGRESIONES.

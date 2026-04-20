# PDF Generation via Headless Browser — Guía Práctica

> Cómo funciona, qué falló en el camino, y por qué la solución actual es la correcta.

---

## Arquitectura Final

```
POS (Send Email click)
  → POST /admin/draft-orders/[id]/send-email
      1. Backend fetcha template desde DB (pg directo)
      2. Backend serializa posState (documento del carrito)
      3. Lanza Playwright → conecta a Browserless via CDP
      4. Navega a origen de Vercel → inyecta localStorage
      5. Navega a /print/[templateId]?docId=...&auto=0
      6. Espera data-pdf-ready en el DOM
      7. page.pdf() → Buffer → adjunto del email
```

---

## Por qué cada pieza existe

### 1. Browserless como servicio separado en Railway

**Servicio:** `ghcr.io/browserless/chromium:latest`, puerto `8080`

**Conexión:**
```typescript
// CORRECTO — ws:// conecta directamente sin HTTP lookup
playwrightChromium.connectOverCDP("ws://browserless.railway.internal:8080")

// MAL — http:// hace GET /json/version y Browserless responde con
// webSocketDebuggerUrl: "ws://0.0.0.0:8080/" (bind address del container)
// Playwright intenta conectar a 0.0.0.0 → ECONNREFUSED
playwrightChromium.connectOverCDP("http://browserless.railway.internal:8080")
```

**Detección de entorno sin variables de entorno manuales:**
```typescript
const browserlessUrl = process.env.BROWSERLESS_URL ??
  (process.env.RAILWAY_ENVIRONMENT ? "ws://browserless.railway.internal:8080" : null)
```
`RAILWAY_ENVIRONMENT` es auto-inyectada por Railway en todos los containers. No requiere configuración extra.

---

### 2. Pre-fetch del template desde la DB

**Problema:** El hook `useDocumentTemplates` en la print page tiene `enabled: !!token`. El `authStore` de Zustand **nunca persiste `token` en localStorage** por diseño de seguridad — el token vive solo en memoria y se restaura via cookie HttpOnly + `AuthInitializer`. En el navegador headless no hay cookie, así que `token === null` y la query nunca corre.

**Solución:** El backend (que ya tiene acceso a la DB) pre-fetcha el template e inyecta los datos directamente en localStorage con la clave `pdf-template-injection`.

```typescript
// backend/src/api/admin/draft-orders/[id]/send-email/route.ts
async function fetchTemplateForPdf(templateId: string): Promise<Record<string, unknown> | null> {
  const db = new PgClient({ connectionString: process.env.DATABASE_URL, ... })
  try {
    await db.connect()
    const result = await db.query("SELECT * FROM pos_document_template WHERE id = $1", [templateId])
    return result.rows[0] ?? null
  } finally {
    await db.end()
  }
}
```

La inyección ocurre **antes** de navegar a la print URL:
```typescript
await page.goto(originUrl, { waitUntil: "domcontentloaded" })
await page.evaluate(
  ([state, tmpl]) => {
    if (state) localStorage.setItem("pos-documents", state)
    if (tmpl) localStorage.setItem("pdf-template-injection", tmpl)
  },
  [posState, templateData ? JSON.stringify(templateData) : null]
)
await page.goto(printUrl, { waitUntil: "networkidle", timeout: 30000 })
```

> **Por qué dos gotos:** El primer goto al origen establece el contexto de la misma origin para que `localStorage.setItem` sea válido. El segundo goto es la URL real.

---

### 3. La señal `data-pdf-ready`

**Problema:** `waitUntil: "networkidle"` no alcanza. La print page es una SPA React — después de que la red queda en silencio, React sigue procesando state (leer localStorage, resolver template, re-render). El PDF se generaba mostrando el spinner "Preparing print layout...".

**Solución:** La print page escribe un atributo en el DOM cuando está lista, y Playwright espera ese atributo.

```typescript
// store-pos/app/print/[templateId]/page.tsx
useEffect(() => {
  if (doc && template) {
    setReady(true)
    document.body.setAttribute('data-pdf-ready', '1')
  }
}, [doc, template])
```

```typescript
// backend/route.ts — después del goto
await page.waitForSelector('[data-pdf-ready]', { timeout: 20000 })
const pdfBuffer = await page.pdf({ format: "Letter", printBackground: true })
```

---

### 4. La print page lee `pdf-template-injection` como fallback

```typescript
// store-pos/app/print/[templateId]/page.tsx
const [injectedTemplate, setInjectedTemplate] = useState<DocumentTemplate | null>(null)

useEffect(() => {
  try {
    const raw = localStorage.getItem('pdf-template-injection')
    if (raw) setInjectedTemplate(JSON.parse(raw) as DocumentTemplate)
  } catch { /* ignore */ }
}, [])

// Prioridad: inyección headless > API fetch (sesión normal)
const template = injectedTemplate ?? (templates.find(t => t.id === templateId) as DocumentTemplate | undefined)
```

El modo normal (usuario en el browser) sigue funcionando igual: `useDocumentTemplates` tiene token → fetcha la API → `templates` no está vacío → se usa normalmente.

---

## Intentos fallidos y por qué no funcionaron

| Intento | Error | Causa raíz |
|---------|-------|-----------|
| `@sparticuz/chromium` | `libnspr4.so not found` | Compilado para Amazon Linux 2, no Debian de Railway |
| `playwright-core` + install en build phase | Binary no existe en runtime | nixpacks multi-stage: archivos del build no persisten al runtime container |
| `playwright-core` + install en startup | Healthcheck timeout | Descarga 112MB al arrancar, Railway mata el container antes |
| `aptPkgs = ["chromium"]` | Binary no encontrado | Binario en ruta inesperada en la imagen base |
| Browserless via `http://` en puerto 3000 | ECONNREFUSED | Browserless escucha en 8080, no 3000 |
| Browserless via `http://` en puerto 8080 | ws://0.0.0.0:8080 ECONNREFUSED | HTTP lookup retorna bind address del container |
| Inyectar token en `pos-auth` localStorage | `data-pdf-ready` timeout | `authStore` no lee `token` desde localStorage (diseño intencional) |
| Ruta `/admin/draft-orders/:id/pdf-link` sin `bodyParser` override (2026-04-20) | `PayloadTooLargeError: request entity too large` | Default de express body-parser (100 KB) insuficiente para `posState` con `attachedImage` base64. Fix: `sizeLimit: "2mb"` en `src/api/middlewares.ts` |

---

## Variables de entorno relevantes

| Variable | Dónde | Propósito |
|----------|-------|-----------|
| `RAILWAY_ENVIRONMENT` | Auto-inyectada por Railway | Detectar entorno Railway sin config extra |
| `BROWSERLESS_URL` | Opcional, Railway env | Override manual del endpoint de Browserless |
| `DATABASE_URL` | backend `.env` / Railway | Conexión pg para pre-fetch de template |
| `POS_URL` | Opcional, Railway env | URL base del POS frontend (default: detectada por headers) |

---

## Checklist si vuelve a fallar

1. **ECONNREFUSED en Browserless** → verificar que el servicio Browserless esté running en Railway y que la URL use `ws://` no `http://`
2. **`data-pdf-ready` timeout** → el template no se inyectó. Verificar que `fetchTemplateForPdf` retorna datos (revisar que el `templateId` existe en `pos_document_template`)
3. **PDF blank o spinner** → `networkidle` se cumplió pero `data-pdf-ready` no apareció → revisar que el frontend de Vercel tiene el código actualizado
4. **PDF con datos incorrectos** → verificar que `posState` viene en el body del request y que tiene el formato correcto de `pos-documents`
5. **`PayloadTooLargeError: request entity too large` en `POST /admin/draft-orders/:id/pdf-link`** (2026-04-20) → el body supera el límite del body-parser. Verificar que el matcher para `pdf-link` existe en `src/api/middlewares.ts` con `sizeLimit: "2mb"`. Si aparece a pesar del override, hay imágenes `attachedImage` base64 anómalamente grandes (deberían ser ~3 KB post-`cropAndCompress` en 96×96) o `draftCache` acumuló demasiadas órdenes abiertas.

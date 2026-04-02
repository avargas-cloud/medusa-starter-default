# POS Document Template System
> **Tipo**: Technical Reference
> **Repo**: backend
> **Última verificación**: 2026-04-02
> **Estado**: ✅ Current

---

## ¿Qué es y por qué existe?

El Template System es el motor de generación de PDF/print para Estimates, Sales Orders e Invoices del POS. Es un wizard de 3 pasos: Fields → Layout Designer → Preview. Los templates se almacenan en la tabla `pos_document_template` y son configurables por tipo de documento.

---

## Arquitectura

```
store-pos/app/(pos)/templates/
    ├── page.tsx                       ← Galería — lista todos los templates por tipo
    ├── [id]/edit/page.tsx             ← Paso 1: Campos & toggles
    ├── [id]/design/page.tsx           ← Paso 2: Layout drag-and-drop
    └── [id]/preview/page.tsx          ← Paso 3: Preview con datos reales

Backend:
    └── backend/src/api/admin/document-templates/  ← CRUD API (pg Client directo)
    └── backend/src/modules/document-templates/    ← Módulo Medusa con servicio
```

### Flujo del Wizard

```
Paso 1 — Fields (/templates/[id]/edit)
    Configura qué campos mostrar (logo, addresses, notes, etc.)
    → Guarda en field_config (JSON)

Paso 2 — Layout Designer (/templates/[id]/design)
    Drag-and-drop visual de bloques en un canvas de papel
    → Guarda en layout_data (LayoutBlock[]) + layout_guides (Guide[])

Paso 3 — Preview (/templates/[id]/preview)
    Renderiza el template con datos reales de la BD
    → Print / PDF download
```

---

## Modelo de Datos / Estructura

### Tabla `pos_document_template`

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `id` | TEXT | Primary key (custom ID generator — no UUID estándar) |
| `name` | TEXT | Nombre del template (ej. "Invoice Ecopowertech") |
| `doc_type` | ENUM | `estimate` \| `order` \| `invoice` \| `return` \| `statement` \| `payment` |
| `is_default` | BOOLEAN | Si es el template por defecto para su `doc_type` |
| `thumbnail` | TEXT | Base64 o URL MinIO de la vista previa |
| `field_config` | JSONB | Objeto FieldConfig — resultado del Paso 1 |
| `layout_data` | JSONB | Array LayoutElement[] — resultado del Paso 2 |
| `layout_guides` | JSONB | Guías de alineación — resultado del Paso 2 |
| `created_by` | TEXT | Usuario que lo creó (nullable) |
| `created_at` | TIMESTAMPTZ | Timestamp de creación |
| `updated_at` | TIMESTAMPTZ | Timestamp de última edición |

### `DocumentTemplate` Interface (Frontend)

```typescript
export interface DocumentTemplate {
    id:            string
    name:          string
    doc_type:      'estimate' | 'order' | 'invoice' | 'return' | 'statement' | 'payment'
    is_default:    boolean
    thumbnail:     string | null
    field_config:  Record<string, any>   // ← Paso 1 output
    layout_data:   any[]                 // ← Paso 2 output (LayoutBlock[])
    layout_guides: any[]                 // ← Paso 2 output (Guide[])
    created_by:    string | null
    created_at:    string
    updated_at:    string
}
```

### Regla de `is_default`

Solo puede haber un default por `doc_type`. Al hacer set-default o crear/actualizar con `is_default: true`, el endpoint limpia los otros defaults del mismo `doc_type` antes de activar el nuevo.

---

## API / Interfaces

### Endpoints Backend

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET` | `/admin/document-templates` | Lista todos (filtrable con `?doc_type=estimate`) |
| `GET` | `/admin/document-templates/:id` | Template individual |
| `POST` | `/admin/document-templates` | Crear nuevo template |
| `PATCH` | `/admin/document-templates/:id` | Actualizar (name, field_config, layout_data, thumbnail, is_default) |
| `DELETE` | `/admin/document-templates/:id` | Eliminar |
| `POST` | `/admin/document-templates/:id/duplicate` | Duplicar (copia como "{nombre} (Copy)", is_default: false) |
| `POST` | `/admin/document-templates/:id/set-default` | Marcar como default para su doc_type |

### `POST /admin/document-templates` — Payload

```typescript
{
    name: string,
    doc_type: 'estimate' | 'order' | 'invoice' | 'return' | 'statement' | 'payment',
    field_config?: Record<string, any>,
    layout_data?: any[],
    is_default?: boolean,
    thumbnail?: string,
    created_by?: string
}
```

### Hook Frontend: `useDocumentTemplates`

```typescript
const {
    templates,           // DocumentTemplate[]
    loading, error,
    reload,
    createTemplate,      // (body) => Promise<DocumentTemplate>
    updateTemplate,      // (id, Partial<DocumentTemplate>) => Promise<DocumentTemplate>
    deleteTemplate,      // (id) => Promise<void>
    duplicateTemplate,   // (id) => Promise<DocumentTemplate>
    setDefault,          // (id) => Promise<void>
} = useDocumentTemplates(doc_type?)  // filtro opcional por tipo
```

### Componente: `TemplatePicker`

Widget reutilizable `components/pos/TemplatePicker.tsx` — permite seleccionar un template para aplicar a un Estimate/Order desde la página de detalle.

---

## Módulo Backend

```typescript
// backend/src/modules/document-templates/index.ts
export const DOCUMENT_TEMPLATE_MODULE = 'document_templates'

export default Module(DOCUMENT_TEMPLATE_MODULE, {
    service: DocumentTemplateModuleService,
})
```

> **Nota de implementación:** La API usa `pg Client` directo (no el ORM de Medusa) para operaciones CRUD. El módulo existe para registrar el servicio en el container de DI pero las rutas no lo usan directamente — acceden a la BD via `new Client({ connectionString: process.env.DATABASE_URL })`.

---

## Archivos Clave del Template System

| Tipo | Ruta Completa | Propósito |
|------|---------------|-----------|
| API | `backend/src/api/admin/document-templates/route.ts` | GET lista + POST crear |
| API | `backend/src/api/admin/document-templates/[id]/route.ts` | GET + PATCH + DELETE |
| API | `backend/src/api/admin/document-templates/[id]/set-default/route.ts` | POST set-default |
| API | `backend/src/api/admin/document-templates/[id]/duplicate/route.ts` | POST duplicar |
| Módulo | `backend/src/modules/document-templates/models/pos-document-template.ts` | Modelo de datos |
| Módulo | `backend/src/modules/document-templates/service.ts` | Servicio del módulo |
| Módulo | `backend/src/modules/document-templates/generate-id.ts` | Generador de IDs custom |
| POS | `store-pos/app/(pos)/templates/page.tsx` | Galería de templates |
| POS | `store-pos/app/(pos)/templates/[id]/edit/page.tsx` | Paso 1 — Fields |
| POS | `store-pos/app/(pos)/templates/[id]/design/page.tsx` | Paso 2 — Layout |
| POS | `store-pos/app/(pos)/templates/[id]/preview/page.tsx` | Paso 3 — Preview |
| Hook | `store-pos/hooks/useDocumentTemplates.ts` | CRUD hook |
| Comp | `store-pos/components/pos/TemplatePicker.tsx` | Selector en Estimates/Orders |

---

## Reglas Críticas

- Solo un template puede ser `is_default: true` por `doc_type` — el backend lo enforce automáticamente
- La tabla `pos_document_template` debe existir en la BD; se crea vía migration del módulo
- El SSL en la conexión pg usa `rejectUnauthorized: false` para Railway — si la URL contiene 'railway' o 'ssl'
- Los `doc_type` válidos son: `estimate`, `order`, `invoice`, `return`, `statement`, `payment` — fuera de esta lista retorna 400

---

## Historial de Decisiones

- **`pg Client` directo en rutas** (2026-03): El ORM de Medusa tenía problemas de serialización con los campos JSONB grandes (`layout_data`). El `pg Client` directo con `JSON.stringify()` explícito resuelve esto.
- **ID custom en `generate-id.ts`**: En lugar de UUIDs estándar, se usa un generador propio para IDs de templates (mantiene compatibilidad con el sistema anterior).
- **`doc_type` extendido a 6 tipos**: El modelo original solo tenía `estimate | order | invoice`. Se agregaron `return`, `statement`, `payment` para cubrir todos los documentos del POS.

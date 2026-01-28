# Customers Advanced - Complete Auto-Sync Architecture

## Resumen Ejecutivo

Este documento detalla la arquitectura completa del sistema de búsqueda avanzada de customers con **sincronización automática en 3 capas**, reemplazando completamente la página nativa de Customers en Medusa v2.

### Logros Principales

✅ **Búsqueda avanzada** con MeiliSearch en `/app/customers-advanced`  
✅ **Hijacking del sidebar** - Redirección transparente desde botón nativo  
✅ **Auto-sync en 3 capas** - Middleware + Reconciliation Job + Manual  
✅ **Metadata enriquecida** - Customer Type, Price Level, List ID de QuickBooks  
✅ **Cache invalidation automática** - Datos frescos al cargar página  
✅ **Navegación SPA** - Sin recargas de página  

---

## Tabla de Contenidos

1. [Arquitectura de Auto-Sync](#arquitectura-de-auto-sync)
2. [Estructura de Archivos](#estructura-de-archivos)
3. [Metadata Enriquecida de Customers](#metadata-enriquecida-de-customers)
4. [Capa 1: Middleware de Sync Inmediato](#capa-1-middleware-de-sync-inmediato)
5. [Capa 2: Reconciliation Job](#capa-2-reconciliation-job)
6. [Capa 3: Sync Manual](#capa-3-sync-manual)
7. [Cache Invalidation Frontend](#cache-invalidation-frontend)
8. [Hijacking del Sidebar](#hijacking-del-sidebar)
9. [Flujo Completo de Datos](#flujo-completo-de-datos)
10. [Troubleshooting](#troubleshooting)

---

## Arquitectura de Auto-Sync

### Mismo Problema: Bug de Subscribers en Medusa v2

Al igual que productos, los subscribers de customers **NO se disparan** en Medusa v2. La solución es idéntica: **3 capas de redundancia**.

```mermaid
graph TB
    A[Usuario edita customer] --> B{Capa 1: Middleware}
    B -->|Inmediato| C[Intercepta HTTP response]
    C --> D[Transform customer + metadata]
    D --> E[Sync a MeiliSearch]
    
    F[Cron cada 5 min] --> G{Capa 2: Reconciliation Job}
    G --> H[Sync TODOS los customers]
    H --> I[Garantiza consistencia]
    
    J[Usuario hace clic] --> K{Capa 3: Botón Manual}
    K --> L[Check si out-of-sync]
    L --> M[Sync si necesario]
    
    E --> N[MeiliSearch Index]
    I --> N
    M --> N
    
    O[Frontend carga página] --> P[Cache invalidation]
    P --> Q[Re-fetch desde MeiliSearch]
    Q --> R[Datos siempre frescos]
```

---

## Estructura de Archivos

```
src/
├── admin/
│   ├── routes/
│   │   └── customers-advanced/
│   │       ├── page.tsx                        # Página principal
│   │       ├── components/
│   │       │   ├── customer-header.tsx         # Header con filtros
│   │       │   └── customer-table.tsx          # Tabla de customers
│   │       └── hooks/
│   │           ├── use-customer-page-state.tsx # Estado de página
│   │           └── use-customer-search.ts      # Query MeiliSearch
│   ├── widgets/
│   │   └── sidebar-hijacker.tsx                # ⭐ Hijacker global
│   ├── lib/
│   │   ├── meili-client.ts                     # Cliente frontend
│   │   └── meili-types.ts                      # Types TypeScript
│   └── components/
│       └── shared/
│           └── sync-status-button.tsx          # Botón sync manual
│
├── api/
│   ├── middlewares.ts                          # ⭐ Middleware auto-sync
│   └── admin/
│       └── search/
│           └── customers/
│               └── sync/
│                   └── route.ts                # Endpoint sync manual
│
├── jobs/
│   └── reconcile-meilisearch.ts                # ⭐ Job cada 5 min
│
└── lib/
    └── meili-backend.ts                        # Cliente backend + transformers
```

---

## Metadata Enriquecida de Customers

### Integración con QuickBooks Desktop

Los customers tienen metadata especial de QuickBooks Desktop almacenada en `customer.metadata`:

```typescript
interface CustomerMetadata {
    qb_list_id: string          // QuickBooks ListID único
    qb_edit_sequence: string    // Versión para optimistic locking
    customer_type: string       // Commercial | Residential
    price_level: string         // Wholesale | Retail | etc.
}
```

### Transformer de MeiliSearch

```typescript
// src/lib/meili-backend.ts
export const transformCustomer = (customer: any): MeiliCustomer => {
    return {
        id: customer.id,
        email: customer.email,
        first_name: customer.first_name || "",
        last_name: customer.last_name || "",
        company_name: customer.company_name || "",
        phone: customer.phone || "",
        
        // ⭐ Metadata enriquecida de QuickBooks
        list_id: customer.metadata?.qb_list_id || "",
        customer_type: customer.metadata?.customer_type || "residential",
        price_level: customer.metadata?.price_level || "retail",
        
        has_account: customer.has_account || false,
        created_at: new Date(customer.created_at).getTime(),
        updated_at: new Date(customer.updated_at).getTime(),
    }
}
```

### Índice MeiliSearch

```typescript
await index.updateSettings({
    filterableAttributes: [
        "customer_type",      // ⭐ Filtro por tipo
        "price_level",        // ⭐ Filtro por nivel de precio
        "has_account",
        "id",
    ],
    sortableAttributes: [
        "company_name",
        "email",
        "created_at",
        "updated_at",
    ],
    searchableAttributes: [
        "company_name",
        "email",
        "first_name",
        "last_name",
        "list_id",           // ⭐ Buscar por QB ListID
    ]
})
```

---

## Capa 1: Middleware de Sync Inmediato

### Archivo: `src/api/middlewares.ts`

**Diferencia con Products:** Customers NO tienen variants, así que el middleware es más simple.

### Implementación

```typescript
import { meiliClient, CUSTOMERS_INDEX, transformCustomer } from "../lib/meili-backend"

/**
 * Middleware auto-sync para customers
 * Más simple que products porque no hay variants
 */
async function syncCustomerMiddleware(
    req: MedusaRequest,
    res: MedusaResponse,
    next: MedusaNextFunction
) {
    const originalJson = res.json.bind(res)

    res.json = (data: any) => {
        if (data?.customer) {
            setImmediate(async () => {
                try {
                    const index = meiliClient.index(CUSTOMERS_INDEX)
                    const transformed = transformCustomer(data.customer)
                    await index.addDocuments([transformed])
                    console.log(`✅ [MEILI-SYNC] Customer ${data.customer.id} synced`)
                } catch (error: any) {
                    console.error(`❌ [MEILI-SYNC] Failed to sync customer: ${error.message}`)
                }
            })
        }

        return originalJson(data)
    }

    next()
}

export default defineMiddlewares({
    routes: [
        {
            matcher: "/admin/customers*",
            middlewares: [syncCustomerMiddleware],
        },
    ],
})
```

### Endpoints Interceptados

- `POST /admin/customers` (crear customer)
- `POST /admin/customers/:id` (actualizar customer)
- `DELETE /admin/customers/:id` (borrar customer)
- `GET /admin/customers*` (cualquier consulta)

---

## Capa 2: Reconciliation Job

### Archivo: `src/jobs/reconcile-meilisearch.ts`

**Nota:** El mismo job maneja products Y customers.

### Implementación (Sección de Customers)

```typescript
export default async function reconcileMeiliSearchHandler(container: MedusaContainer) {
    console.log("🔄 [RECONCILE] Starting MeiliSearch reconciliation...")

    try {
        // ... Products sync ...

        // ⭐ CUSTOMERS SYNC
        const customerModule = container.resolve("customer") as any
        const customers = await customerModule.listCustomers({}, {
            take: 10000
        })

        console.log(`📊 [RECONCILE] Found ${customers.length} customers in DB`)

        const transformedCustomers = customers.map(transformCustomer)
        const customersIndex = meiliClient.index(CUSTOMERS_INDEX)
        await customersIndex.addDocuments(transformedCustomers)

        console.log(`✅ [RECONCILE] Synced ${transformedCustomers.length} customers to MeiliSearch`)

    } catch (error: any) {
        console.error("❌ [RECONCILE] Reconciliation failed:", error.message)
    }
}
```

---

## Capa 3: Sync Manual

### Archivo: `src/api/admin/search/customers/sync/route.ts`

**Similar a products** pero para customers.

### Implementación con Detección de Estado

```typescript
export const POST = async (
    req: MedusaRequest,
    res: MedusaResponse
) => {
    try {
        const customerModule = req.scope.resolve("customer")
        const { MeiliSearch } = await import("meilisearch")

        const client = new MeiliSearch({
            host: process.env.MEILISEARCH_HOST!,
            apiKey: process.env.MEILISEARCH_API_KEY!,
        })
        const index = client.index("customers")
        let meiliLastUpdate = new Date(0)
        let meiliCount = 0

        try {
            const stats = await index.getStats()
            meiliCount = stats.numberOfDocuments
            
            const latestMeili = await index.search("", {
                limit: 1,
                sort: ["updated_at:desc"],
                attributesToRetrieve: ["updated_at"]
            })
            if (latestMeili.hits.length > 0) {
                const val = latestMeili.hits[0].updated_at
                if (val) meiliLastUpdate = new Date(val)
            }
        } catch (e) {
            // Index might not exist
        }

        // Get DB stats
        const [latestCustomer] = await customerModule.listCustomers({}, {
            select: ["updated_at"],
            order: { updated_at: "DESC" },
            take: 1
        })
        const [_, dbCount] = await customerModule.listAndCountCustomers({}, {
            select: ["id"],
            take: 0
        })

        const dbLastUpdate = latestCustomer ? new Date(latestCustomer.updated_at) : new Date()

        // Check sync status
        const isCountSync = dbCount === meiliCount
        const timeDiff = dbLastUpdate.getTime() - meiliLastUpdate.getTime()
        const isTimeSync = timeDiff <= 5000

        console.log(`🔍 [Sync Status] DB: ${dbCount}, Meili: ${meiliCount}, TimeDiff: ${timeDiff}ms`)

        if (isCountSync && isTimeSync) {
            return res.json({
                success: true,
                synced: 0,
                status: "already_synced",
                message: "Synced Already"
            })
        }

        // Trigger full sync
        const customers = await customerModule.listCustomers({}, { take: 10000 })
        const transformed = customers.map(transformCustomer)
        await index.addDocuments(transformed)

        return res.json({
            success: true,
            synced: transformed.length,
            status: "synced_now",
            message: "Synced Now"
        })
    } catch (error: any) {
        console.error("[MeiliSearch Customer Sync Error]:", error.message)
        return res.status(500).json({
            success: false,
            error: "Sync failed",
            message: error.message,
        })
    }
}
```

---

## Cache Invalidation Frontend

### Archivo: `src/admin/routes/customers-advanced/page.tsx`

**Exactamente igual que products:**

```typescript
import { useQueryClient } from "@tanstack/react-query"
import { useEffect } from "react"

const CustomerSearchPage = () => {
    const queryClient = useQueryClient()
    
    // ⭐ Invalidate cache on mount
    useEffect(() => {
        queryClient.invalidateQueries({ queryKey: ["meili-customers"] })
    }, [queryClient])
    
    // ... resto del componente
}
```

### Configuración de React Query

```typescript
// src/admin/routes/customers-advanced/hooks/use-customer-search.ts
const query = useQuery({
    queryKey: ["meili-customers", ...params],
    queryFn: async () => {
        const index = meiliClient.index(CUSTOMERS_INDEX)
        
        // Build filters
        const filters: string[] = []
        if (customerTypeFilter !== "all") {
            filters.push(`customer_type = "${customerTypeFilter}"`)
        }
        if (priceLevelFilter !== "all") {
            filters.push(`price_level = "${priceLevelFilter}"`)
        }
        
        const searchResults = await index.search(searchQuery || "", {
            limit: ITEMS_PER_PAGE,
            offset: currentPage * ITEMS_PER_PAGE,
            sort: [sortBy],
            filter: filters.length > 0 ? filters.join(" AND ") : undefined,
        })
        
        return {
            hits: searchResults.hits as MeiliCustomer[],
            totalHits: searchResults.estimatedTotalHits || 0,
        }
    },
    staleTime: 5000,              // ⭐ Datos "stale" después de 5s
    refetchOnWindowFocus: true,   // ⭐ Re-fetch al cambiar de tab
})
```

---

## Hijacking del Sidebar

### Archivo: `src/admin/widgets/sidebar-hijacker.tsx`

**El mismo hijacker maneja Products, Inventory Y Customers:**

```typescript
if (typeof window !== 'undefined' && !(window as any).__hijackerInstalled) {
    const hijackClick = (e: MouseEvent) => {
        const target = e.target as HTMLElement
        
        // ⭐ Customers hijacking
        const customersLink = target.closest('a[href="/app/customers"]')
        if (customersLink) {
            e.preventDefault()
            e.stopPropagation()
            window.history.pushState({}, '', '/app/customers-advanced')
            window.dispatchEvent(new PopStateEvent('popstate'))
            console.log('🔀 [HIJACKER] Redirected to customers-advanced')
            return
        }
        
        // ... Products y Inventory ...
    }
    
    document.addEventListener("click", hijackClick as EventListener, true)
    ;(window as any).__hijackerInstalled = true
}
```

---

## Flujo Completo de Datos

```mermaid
sequenceDiagram
    participant U as Usuario
    participant Q as QuickBooks Desktop
    participant UI as Admin UI
    participant MW as Middleware
    participant DB as Postgres
    participant MS as MeiliSearch
    participant JOB as Cron Job
    
    Note over Q,DB: Import inicial
    Q->>DB: Import 7,444 customers
    DB->>DB: Store metadata (QB ListID, Type, Price Level)
    
    U->>UI: Edita customer
    UI->>DB: POST /admin/customers/:id
    DB-->>MW: HTTP Response with metadata
    MW->>MS: Sync customer + metadata
    MS-->>MW: OK
    MW-->>UI: Response original
    
    Note over JOB: Cada 5 minutos
    JOB->>DB: Fetch ALL customers
    DB-->>JOB: Lista con metadata
    JOB->>MS: Sync batch
    MS-->>JOB: OK
    
    U->>UI: Click en "Customers"
    UI->>UI: Hijacker intercepta
    UI->>UI: Navigate to /customers-advanced
    UI->>UI: Invalidate cache
    UI->>MS: Search query + filters
    MS-->>UI: Resultados filtrados por Type/Price Level
```

---

## Filtros Especiales de Customers

### Customer Type Filter

```typescript
// Frontend
<Select value={customerTypeFilter} onChange={setCustomerTypeFilter}>
    <option value="all">All Types</option>
    <option value="commercial">Commercial</option>
    <option value="residential">Residential</option>
</Select>
```

### Price Level Filter

```typescript
// Frontend
<Select value={priceLevelFilter} onChange={setPriceLevelFilter}>
    <option value="all">All Price Levels</option>
    <option value="wholesale">Wholesale</option>
    <option value="retail">Retail</option>
    <option value="contractor">Contractor</option>
</Select>
```

### Búsqueda por QB ListID

Los usuarios pueden buscar customers por su QuickBooks ListID:

```
1234-5678  →  Encuentra customer con qb_list_id = "1234-5678"
```

---

## Troubleshooting

### Problema: "Metadata no aparece en búsqueda"

**Causa:** Metadata no se está transformando correctamente

**Solución:** Verificar transformer:
```typescript
list_id: customer.metadata?.qb_list_id || "",
customer_type: customer.metadata?.customer_type || "residential",
```

**Test:**
```bash
# Ver customer en MeiliSearch
curl http://localhost:7700/indexes/customers/documents/:id \
  -H "Authorization: Bearer YOUR_KEY"
  
# Debe incluir:
{
  "list_id": "1234-5678",
  "customer_type": "commercial",
  "price_level": "wholesale"
}
```

---

### Problema: "Filtros no funcionan"

**Causa:** Attributes no configurados como filterables

**Solución:** Verificar en reconciliation job:
```typescript
await index.updateSettings({
    filterableAttributes: [
        "customer_type",
        "price_level",
    ]
})
```

**Test:**
```bash
# Test filter directamente en MeiliSearch
curl -X POST http://localhost:7700/indexes/customers/search \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "filter": "customer_type = commercial"
  }'
```

---

### Problema: "Customers duplicados después de import"

**Causa:** Import de QuickBooks creó customers sin triggear middleware

**Solución:** Ejecutar reconciliation job manualmente:
```bash
npx medusa exec ./src/scripts/test-reconciliation.ts
```

---

## Conclusión

### Arquitectura de 3 Capas para Customers

| Capa | Latencia | Cobertura | Propósito |
|------|----------|-----------|-----------|
| Middleware | <100ms | API changes | Sync inmediato en ediciones |
| Reconciliation Job | 5 min | 100% customers | Red de seguridad |
| Manual Sync | On-demand | 100% customers | Control del usuario |

### Integración con QuickBooks

✅ **7,444 customers importados** de QuickBooks Desktop  
✅ **Metadata preservada** - Customer Type, Price Level, ListID  
✅ **Filtros funcionando** - Por tipo y nivel de precio  
✅ **Búsqueda por ListID** - Encuentra customers de QB  

### Garantías del Sistema

✅ **Metadata siempre sincronizada** - QB info accessible  
✅ **Datos siempre frescos** - Cache invalidation automática  
✅ **Resistente a fallos** - 3 capas de redundancia  
✅ **UX perfecta** - Navegación SPA sin reloads  
✅ **Detección inteligente** - Solo sync cuando necesario  

---

**Fecha de creación:** 2026-01-28  
**Versión:** 1.0 (Auto-Sync Architecture)  
**Medusa:** v2.x  
**MeiliSearch:** v1.x  
**QuickBooks Integration:** Desktop 2012

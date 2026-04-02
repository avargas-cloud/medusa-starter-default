# Deploy — Worker Mode
> **Tipo**: Technical Reference
> **Repo**: backend
> **Ultima verificacion**: 2026-04-02
> **Estado**: Current

---

## Que es y por que existe

`workerMode` en `medusa-config.ts` controla si el proceso Node.js maneja HTTP, jobs/workflows/subscribers, o ambos. En Railway, EcoPowerTech usa `"shared"` (un solo proceso), que es el default si `WORKER_MODE` no esta seteado.

---

## Valores de workerMode

```typescript
workerMode: (process.env.WORKER_MODE || "shared") as "shared" | "worker" | "server"
```

| Valor | Que hace |
|-------|----------|
| `"shared"` | HTTP requests + jobs schedulados + subscribers + workflows (todo en uno) |
| `"server"` | Solo HTTP requests. Necesita un proceso worker separado |
| `"worker"` | Solo jobs, subscribers y workflows. Sin servidor HTTP |

**Configuracion actual:** `WORKER_MODE=shared` en Railway.

---

## Por que el Worker es Critico

El backend de EcoPowerTech tiene tres capas de sync:

```
Capa 1: Subscribers HTTP (inmediato)
  ↓ se disparan tras cada request HTTP
Capa 2: Scheduled Jobs — reconciliation cada 5 minutos
  ↓ SOLO corren si el proceso maneja jobs (workerMode=shared o workerMode=worker)
Capa 3: Sync manual — boton en Admin Panel
```

**Sin jobs schedulados (workerMode=server sin worker separado):**

| Funcion | Middleware | Jobs |
|---------|-----------|------|
| Sync inmediato tras edits via HTTP | Si | No |
| Scheduled Jobs (reconciliation) | No | Si — REQUIERE |
| Workflows (inventory sync) | No | Si — REQUIERE |
| Catch missed syncs (DB directo, migraciones) | No | Si — REQUIERE |

### Jobs schedulados activos

```typescript
// src/jobs/reconcile-meilisearch.ts
schedule: "*/5 * * * *"  // Cada 5 minutos

// src/jobs/reconcile-inventory.ts
schedule: "*/5 * * * *"  // Cada 5 minutos
```

Estos solo corren si el proceso tiene `workerMode: "shared"` o `workerMode: "worker"`.

### Workflows

`createWorkflow()` y `syncInventoryWorkflow()` requieren el workflow engine, que solo corre en el proceso worker.

---

## Verificacion en medusa-config.ts

```typescript
// CRITICO: Enable subscribers configurando workerMode
// Sin esto, subscribers NO cargan (aunque el codigo sea correcto)
workerMode: (process.env.WORKER_MODE || "shared") as "shared" | "worker" | "server",
```

**En Railway:**
- Inicio del log debe mostrar: `WORKER_MODE: shared` (o el valor seteado)
- Si no aparece: verificar la variable en Railway Variables

---

## Cuando Cambiar a server + worker

Si la carga HTTP es alta y los jobs consumen demasiado CPU en el mismo proceso, separar en dos servicios Railway:

```
Servicio 1: medusa-starter-default  → WORKER_MODE=server  (HTTP only)
Servicio 2: medusa-worker           → WORKER_MODE=worker  (jobs only)
```

Ambos comparten las mismas variables de entorno (DATABASE_URL, REDIS_URL).

**Costo:** 2 servicios Railway en lugar de 1.
**Beneficio:** Aislamiento de recursos, mas estable bajo carga.

**Condicion para separar:** Solo si hay problemas de performance o timeout en HTTP requests causados por jobs pesados corriendo en el mismo proceso.

---

## Archivos Clave

| Tipo | Ruta Completa | Proposito |
|------|---------------|-----------|
| Config | `/home/alejo/webapps/ecopowertech-workspace/backend/medusa-config.ts` | `workerMode` configurado (linea ~40) |
| Jobs | `/home/alejo/webapps/ecopowertech-workspace/backend/src/jobs/` | Todos los scheduled jobs |
| Subscribers | `/home/alejo/webapps/ecopowertech-workspace/backend/src/subscribers/` | Event subscribers |

---

## Historial de Decisiones

- **workerMode: "shared" en lugar de dos servicios**: Reduce el costo de Railway (un servicio en lugar de dos). El proceso compartido es suficiente para la carga actual.
- **Default "shared" si WORKER_MODE no esta seteado**: Garantia de que los subscribers cargan siempre. Si alguien elimina la variable de Railway, el sistema no se rompe.
- **WORKER_MODE como variable de entorno**: Permite cambiar el modo sin redesplegar el codigo — solo cambiando la variable en Railway.

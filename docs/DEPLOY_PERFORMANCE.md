# Deploy — Performance
> **Tipo**: Technical Reference
> **Repo**: backend
> **Ultima verificacion**: 2026-04-02
> **Estado**: Current

---

## Que es y por que existe

Documenta la configuracion de performance del backend de EcoPowerTech en Railway: connection pool de PostgreSQL, keepAlive de Redis, cache de Redis para endpoints lentos, e indices de PostgreSQL. Incluye el diagnostico del problema de startup lento (resuelto) y su solucion.

---

## Tiempos de Startup

| Entorno | Startup actual | Estado |
|---------|---------------|--------|
| Local (DB local) | ~2.4s | Normal |
| Local conectado a Railway DB | ~4.4s | Normal (latencia de red) |
| Ubuntu nativo (con DNS fix) | ~13s | Normal |
| Cualquier | >30s | Investigar |

---

## Configuracion de PostgreSQL (medusa-config.ts)

```typescript
databaseDriverOptions: {
  connection: {
    ssl: { rejectUnauthorized: false }  // Railway usa SSL con cert auto-firmado
  },
  pool: {
    min: 0,              // CRITICO: no mantener conexiones idle
    max: 10,
    idleTimeoutMillis: 20000,   // cerrar conexiones antes de que Railway las cierre (~20-30s)
    acquireTimeoutMillis: 30000,
  }
}
```

### Por que `pool.min = 0`

El proxy de Railway cierra conexiones TCP idle despues de ~20-30 segundos. Con `min > 0`, Knex mantiene conexiones idle que el proxy cierra, causando errores `"Connection ended unexpectedly"`. Con `min: 0`, no hay conexiones idle y no hay drops.

---

## Configuracion de Redis (medusa-config.ts)

Redis se usa en 4 modulos de Medusa. Todos tienen la misma configuracion:

```typescript
redisOptions: {
  connectTimeout: 45000,
  keepAlive: 10000,       // TCP keepalive — previene que Railway proxy cierre el socket idle
  pingInterval: 20000,    // PING explicito cada 20s para mantener el proxy vivo
  enableOfflineQueue: true,
  family: 4,              // IPv4 only
  retryStrategy: (times: number) => Math.min(times * 3000, 30000),
}
```

### Modulos con Redis

| Modulo | Proposito |
|--------|-----------|
| `@medusajs/medusa/event-bus-redis` | Event bus (subscribers) |
| `@medusajs/medusa/workflow-engine-redis` | Workflow execution |
| `@medusajs/medusa/cache-redis` | Application cache |
| `@medusajs/medusa/locking` + `locking-redis` | Distributed locks |

### Por que pingInterval: 20000

El proxy de Railway cierra conexiones idle. El `keepAlive: 10000` es TCP-level keepalive. El `pingInterval: 20000` es un PING Redis explicito que mantiene el proxy vivo incluso si no hay actividad de aplicacion.

---

## Cache de Aplicacion

### CacheManager

`src/lib/cache-manager.ts` — wrapper type-safe sobre el cache service de Medusa (Redis-backed):

```typescript
export class CacheManager {
  async get<T>(key: string): Promise<T | null>
  async set<T>(key: string, value: T, ttl: number): Promise<void>
  async del(key: string): Promise<void>
}
```

**Uso en endpoints:**

```typescript
const cacheKey = `category:${id}:products-filters:${limit}:${offset}`
const cacheService = req.scope.resolve("cache")
const cacheManager = getCacheManager(cacheService)

const cached = await cacheManager.get<ResponseType>(cacheKey)
if (cached) {
    res.setHeader("X-Cache", "HIT")  // ~200ms
    return res.json(cached)
}

// Cache miss → fetch DB (~3-7s)
res.setHeader("X-Cache", "MISS")
const data = await fetchFromDatabase(...)
await cacheManager.set(cacheKey, data, 300)  // TTL 5 minutos
```

### Cache Keys

```
category:{id}:products-filters:{limit}:{offset}
```

TTL: 300 segundos (5 minutos).

### Performance lograda (endpoint de productos por categoria)

| Escenario | Antes | Despues |
|-----------|-------|---------|
| SSG page load | 25-30s | <500ms |
| Cache HIT | 25-30s | ~200ms |
| Cache MISS | 25-30s | ~7s |

### Invalidacion manual de cache

```bash
# Limpiar categoria especifica
redis-cli DEL "category:cat_123:products-filters:20:0"

# Limpiar todas las categorias
redis-cli --scan --pattern "category:*" | xargs redis-cli DEL
```

---

## Indices de PostgreSQL

Creados con `CONCURRENTLY` para no bloquear produccion:

| Indice | Tabla | Columna |
|--------|-------|---------|
| `idx_product_category_product_category_lookup` | `product_category_product` | `product_category_id` |
| `idx_product_category_product_product_lookup` | `product_category_product` | `product_id` |
| `idx_product_category_parent_lookup` | `product_category` | `parent_category_id` |
| `idx_product_variant_product_lookup` | `product_variant` | `product_id` |
| `idx_inventory_level_inventory_lookup` | `inventory_level` | `inventory_item_id` |

### Crear indices

```bash
# Preferir script directo sobre migration ORM (mas confiable en Medusa v2)
npx tsx src/scripts/create-performance-indexes.ts

# Verificar que esten creados
npx tsx src/scripts/verify/verify-performance-indexes.ts
```

---

## Diagnostico de Startup Lento

### El problema del hang de 60s (resuelto, historico)

El hang de 60s fue causado por lógica condicional en la config del admin que interferia con la inicializacion:

```typescript
// NUNCA agregar esto — causa hang de 60s:
admin: {
  disable: process.env.ENABLE_ADMIN !== "true"
}

// Correcto (sin condicionales):
admin: {
  backendUrl: process.env.NODE_ENV === "production"
    ? "https://medusa-starter-default-production-b69e.up.railway.app"
    : "http://localhost:9000",
}
```

### Problema DNS en Ubuntu nativo (resuelto, Feb 2026)

En Ubuntu nativo (no WSL), el backend tardaba 120+ segundos. Causa: `systemd-resolved` causaba latencia masiva en DNS lookups que Node.js hace durante `http.listen()`.

**Solucion:**
```bash
sudo unlink /etc/resolv.conf
sudo bash -c 'echo "nameserver 8.8.8.8" > /etc/resolv.conf'
sudo bash -c 'echo "nameserver 8.8.4.4" >> /etc/resolv.conf'
sudo chattr +i /etc/resolv.conf  # inmutable — evitar sobreescritura de systemd
```

Resultado: 120s → 13s. Solo necesario en Ubuntu nativo, no en WSL.

### Diagnostico rapido si el startup se vuelve lento

```bash
# Paso 1: Verificar entorno
cat backend/.env | grep -E "DATABASE_URL|REDIS_URL"

# Paso 2: Verificar sin artifacts de investigacion
grep -r "ENABLE_ADMIN" backend/  # No debe encontrar nada

# Paso 3: Verificar servicios
psql "$DATABASE_URL" -c "SELECT 1"
redis-cli -u "$REDIS_URL" ping
curl "$MEILISEARCH_HOST/health"

# Paso 4: DNS (Ubuntu nativo)
time nslookup google.com  # Debe completar en <100ms
```

---

## Reglas Criticas

- `pool.min = 0` es CRITICO para Railway — con cualquier valor mayor habra "Connection ended unexpectedly"
- `pingInterval: 20000` en Redis es necesario — sin el, el proxy de Railway cierra el socket despues de ~20s idle
- El cache service de Medusa se resuelve con `req.scope.resolve("cache")` — no importar directamente
- Los indices con `CONCURRENTLY` no se pueden crear dentro de una transaccion ORM
- No agregar logica condicional compleja al config `admin:` — causa hangs de startup

---

## Archivos Clave

| Tipo | Ruta Completa | Proposito |
|------|---------------|-----------|
| Config | `/home/alejo/webapps/ecopowertech-workspace/backend/medusa-config.ts` | Pool y Redis config |
| Util | `/home/alejo/webapps/ecopowertech-workspace/backend/src/lib/cache-manager.ts` | CacheManager singleton |
| API | `/home/alejo/webapps/ecopowertech-workspace/backend/src/api/store/categories/[id]/products-with-filters/route.ts` | Endpoint con cache |
| Script | `/home/alejo/webapps/ecopowertech-workspace/backend/src/scripts/create-performance-indexes.ts` | Crear indices DB |
| Script | `/home/alejo/webapps/ecopowertech-workspace/backend/src/scripts/verify/verify-performance-indexes.ts` | Verificar indices |

---

## Historial de Decisiones

- **pool.min = 0**: El proxy de Railway cierra conexiones TCP idle en ~20-30s. Con min=0, Knex no mantiene conexiones idle y evita los drops.
- **pingInterval explícito**: El TCP keepalive a nivel de socket no es suficiente — el proxy de Railway necesita actividad a nivel de aplicacion. El PING de Redis cada 20s es esa actividad.
- **5 minutos TTL de cache**: Balance entre freshness y performance. Los productos no cambian con alta frecuencia. Ajustar si el inventario se actualiza mas rapido.
- **Script directo vs migration ORM para indices**: Medusa v2 con MikroORM puede saltarse migrations custom. El script con `pg` directo garantiza la ejecucion.
- **No condicionales en admin config**: Fue la causa del hang de 60s. La config debe ser simple y determinista.

# Finance Document Locking -- Bloqueo Pesimista
> **Tipo**: Technical Reference
> **Repo**: backend
> **Ultima verificacion**: 2026-04-02
> **Estado**: Current

---

## Que es y por que existe

El mecanismo de **Document Locking** protege documentos criticos del POS (Estimates, Orders) de sobreescrituras accidentales cuando dos agentes abren el mismo documento simultaneamente. Sin este mecanismo, el ultimo en guardar sobreescribe silenciosamente los cambios del primero.

**Implementacion:** Redis Pessimistic Locking + Heartbeats. No depende de validaciones optimistas ni de eventos del navegador (`beforeunload`), lo que lo hace robusto ante colapsos de red y cierres abruptos del navegador.

---

## Arquitectura

```
Usuario A abre Estimate #042
    |
POST /admin/documents/estimate/dord_12345/lock
    |
Redis: SET pos:lock:estimate:dord_12345 {userId, ...} EX 60 NX
    |
200 OK --> Usuario A tiene el lock

Usuario B intenta abrir el mismo Estimate
    |
POST /admin/documents/estimate/dord_12345/lock
    |
Redis: clave ya existe --> 409 Conflict
    |
POS muestra "Locked by Usuario A" en modo Spectator (solo lectura)
```

---

## Modelo Redis

**Key schema:** `pos:lock:{type}:{id}`

Ejemplos:
- `pos:lock:estimate:dord_12345`
- `pos:lock:order:order_abc789`

**Value (JSON serializado):**
```json
{
    "userId": "usr_987654321",
    "userName": "Maria Garcia",
    "sessionId": "b3f9-42b1-11ec...",
    "token": "4a1d-9f32-84de...",
    "lockedAt": "2026-03-24T15:30:00.000Z"
}
```

---

## Ciclo de Vida del Lock

### Adquisicion (On Mount)

`POST /admin/documents/{type}/{id}/lock`

Redis ejecuta atomicamente: `SET key payload EX 60 NX`

- Si la clave no existe: crea el lock, retorna 200
- Si la clave existe y el `sessionId` coincide: **reconexion de la misma pestana** -- renueva TTL, retorna 200 (soporta React Strict Mode re-mounts)
- Si la clave existe y el `sessionId` NO coincide: retorna 409 con info del owner actual

### Renovacion (Heartbeat)

`POST /admin/documents/{type}/{id}/lock/heartbeat`

El cliente del owner llama cada 30 segundos. Reinicia el TTL a 60 segundos.

- Solo el owner (mismo `userId` + `sessionId`) puede hacer heartbeat
- Si el owner pierde la conexion por mas de 60s, Redis expira el lock automaticamente

### Liberacion (On Unmount)

`DELETE /admin/documents/{type}/{id}/lock`

El cliente envia `keepalive: true` en el fetch para garantizar la entrega incluso si la pestana se esta cerrando.

### Liberacion Zombie (TTL)

Si el navegador colapsa o pierde internet brutalmente, el heartbeat se detiene. Tras 60 segundos exactos sin renovacion, Redis expira la clave automaticamente y libera el documento para otros.

---

## Tipos de Documentos Soportados

| type | Descripcion |
|------|-------------|
| `estimate` | Draft Orders / Estimates POS |
| `order` | Ordenes POS activas |

---

## API Routes

```
Backend: src/api/admin/documents/[type]/[id]/lock/route.ts
```

| Metodo | Path | Descripcion |
|--------|------|-------------|
| POST | `/admin/documents/{type}/{id}/lock` | Adquirir lock |
| POST | `/admin/documents/{type}/{id}/lock/heartbeat` | Renovar lock |
| DELETE | `/admin/documents/{type}/{id}/lock` | Liberar lock |
| GET | `/admin/documents/{type}/{id}/lock` | Consultar estado del lock |

---

## Comportamiento en el POS

### Owner (usuario con el lock)
- Puede editar y guardar normalmente
- Ve un indicador de "Editando" en la UI
- Al salir de la vista, el lock se libera automaticamente

### Spectator (usuario sin el lock)
- Ve un banner de advertencia rojo: "Locked by {nombre del owner}"
- Todos los controles de guardado estan desactivados
- Puede leer el documento sin restricciones
- Si el lock expira (zombie TTL o liberacion), puede adquirirlo al refrescar

---

## Consideraciones de Implementacion

### Multi-tab del mismo usuario

Si el mismo usuario tiene el documento abierto en dos pestanas:
- Primera pestana: adquiere el lock normalmente
- Segunda pestana: si tiene el mismo `sessionId` (React dev mode) -> reconexion exitosa
- Segunda pestana con diferente `sessionId` -> bloqueada como spectator (comportamiento correcto)

### Conexion Redis

El sistema usa la instancia Redis existente del cluster Medusa (`REDIS_URL`). No requiere Redis separado.

---

## Archivos Clave

| Tipo | Ruta | Proposito |
|------|------|-----------|
| Lock route | `src/api/admin/documents/[type]/[id]/lock/route.ts` | GET/POST/DELETE del lock |
| Heartbeat route | `src/api/admin/documents/[type]/[id]/lock/heartbeat/route.ts` | Renovacion del TTL |

---

## Historial de Decisiones

- **Redis vs DB locking:** Se eligio Redis por su soporte nativo de TTL. Un DB lock requeriria un cron para limpiar locks huerfanos. Redis lo hace automaticamente.
- **TTL 60s, heartbeat 30s:** El heartbeat al 50% del TTL garantiza buffer suficiente para latencia de red sin desperdiciar conexiones.
- **keepalive en DELETE:** Los eventos `unload`/`beforeunload` del navegador no son confiables. `fetch(..., { keepalive: true })` garantiza que el DELETE se envie incluso cuando la pestana se destruye.
- **sessionId para reconexion:** React Strict Mode hace double-mount en desarrollo. Sin el `sessionId`, el segundo mount rechazaria el lock del mismo usuario. Con `sessionId`, se detecta como reconexion y se renueva.

# POS Document Locking - Architecture & Technical Documentation

Este documento detalla la arquitectura, el flujo de datos y las decisiones de diseño del mecanismo de **Document Locking (Bloqueo Pesimista)** dentro de la aplicación EcoPowerTech Store POS, el cual protege documentos críticos como Estimates y Orders de sobreescrituras accidentales.

A diferencia del plan original que dependía de validaciones optimistas o eventos del navegador (`beforeunload`), el sistema implementado utiliza **Redis Pessimistic Locking + Heartbeats**, ofreciendo robustez absoluta a nivel de servidor sin importar colapsos de red o navegadores.

---

## 1. Naturaleza y Objetivo del Bloqueo

**Problema:** Si dos agentes (Ej. Maria y Juan) abren el mismo Estimate `#042` en el POS simultáneamente, el último en hacer clic en *Save* sobreescribirá silenciosamente los cambios del primero.

**Solución Implementada:**
- El primer usuario en abrir el documento adquiere un "Lock" exclusivo.
- Cualquier otro usuario que intente abrir el mismo documento entra en modo **Spectator (Solo Lectura)**.
- El POS despliega un banner de advertencia rojo ("Locked by Maria") y desactiva todas las combinaciones de guardado.

---

## 2. Estrategia Arquitectónica (Redis + Heartbeat)

El sistema de bloqueos descansa en la infraestructura **Redis** ya existente en el clúster de Medusa, aprovechando la expiración inherente de llaves (TTL) para evitar bloqueos fantasma ("Zombie Locks") en caso de que una pestaña se cierre inesperadamente.

### 2.1. Ciclo de Vida del Lock

1. **Adquisición (`On Mount`):** Cuando el owner monta la vista del documento, envía una petición `POST` solicitando exclusividad. Redis ejecuta un comando atómico `SET NX EX 60`.
2. **Renovación Constante (`Heartbeat`):** El cliente del owner se reporta cada 30 segundos (`POST /heartbeat`) para reiniciar el contador de vida (TTL) del lock nuevamente a 60 segundos.
3. **Liberación (`On Unmount` / Cierre):** Al salir de la vista, el cliente envía un `DELETE` notificando su salida oficial. Se envía mediante `keepalive: true` en fetch para garantizar su entrega incluso si la pestaña se destruye.
4. **Liberación de Emergencia (Zombie TTL):** Si el navegador colapsa o pierde internet brutalmente, el heartbeat se detiene. Tras 60 segundos exactos, Redis destruye la llave y libera el documento para el resto del equipo.

---

## 3. Modelo de Datos en Redis

El bloqueo se centraliza almacenando la información pertinente en Redis bajo una estructura serializada JSON.

**Key Schema:**
`pos:lock:{type}:{id}` *(Ej. `pos:lock:estimate:dord_12345`)*

**Value Payload (JSON):**
```json
{
  "userId": "usr_987654321",
  "userName": "Alejo Vargas",
  "sessionId": "b3f9-42b1-11ec...",
  "token": "4a1d-9f32-84de...",
  "lockedAt": "2026-03-24T15:30:00.000Z"
}
```

---

## 4. Backend API - Lógica Atómica (Medusa Routes)

La implementación en backend (`backend/src/api/admin/documents/[type]/[id]/lock/route.ts`) introduce patrones avanzados de concurrencia y seguridad:

### 4.1. Adquisición y Soporte Multi-Tab (Session ID)
Al recibir un `POST /lock`, el sistema intenta el comando `SET key payload EX 60 NX`. 
Una característica vital implementada es la **reconexión por misma sesión (`sessionId`)**. Si el key ya existe, el servidor lee el payload; si el `sessionId` del cliente entrante coincide con el del dueño actual, infiere que es la **misma pestaña reconectando** (ej. React Strict Mode haciendo re-mounts) y le renueva el TTL otorgándole éxito (200 OK) en lugar de un conflicto (409 Conflict).

### 4.2. Liberación Segura mediante Scripts Lua
Liberar un bloqueo usando `DELETE /lock` entraña un riesgo de carrera: un cliente rezagado podría intentar borrar un bloqueo que ya expiró y fue adquirido por alguien más.
Para solucionar esto, el backend usa un **Lua Script atómico** que lee la llave, verifica si el `token` coincide exactamente con el del solicitante y solo ahí ejecuta el comando `DEL`.

```lua
if redis.call("get", KEYS[1]) then
  local data = cjson.decode(redis.call("get", KEYS[1]))
  if data["token"] == ARGV[1] or ARGV[2] == "force" then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
else
  return 1
end
```

### 4.3. Fuerza Bruta Administrativa (Force Unlock)
Si un gerente necesita intervenir un documento urgentemente trabado por otro usuario ausente, el endpoint provee una compuerta trasera (`x-force-unlock: true`). Este mecanismo requiere una llave simétrica alojada en las variables de entorno del servidor (`FORCE_UNLOCK_CODE`). Al emparejarse correctamente, el script Lua puentea las validaciones de token y aniquila la llave.

---

## 5. Frontend Implementation (`useDocumentLock.ts`)

La lógica fronteriza fue completamente delegada al hook centralizado `ecopowertech-store-pos/hooks/useDocumentLock.ts`, lo que permite unificar Estimates, Orders y a futuro cualquier otra interfaz.

### 5.1 Parámetros de Retorno (`LockState`)
```typescript
interface LockState {
  isOwner: boolean;         // ¿Este cliente posee la exclusividad?
  isLocked: boolean;        // ¿Está bloqueado por ALGUIEN?
  lockedBy: string | null;  // "Maria Lopez"
  isReadOnly: boolean;      // Getter directo (isLocked && !isOwner)
  forceRelease: (code: string) => Promise<void>; 
}
```

### 5.2. Owner Logic Vs. Spectator Polling
El ciclo de vida React reacciona al intento inicial de `acquireLock()`:
- Tras éxito (200), inicializa un `setInterval` cada 30 segundos llamando a la ruta `heartbeat/route.ts`.
- Tras fracaso (409), el hook asume que es el perdedor (`Spectator`) e inicializa un Polling de "mirada" cada 15 segundos (`GET /lock`).
- Apenas el polling reporta que la llave en Redis fue eliminada (`locked: false`), el hook automáticamente suspende la espera, dispara una refactura de Lock, se roba el control y desactiva las protecciones Read-Only en la UI.

### 5.3 Fetch Keepalive (Destrucciones de Tab)
Una adición excepcional integrada en el evento `releaseLock()` del Unmount del Frontend es la bandera nativa de navegador `keepalive: true`.

```typescript
const releaseLock = useCallback(async (force = false, unlockCode?: string) => {
  await fetch(url, {
    method: 'DELETE',
    headers: { ... },
    keepalive: true, // ¡CRÍTICO!
  });
});
```
Durante una transición rápida de la aplicación Next.js o un cierre accidental del browser, los Requests HTTP en cola suelen ser terminados por el colector de basura. Esta directriz le ordena al OS terminar la llamada HTTP de liberación de Lock a toda costa después que el proceso DOM principal ha muerto, logrando una limpieza real inmediata del 99% y limitando los Zombie Locks de 60 segundos únicamente a los genuinos colapsos de red.

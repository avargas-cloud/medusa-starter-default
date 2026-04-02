# QuickBooks Admin Dashboard
> **Tipo**: Operational Guide
> **Repo**: backend
> **Ultima verificacion**: 2026-04-02
> **Estado**: Current

---

## Que es

El QB Admin Dashboard es la interfaz en el Admin Panel de Medusa que permite monitorear y controlar la integracion con QuickBooks Desktop. Esta implementada en el frontend del POS (Next.js) y consume los endpoints `/admin/quickbooks/*`.

---

## Secciones Principales

### 1. Pipeline Monitor

Muestra el estado en tiempo real de todas las operaciones QB en `qb_order_pipeline`.

**Columnas:**
- Referencia Medusa (`medusa_ref_number`): INV-20001, PAY-2016, E1271, etc.
- Step: estimate, sales_order, invoice, payment, etc.
- Status con badge de color: waiting (gris), pending (amarillo), submitted (azul), confirmed (verde), failed (rojo), skipped (gris oscuro)
- Referencia QB (`qb_ref_number`): numero asignado por QB Desktop
- Timestamps: submitted_at, confirmed_at, failed_at
- depends_on: muestra la dependencia (ej. refund_payment esperando write_check)

**Filtros disponibles:**
- Por status
- Por step
- Por reference_id / order_id

**Acciones:**
- Retry: disponible en filas `failed` o `waiting`
- Flush pipeline: elimina todas las filas (destructivo)

**Auto-timeouts:** El endpoint GET aplica timeouts automaticos. Ver QB_PIPELINE.md para detalles.

### 2. Bridge Status

Muestra estadisticas de la cola del bridge en tiempo real:
- Operaciones pending/processing/completed/failed en el bridge
- Health check del bridge

**Acciones:**
- Reset-busy: Resetea operaciones bloqueadas en el bridge
- Purge: Purga toda la cola (usar solo en emergencias)

### 3. Configuracion

Permite ajustar sin reiniciar el servidor:

| Campo | Descripcion |
|-------|-------------|
| Kill switch | Habilitar/deshabilitar toda la integracion |
| Intervalo de inventario | Frecuencia de sync (minutos) |
| Intervalo de precios | Frecuencia de sync (minutos) |
| Intervalo de clientes | Frecuencia de sync (minutos) |
| Hora de sync de precios | Hora del dia para price sync (modo daily) |
| Timezone | Para calcular la hora del sync |
| Shipping Item ID | QB ListID del item de shipping |
| Sales Tax Code | Codigo de impuesto QB por defecto |
| Horario de tienda | Horas de operacion (lun-vie, sabado, domingo) |
| Respetar horario | Por tipo de sync: si solo synca durante horario de tienda |

### 4. Sync Jobs

Permite disparar syncs manuales:
- Sync de inventario (QB -> Medusa)
- Sync de precios (QB -> Medusa)
- Sync de clientes (QB -> Medusa)
- Ver ultimo reporte de cada tipo de sync

El stream SSE en `/admin/quickbooks/sync/stream` muestra logs en tiempo real.

### 5. Customer Import

Permite importar/reconciliar clientes desde QB hacia Medusa. Ver QB_CUSTOMER_IMPORT.md para el flujo completo.

---

## Monitoreo Operacional

### Que revisar primero si algo falla

1. **Bridge health:** GET /admin/quickbooks/bridge -- si falla, el servidor Windows puede estar offline
2. **Pipeline failures:** filtrar por status=failed -- ver el campo `error` para el mensaje del bridge
3. **QBWC connection:** Si el bridge esta healthy pero las operaciones quedan en `submitted` por mas de 15 min, QBWC no esta conectado a QB Desktop
4. **Integration enabled:** GET /admin/quickbooks/config -- verificar `integration_enabled: true`

### Flujo de diagnostico tipico

```
Sync no funciona
    |
    +-- GET /admin/quickbooks/bridge
    |   +-- 502: Bridge offline -> ir al servidor Windows, revisar PM2
    |   +-- OK: Bridge online
    |
    +-- GET /admin/quickbooks/config
    |   +-- integration_enabled: false -> activar via POST /admin/quickbooks/config
    |   +-- OK: habilitado
    |
    +-- GET /admin/quickbooks/pipeline?status=failed
        +-- Ver error en cada fila fallida
        +-- Retry si es error transitorio
        +-- Escaldar si es error de configuracion QB
```

### Errores comunes

| Error | Causa | Solucion |
|-------|-------|----------|
| "QBWC did not respond within 15 minutes" | QB Desktop offline o QBWC desconectado | Verificar que QB Desktop esta abierto y QBWC esta corriendo |
| "Submission timed out" | Handler no envio al bridge | Retry desde el pipeline |
| "Operation stuck in pending" | Handler invocado pero no llego al bridge | Retry automatico o manual |
| "QB operation failed: 3210" | EditSequence stale | El consolidator/recovery lo maneja; si persiste, retry manual |
| "QB operation failed: 6240" | Duplicado de numero de referencia | Cambiar el medusa_ref_number |

---

## POS QuickBooks Integration Page

El POS tiene su propia vista de integracion QB en la seccion de Accounting. Muestra:

- **Pending QB Payments:** `customer_payment` records con `qb = null` o `qb.status = 'no'` que necesitan Write Check
- **QB Refunds:** pagos con status `refunded`/`partial_refunded` que necesitan procesamiento en QB
- Para cada pago, permite seleccionar la cuenta bancaria QB y ejecutar el Write Check

Esta pagina consume `/admin/finance/qb-refunds/pending` y `/admin/finance/qb-bank-accounts`.

---

## Archivos Clave

| Tipo | Ruta | Proposito |
|------|------|-----------|
| API bridge | `src/api/admin/quickbooks/bridge/route.ts` | Queue stats + control |
| API config | `src/api/admin/quickbooks/config/route.ts` | Configuracion |
| API pipeline | `src/api/admin/quickbooks/pipeline/route.ts` | Monitor + retry |
| API logs | `src/api/admin/quickbooks/logs/route.ts` | Sync logs |
| API sync | `src/api/admin/quickbooks/sync/*/route.ts` | Syncs manuales |
| QB refunds | `src/api/admin/finance/qb-refunds/pending/route.ts` | Pending refunds para QB |
| QB bank accounts | `src/api/admin/finance/qb-bank-accounts/route.ts` | Cuentas bancarias QB |

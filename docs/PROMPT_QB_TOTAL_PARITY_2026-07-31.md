# Prompt de continuación — paridad de totales con QuickBooks

*Escrito 2026-07-30 al pausar. Plan `qb-total-parity-v1`, scope `3eaecefe`.*

Pegá esto tal cual al abrir la sesión nueva.

---

## Contexto

Estoy cerrando la paridad 100% entre lo que calcula nuestro sistema y lo que
factura QuickBooks, en todas las formas: con/sin impuesto, con/sin descuento por
ítem, con/sin descuento de orden.

**El objetivo de negocio:** un estimado que el cliente aprueba no puede cambiar
de total al convertirse en orden ni al editarse, y el número tiene que ser el
mismo que QuickBooks factura.

Ya hay trabajo hecho y verificado. Leé este archivo entero antes de tocar nada.

## Qué ya está hecho y verificado

**Cinco cambios de runtime** (todos con evidencia contra documentos reales de QB
leídos del bridge el 2026-07-30 y congelados en
`backend/docs/qb-ground-truth-2026-07-30.json`, 31 documentos):

1. `src/lib/order-money/order-tax-lines.ts` — `loadOrderMoneyBase` redondea el
   descuento **por línea** y suma, en vez de acumular sin redondear. Evidencia:
   S11242 / QB Invoice 19614 factura 138.07 → total 1699.07; la convención vieja
   daba 138.08 → 1699.06. Afecta 7 de 31 órdenes con descuento, de 1¢ a 4¢.
2. `src/api/admin/draft-orders/[id]/compute-tax/route.ts` — la ruta de ESTIMADOS
   dejó su aritmética propia (subtotal, descuento y total) y usa las mismas
   funciones que la de órdenes. Hereda el guard *refuse-no-guess*.
3. `src/api/admin/orders/[id]/post-edit-sync/route.ts` — ahora escribe
   `computed_total` y `pos_total` junto con el summary. Antes NINGUNA ruta de
   orden lo escribía: sólo `compute-tax`, o sea la de estimados, y por eso el
   campo quedaba congelado en la foto del estimado. Reproducido en sandbox:
   agregar una línea de $101.62 dejaba `current_order_total` en 1799.68 y
   `computed_total` en 1699.07 — la lista mostraba el total de 11 líneas sobre
   una orden de 12.
4. `src/api/admin/draft-orders/[id]/convert-force/route.ts` — el mismo write.
5. `src/lib/quickbooks/order-flow-core.ts` — `getEffectiveOrderDiscount`
   redondea por línea **y** ahora prioriza los adjustments sobre
   `discount_total`. Este último es el agregado de Medusa (138.0792 → 138.08) y
   no puede expresar el redondeo por línea. Alimenta Estimate y Sales Order, o
   sea el descuento que viaja a QuickBooks.

**Cinco archivos de test/datos nuevos:**

| archivo | qué prueba | estado |
|---|---|---|
| `backend/docs/qb-ground-truth-2026-07-30.json` | 31 documentos QB congelados | — |
| `backend/src/scripts/checks/probe-qb-discount-resolver.ts` | qué descuento le llega a QB por documento | read-only |
| `backend/src/scripts/tests/e2e-qb-parity-discounted-orders.ts` | derivación vs QB, 7 documentos con descuento | 7/7 ✅ |
| `backend/src/scripts/tests/e2e-total-lifecycle-sandbox.ts` | estimado → convertir → editar → deshacer, + orden creada de cero | 20/20 ✅ |
| `backend/src/scripts/tests/e2e-qb-payload-parity-sandbox.ts` | el PAYLOAD que sale a QB en los 3 ensamblados | 20/20 ✅ |
| `store-pos/scripts/checks/qb-parity-frontend.test.ts` | el `computeTotals` del navegador vs QB | 20/20 ✅ |

Gates al pausar: `yarn build` ✅ · `yarn type-check` ✅ · `yarn test:unit`
440/440 ✅ · `verify-order-total-qb-parity` ✅.

**Advertencia sobre esos gates:** se corrieron en un worktree que también tenía
cambios sin commitear de OTRA sesión (`handle-pos-payment-applied.ts`,
`resubmit-by-step.ts`, `src/__tests__/qb-apply-dispatch/`,
`src/scripts/tests/_stub-qb-bridge.ts`). O sea que el verde **no aísla** estos
cambios. Revalidar en limpio antes de deployar.

## Qué falta — las fases pendientes del plan

**Fase 4 · Atomicidad y contrato de entrada** (R1)
- `convert-force`: hay un comentario mío que dice que el write de metadata va
  "en la MISMA transacción que el summary". **Es falso** — el `client` sale de
  `db.connect()` sin `BEGIN`, y el propio archivo lo dice en la línea 576. Hay
  que borrar esa afirmación y decidir: frontera transaccional real, o
  reconciliación idempotente con error VISIBLE (hoy degrada a warning).
- `post-edit-sync`: el write canónico vive dentro de `if (pos_tax_amount != null)`
  (línea ~211). Una edición que no mande ese campo no alinea los tres campos.
  O el backend deriva el impuesto solo, o rechaza la edición incompleta.

**Fase 5 · Endurecer los tests** (R1)
- `e2e-total-lifecycle-sandbox.ts`: una etapa con `total === null` NO cuenta como
  fallo hoy (`offQb` la filtra). Exigir no-nulo por etapa.
- Exigir `computed_total == pos_total == current_order_total`, no `computed ?? summary`.
- `e2e-qb-parity-discounted-orders.ts`: se inyecta `f.qbDiscount` como entrada,
  así que prueba "si le doy el descuento correcto, da el total correcto". Debe
  derivarlo del documento.
- `store-pos/scripts/checks/qb-parity-frontend.test.ts`: sólo falla por total.
  Calcula los deltas de tax y descuento y no los assertea — un impuesto alto
  compensado por un descuento bajo pasaría.

**Fase 6 · Fallo inyectado** (R2)
Romper a propósito el segundo write y comprobar que el sistema NO responde éxito
con estado parcial. No existe todavía.

**Fase 3b · Payload de invoice y sales receipt** (delta pendiente de aprobar)
El ensamblado de invoice/SR es distinto: lee `pos_invoice_item`, puede ser
parcial, y calcula el descuento como `invoiceDiscount − Σ descuentos de línea`
(`handle-fulfillment-created.ts:591`). Para capturarlo sin reimplementarlo hay
que apuntar `QB_BRIDGE_URL` a un stub que registre el payload. **Ojo:** la otra
sesión ya creó `src/scripts/tests/_stub-qb-bridge.ts` — revisarlo antes de
escribir uno nuevo.

**Fase 7 · Corrida completa + gates** y después, sólo si todo está verde:
deploy → dry-run del backfill → backfill → force-sync.

## Lo que NO se hizo y NO se debe hacer sin decisión explícita

- **Backfill de los 7 totales viejos en producción.** Va con
  `/safe-data-migration`: backup, foto, aplicar, comparar.
- **Force-sync de E2146 y E2607 a QuickBooks.** Sus estimates en QB están
  desactualizados por ~$1.960 y ~$960 (les falta el descuento, que se agregó
  después de la última sincronización). Codex marcó explícitamente que no se
  haga con el resolver sin verificar — ahora el resolver está arreglado, pero el
  payload de Estimate hay que verificarlo con la Fase 3b primero.
- **Cualquier escritura en QuickBooks.** Todo lo hecho fue sólo consultas.

## Reglas de esta tarea que costaron caro aprender

- **Mis propios tests pasaron estando rotos SEIS veces.** La etapa de edición era
  vacua (no mandaba los campos `pos_*`, así que la ruta no recalculaba); no
  copiaba el shipping (S10612 salía −$30 y parecía defecto de cálculo); comparaba
  una orden parcialmente facturada contra su factura parcial (S11132 parecía
  valer el doble); el camino directo chocaba con el guard anti-duplicados;
  y en el payload volví a olvidar la línea de envío. **Todo assert de "no pasó
  nada" necesita un control positivo.**
- **Una nota que nombra un archivo o un defecto se verifica leyéndolo.** Heredé
  "S11132 deriva el doble" de una nota previa y lo repetí sin mirar: eran 20 de
  40 unidades facturadas, y QB lo dice él mismo (`qty 40 · Invoiced 20`).
- **`convert-force` bloquea conversiones duplicadas**: mismo cliente + misma
  huella de líneas dentro de 45 s. Un test que crea el mismo documento dos veces
  lo dispara y el draft queda sin convertir.
- **No editar `backend/src` mientras corre un E2E**: `medusa develop` reinicia y
  tumba la corrida (me costó 15 falsos fallos).
- **QuickBooks no calcula el descuento, se lo mandamos hecho**
  (`order-flow-core.ts:664`). QB deriva por su cuenta sólo el impuesto y la suma.
- **Los `verify-*` que son `medusa exec` (`export default`) no hacen NADA con
  `tsx`** — salen 0 sin ejecutar.

## Cómo correr lo que ya existe

```bash
cd backend
# infra sandbox + backend
../scripts/sandbox/status.sh          # si no, ../scripts/sandbox/start.sh
../back-sb                            # espera "Backend SANDBOX ready" (:9099)

# los cuatro E2E
./node_modules/.bin/tsx src/scripts/tests/e2e-qb-parity-discounted-orders.ts
./node_modules/.bin/tsx src/scripts/tests/e2e-total-lifecycle-sandbox.ts
env DATABASE_URL='postgresql://postgres:sandbox@localhost:5499/medusa' \
    REDIS_URL='redis://localhost:6399' MEILISEARCH_HOST='http://localhost:7799' \
    MEILISEARCH_API_KEY='sandbox_master_key' QB_BRIDGE_DISABLED=true \
    DISABLE_SCHEDULED_JOBS=true \
    ./node_modules/.bin/medusa exec ./src/scripts/tests/e2e-qb-payload-parity-sandbox.ts
cd ../store-pos && node --experimental-strip-types scripts/checks/qb-parity-frontend.test.ts

# snapshot de sandbox para volver atrás
../scripts/sandbox/switch.sh pre-test-pos-total-lifecycle
```

## Cómo quiero que trabajes

Seguí el plan `qb-total-parity-v1` desde la **Fase 4**. Antes de commitear
cualquier cosa, HOLD y preguntame. Nada de escribir en producción ni en
QuickBooks sin checkpoint con números reales.

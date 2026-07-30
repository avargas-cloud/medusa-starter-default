# Prompt de continuación — reparar los 3 documentos con descuento corrupto

*Escrito 2026-07-30 al cerrar. Pegá esto tal cual al abrir la sesión nueva.*

---

## Contexto

Hay **3 documentos en producción** cuyo total guardado está mal porque sus filas
de `order_line_item_adjustment` cargan un descuento que el documento no muestra,
o lo muestra por otro monto. El bug que los produjo **ya está arreglado y
desplegado** (`3b8fbaef`), así que el conjunto no crece — pero estos tres quedaron
con el daño hecho.

El backfill de totales **no puede arreglarlos** y por eso se los excluyó
explícitamente: deriva de las líneas, y en estos las líneas son la fuente del
error. Correrlo sobre ellos escribe un número que sigue estando mal, sólo que
distinto.

| doc | guardado | el documento dice | falta | qué tiene mal |
|---|---|---|---|---|
| **E2607** | 7.521,62 | **8.481,75** (POS y QB coinciden) | 960,13 | 3 filas fantasma: `ORDER-DISCOUNT-10%`, `ORDER-DISCOUNT-5%`, `Volume Discount` = 897,32 |
| **E1497** | 31.730,72 | **32.204,74** (QB) | 474,02 | 1 fila fantasma: `ORDER-DISCOUNT-20%` = 443,01 |
| **E2146** | 19.825,62 | **19.607,76** (POS) | 217,86 | el descuento SÍ existe (10% real); el monto está mal: 1.960,78 en vez de 2.178,64 |

## Los dos remedios, que NO son el mismo

**E2607 y E1497 — no existe ningún descuento de orden.** Su `metadata` no tiene
`discount_type` ni `discount_value`, y el POS muestra `Discount $0.00`. Las filas
de adjustment son 100% huérfanas. **Borrarlas** hace que la derivación dé
exactamente el total del documento.

**E2146 — el descuento es real.** `metadata` dice `percent 10` y la pantalla
muestra el chip `CPOS-PCT-1000: 10% OFF` con `Order Discount −2.178,64`. Lo que
está mal es el MONTO de la fila: 1.960,78, que es 10% de 19.607,76 (el subtotal ya
descontado) en vez de 10% de 21.786,40. Acá **no hay que borrar**: hay que
**recalcular**.

**Hipótesis sin probar, y es lo primero que hay que verificar:** a E2146 podría
alcanzarle con abrirlo en el POS y guardarlo, porque el código desplegado hoy
recalcula el descuento sobre la base limpia. Si es así, no hace falta script.

## Lo primero, antes de tocar nada

Todo esto se prueba en la sandbox, que tiene copia de los tres y corre el código
de producción. **Cero riesgo.**

```bash
cd /home/alejo/webapps/ecopowertech-workspace
./scripts/sandbox/status.sh          # si no está, ./scripts/sandbox/start.sh
./back-sb                            # espera "Backend SANDBOX ready" (:9099)
```

Dos experimentos que contestan todo:

1. **E2146 en sandbox** → abrirlo/guardarlo por `sync-pos` y mirar si los
   adjustments pasan a 2.178,64 y `computed_total` a 19.607,76.
2. **S11132 en sandbox** → guardarla y ver si se desalinea de su factura. Es una
   de las 12 protegidas y su caso decide otra pregunta abierta (abajo).

## Cómo verificar el estado de los tres

```bash
cd backend
PROD=$(grep ^DATABASE_URL= .env | cut -d= -f2-)
psql "$PROD" -A -F' | ' -t -c "
SELECT o.metadata->>'document_number',
       o.metadata->>'computed_total',
       o.metadata->>'discount_type', o.metadata->>'discount_value',
       (SELECT string_agg(DISTINCT a.code||'='||a.amount, ' ; ')
          FROM order_item oi JOIN order_line_item_adjustment a ON a.item_id=oi.item_id
         WHERE oi.order_id=o.id AND oi.version=o.version AND a.deleted_at IS NULL)
FROM \"order\" o WHERE o.metadata->>'document_number' IN ('E2607','E1497','E2146');"
```

Y el censo del backfill, read-only, sin `APPLY`:

```bash
./node_modules/.bin/tsx src/scripts/fix/recompute-order-totals.ts
# hoy reporta exactamente 3 filas por reescribir: los tres de arriba
```

Tras reparar las filas, el backfill **sí** los puede terminar:

```bash
ONLY=E2607 ./node_modules/.bin/tsx src/scripts/fix/recompute-order-totals.ts   # dry-run
# el APPLY lo bloquea bypass-guard: pedírselo al operador con '! <cmd>'
```

## Lo que NO se debe hacer sin decisión explícita

- **Escribir en QuickBooks.** E2146, S10090 y E1344 tienen un descuento de orden
  que QB nunca recibió (1.960,78 · 875,33 · 103,23). Es un problema **distinto**
  y arreglarlo exige un `EstimateMod`/`SalesOrderMod` real. Todo lo que se hizo
  contra QB hasta ahora fueron consultas.
- **Tocar las 12 protegidas en bloque.** No son un solo problema: S11132 y S11144
  son facturas **parciales legítimas** (20 de 40 unidades — QB lo dice él mismo) y
  ahí no hay nada roto; S10008/S10010/S10012 están ~7% desviadas, que es la firma
  del impuesto sumado dos veces; las otras 7 son centavos.
- **Reparar los 6 documentos ya entregados al cliente.** El operador decidió el
  2026-07-30 que quedan como están.

## Reglas de esta tarea que costaron caro

- **Cinco veces afirmé una causa por inferencia y las cinco se cayeron al medir.**
  Dije que QuickBooks estaba desactualizado (no lo estaba), que no existían los
  MODs de estimados (existen, 157 con respuesta `EstimateModRs`), que E2606 estaba
  sano (no lo está), que la culpa era de la limpieza (no lo era), y que el daño era
  histórico (pasa con el código actual). Lo que resolvió el caso fue el experimento
  paso a paso.
- **Contar filas de `qb_order_pipeline` por `step` NO ve los MODs**: un
  `intent:"mod"` REACTIVA la fila existente en vez de insertar una nueva. La verdad
  se pregunta por lo que contestó QuickBooks: `qb_result ILIKE '%EstimateModRs%'`.
- **`sync-pos` sin `action` contesta 200 y no hace nada.** `{success:true,
  cart_id:null}`, y sólo se nota en el log del server
  (`GET /admin/draft-orders/undefined/compute-tax → 404`).
- **El descuento de orden NO lo materializan `discount_type`/`discount_value`**:
  lo crea la PROMOCIÓN vía `/admin/pos-discount`. Un experimento que mande sólo
  esos dos campos prueba un camino que el POS nunca toma.
- **`medusa develop` reinicia con CADA escritura en `src/`**, incluidas las de otra
  sesión de Claude Code en el mismo worktree. Tumbó tres corridas de E2E con
  `ECONNREFUSED`. Todo E2E contra sandbox necesita reintentar sobre conexión
  rechazada — `e2e-order-discount-lifecycle-sandbox.ts` ya lo hace.
- **La sandbox tiene que estar restaurada de producción** para que estos números
  signifiquen algo. Un E2E previo puede haber reescrito justo el documento que se
  está midiendo: así fue como el `7/7` de una sesión anterior se sostuvo sobre datos
  que otro test había tocado.

## Los candados que ya existen

Corren verdes hoy; si alguno se pone rojo, el arreglo rompió algo:

```bash
cd backend
./node_modules/.bin/tsx src/scripts/tests/e2e-order-discount-lifecycle-sandbox.ts   # 13 pasos
env PROBE_DATABASE_URL="$(grep ^DATABASE_URL= .env|cut -d= -f2-)" \
  ./node_modules/.bin/tsx src/scripts/checks/probe-residual-drift.ts               # read-only
env E2E_DATABASE_URL='postgresql://postgres:sandbox@localhost:5499/medusa' \
  ./node_modules/.bin/tsx src/scripts/tests/e2e-qb-parity-discounted-orders.ts
TEST_TYPE=unit yarn test:unit
```

## Cómo quiero que trabajes

Medí antes de afirmar. Si una nota nombra un archivo o un defecto, **abrilo y
verificalo** — esta tarea nació de repetir una nota heredada sin mirarla. Antes de
commitear, HOLD y preguntame. Nada de escribir en producción ni en QuickBooks sin
checkpoint con los números reales a la vista.

# Prompt para la próxima sesión

Copiá todo lo que está debajo de la línea.

---

Continuamos el trabajo de totales de orden. El fix de raíz ya está en producción
y funcionando; lo que queda es analizar 61 documentos, uno por uno, y decidir qué
hacer con cada uno. No hay nada urgente ni roto: el sistema es coherente hoy.

## Qué se hizo ayer (2026-07-30, madrugada)

El total de una orden se derivaba a mano en tres rutas del POS
(`original_order_total + pos_tax − discount`), lo que duplicaba el tax en 43
órdenes, y se estampaba una sola tasa en todas las líneas ignorando la
taxabilidad de cada una. Además el payload `MOD` a QuickBooks no mandaba el flag
`taxable` por línea, así que QB re-derivaba la taxabilidad del ítem del catálogo
y no coincidía con el documento que ya había emitido.

La derivación vive ahora una sola vez en `src/lib/order-money/order-tax-lines.ts`.
Desplegado en backend `e0e0acd0` y store-pos `8e31048`.

Se hizo con red: backup verificado de prod, una foto previa de los 2.752
documentos en la tabla `document_total_photo`, backfill, y comparación contra la
foto. **2.696 documentos conservaron exactamente el total que el cliente ya
tenía, incluidas las 1.224 facturas — ninguna se movió.**

## Lo que hay que hacer

Está todo en `backend/docs/REVISION_TOTALES_2026-07-30.md` (mismo detalle en CSV
en `backend/docs/revision-totales-2026-07-30-grupoB.csv`). Son dos grupos y son
problemas distintos:

**Grupo A — 12 órdenes que el script NO tocó.** Un guard las frenó porque su
derivación contradice una factura ya emitida. Lo que está mal en ellas son las
LÍNEAS, no el total. Tres sub-casos:

- Siete con diferencias de 2 a 48 centavos (S10255, S10261, S10279, S10315,
  S10354, S10389, S10464) — redondeo de descuentos porcentuales.
- Tres del 14 de abril donde la factura cobró **tax cero** sobre líneas marcadas
  gravables y el cliente pagó ese total (S10008, S10010, S10012). Ya hay script
  preparado y **sin correr**: `src/scripts/fix/align-line-taxable-to-billed.ts`.
- Dos raras: **S11132** deriva exactamente el DOBLE de su factura ($1.705,20
  contra $852,60), y **S11144** difiere $102,63 sin explicación.

**Grupo B — 49 documentos cuyo total mostrado cambió.** 28 presupuestos y 21
órdenes. No son errores por definición: en dos ya sabemos que el número nuevo es
el correcto (E2087 coincide al centavo con QuickBooks; S10578 refleja su factura
real de $0,00). Las diferencias grandes sin revisar son E1903 (+$577,40),
S10447 (+$517,35), E1845 (−$361,75), E1916 (+$215,92), E1938 (−$204,93).

Prioridad y orden los decide el operador — preguntá antes de arrancar.

## Cómo trabajar esto (reglas que costaron caro anoche)

**QuickBooks es la autoridad, y se le pregunta.** No alcanza con comparar contra
`computed_total` o `pos_total`: en los documentos donde importa, esos campos son
justamente los que no coinciden con lo que el cliente tiene. El bridge se
consulta read-only con el skill `qb-query`. Anoche eso resolvió dos preguntas que
llevaban horas dando vueltas, y en ambas mi modelo de QB estaba equivocado:

- QB **prorratea** un descuento de orden entre líneas gravadas y exentas, aunque
  su ítem `Discount` esté codeado `Tax` (medido en E2087: 201,18).
- El `Subtotal` de QB redondea **la LÍNEA**, no el unitario (verificado en E1497,
  E1845, E1903 y E1976 — las cuatro, y en las dos direcciones).

**Los dos lados de una comparación tienen que leer el mismo campo.** Esta falla
apareció dos veces en una noche: el compare leía `computed_total` contra una foto
tomada de `pos_total` y reportó 188 documentos rotos cuando eran 49; y el backfill
juzgaba "ya coherente" mirando la pantalla en vez del campo que escribe, y dejó
111 órdenes sin `computed_total`.

**Un total que se llena no es un total que se mueve.** Separar siempre "no tenía
valor y ahora tiene" de "tenía otro valor". Mezclarlos convirtió 31 cambios
reales en un titular de 1.116.

**`src/scripts` está FUERA del type-check**, así que un `tsc` limpio no dice nada
de estos scripts. Y los `verify-*` son scripts de `medusa exec` con
`export default`: corridos con `tsx` **no ejecutan nada y salen 0**. Van así:

```bash
env DATABASE_URL="$(grep ^DATABASE_URL= .env|cut -d= -f2-)" \
  npx medusa exec ./src/scripts/verify/verify-order-total-qb-parity.ts
```

**Nada de `APPLY=true` de mi lado** — lo bloquea `bypass-guard`. Preparo el
script y lo corre el operador con `! <cmd>` y `CONFIRM=SI`.

**Si el operador dice "creo yo", eso es un pedido de verificación**, no un dato.
Anoche di por hecho una de esas y me lo cobró con razón.

## Herramientas que ya existen

```bash
cd backend

# la foto previa al fix sigue en la base
psql "$DATABASE_URL" -c "SELECT * FROM document_total_photo WHERE ref_number='E2087';"

# volver a comparar contra la foto en cualquier momento (read-only)
./node_modules/.bin/tsx src/scripts/checks/compare-totals-to-photo.ts

# ver qué derivaría una orden puntual, sin escribir nada
ONLY=S11132 ./node_modules/.bin/tsx src/scripts/fix/recompute-order-totals.ts

# backup nuevo antes de cualquier escritura
bash scripts/backup-prod-db.sh
```

Backup de antes del fix: `~/db-backups/ecopowertech-prod-20260730-025830.dump`
(17 MB, 242 tablas, restaurado y comprobado fila por fila contra prod).

## Suelto, para limpiar cuando haya un rato

- Base `restore_test` en el contenedor `sb_postgres` — era el banco de pruebas
  del backup, se puede borrar.
- El sandbox quedó con drafts consumidos por los E2E; `scripts/sandbox/restore.sh`.
- Fila del pipeline de QB trabada en `processing` desde el 4 de junio para E2087
  (seq 2185). Su TxnID `1C6998-1780588947` está verificado y es correcto, así que
  se puede confirmar sin riesgo. **No re-despachar** — sería un ADD duplicado.
- El deploy de Vercel del POS (`8e31048`) se pusheó sin esperar a que quedara
  activo. Vale confirmarlo.

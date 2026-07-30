# Prompt — reparar `verify-china-finance-bill-drift.ts` (10 aserciones en rojo)

_Escrito 2026-07-30 por la sesión que shipeó el reparto de un PO entre varios vendor bills.
Todos los números de acá se midieron **contra producción** ese día, read-only._

---

## Qué pasa

`src/scripts/verify/verify-china-finance-bill-drift.ts` sale **FAIL — 14 passed, 10 failed**.

Corrida correcta (es read-only por diseño; todas sus queries son `SELECT`):

```bash
cd backend
env DATABASE_URL="$(grep ^DATABASE_URL= .env | cut -d= -f2-)" \
  npx medusa exec ./src/scripts/verify/verify-china-finance-bill-drift.ts
```

⚠️ Es un script de `medusa exec` (`export default`). Corrido con `tsx` **no ejecuta nada y sale 0** —
el silencio de un verificador no es aprobación.

**No es una regresión del cambio del 2026-07-30.** Se corrió con y sin ese cambio
(stasheando sólo `src/lib/china-finance/bill-drift.ts`) y da **14/10 idéntico** en las dos.
También da idéntico en sandbox y en producción.

## Por qué se descompuso

El verificador se escribió en **un solo commit** (`498f44b2`) y **nunca se volvió a tocar**.
Congela "los veredictos que establecimos a mano mientras diagnosticábamos el crédito de $16,73"
— o sea, una foto de un día. Desde entonces:

- El **motor** (`src/lib/china-finance/bill-drift.ts`) cambió **5 veces**:
  `d6e6f030`, `ff523703`, `ea3a888a` (*"Fix fractional-cent vendor bill drift"* ← sospechoso
  principal para los casos 3 y 4 de abajo), `f0898985`, `efd9f62d`.
- Los **datos** también se movieron: alguien corrigió VB-1045 en producción.

Ninguno de esos 5 commits actualizó el verificador.

---

## Los 10 rojos son 3 historias, no 10 problemas

### Historia A — VB-1045 fue corregido → **8 de los 10 rojos** (mismo origen)

El fixture afirma que VB-1045 factura 50 unidades de `EAP-RM5-8S` contra un receipt de 25
(+$111,50 sobre-facturado, PAID, con el SKU nombrado). Medido hoy en producción:

```
EAP-RM5-8S   bill=25   recibido=25      ← ya no hay diferencia
(y las otras 8 líneas también empatan exactamente)
VB-1045 total = $3.025,00 · el motor dice: SIN DRIFT
```

Y eso arrastra a su bill de comisión:

```
VB-1046 (service) = $453,75 · SIN DRIFT
$453,75 ÷ 0,15 = $3.025,00 = exactamente lo que VB-1045 declara hoy
```

El fixture espera Δ −$16,73 e implied base $3.025,00. Fijate el detalle que lo delata: el
**$3.025,00 que el fixture esperaba como "lo que el agente implicaba"** es hoy **lo que VB-1045
realmente vale**. O sea que la corrección movió el bill de mercadería para que coincidiera con
la comisión que el agente ya había emitido. El crédito de $16,73 se resolvió.

→ **5 aserciones de VB-1045 + 3 de VB-1046 = 8.** Un solo evento.

### Historia B — VB-1054: una comisión de $1,76 que no existía cuando se escribió el fixture

```
VB-1054 (service) = $566,27  → implied base $3.775,13
VB-1053 (su bill de mercadería) declara $3.763,37
Δ = $1,76  (176 centavos, contra una tolerancia de 10)
```

El fixture dice *"no other commission bill is flagged (rounding tolerated)"*. **Ya no es cierto**,
y 176 centavos no son redondeo. Esto **no se arregla editando el fixture**: o el agente cobró
$1,76 de comisión de más, o VB-1053 se movió después de que el agente emitiera su factura.

Es una decisión contable, no técnica. VB-1053 además está **PAID por wire confirmado**, así que
corregirlo exige PIN de supervisor y la diferencia se vuelve un crédito contra el agente.

### Historia C — VB-1048: dos líneas con el MISMO SKU placeholder

```
VB-1048 = $3.246,58 · drift −$42,10 vs RCP-1107, RCP-1112
   Sample-Product: bill=1  source=2  Δ −$15,10
   Sample-Product: bill=1  source=2  Δ −$27,00
```

El fixture espera que este swap **netee a cero**; da −$42,10.

Mirá el nombre: **`Sample-Product` en las dos líneas**. Un bill receipt-pinned con varios receipts
usa **fallback por SKU** cuando el `purchase_order_line_id` no alcanza (ver el comentario de
`bill-drift.ts` sobre VB-1004). Dos productos distintos compartiendo un SKU placeholder es
exactamente el input que ese fallback no puede desambiguar. **Esta es la única de las tres que
puede ser un bug del motor**, y merece diagnóstico antes que cualquier edición de fixture.

---

## La trampa a evitar

Este repo ya se comió esta lección con los 17 unit tests rojos de junio
(`project_unit_suite_stale_specs_and_ci_gate.md`): **una aserción en rojo tiene dos lecturas
opuestas** —fixture viejo, o camino de producción roto— y elegir por lectura de código es adivinar.
Se decide **preguntándole a producción por el efecto**, que es lo que ya se hizo para la Historia A
y lo que falta para B y C.

**Borrar las aserciones rojas para poner el script en verde es el peor resultado posible**: deja el
verificador diciendo que verifica algo que ya no mira, que es cómo llegó acá.

## Qué se espera de la sesión nueva

1. **Historia A** — decidir entre re-basear los fixtures de VB-1045/VB-1046 contra el estado
   corregido, o retirarlos y reemplazarlos por un caso que el motor pueda seguir ejerciendo.
   Ojo: un fixture anclado a un bill de producción **vuelve a caducar** la próxima vez que alguien
   corrija ese bill. Evaluá si conviene un fixture sintético (sandbox) en vez de uno vivo.
2. **Historia B** — llevarle el $1,76 al owner: ¿el agente cobró de más, o VB-1053 se movió?
   No tocar nada hasta tener esa respuesta.
3. **Historia C** — diagnosticar el fallback por SKU con `Sample-Product` antes de decidir.
   Empezar por `git show ea3a888a` (*"Fix fractional-cent vendor bill drift"*), el commit del motor
   que más probablemente movió esta aritmética.
4. Sea cual sea el resultado, **el verificador tiene que quedar corriendo en algún gate**, o vuelve
   a envejecer en silencio. Hoy no lo corre nadie: el workflow `CI` (`unit-tests.yml`) corre
   `test:unit` y `type-check`, y los `verify-*` siguen siendo gate humano.

## Alcance sugerido

**Escribible:** `src/scripts/verify/verify-china-finance-bill-drift.ts` · fixtures nuevos si hacen
falta. `src/lib/china-finance/bill-drift.ts` **sólo** si la Historia C resulta ser un bug del motor,
y en ese caso con su propio plan.

**Prohibido sin decisión explícita del owner:** tocar VB-1045, VB-1046, VB-1048, VB-1053 o VB-1054
en producción · cualquier operación de QuickBooks · el PIN de supervisor · escribir en la DB de prod.

## Contexto que ya está resuelto y no hay que re-derivar

- El cambio del 2026-07-30 (`efd9f62d` / `ac2f2a6`, reparto de un PO entre varios regular vendor
  bills) **agregó** `severity`, `po_qty`, `bill_qty` y `siblings[]` a `BillDrift`, y hace `info` en
  vez de `warning` a los bills regulares SIN receipts que reclaman ≤ lo ordenado. Ninguno de los
  5 bills de este prompt cae en esa rama: los 5 son `receipt_lines` o `commission`, que quedaron
  intactos. Por eso el 14/10 es idéntico con y sin el cambio.
- Drift es **display-only**: `loadBillDrift`/`describeDrift` los consumen dos rutas y este
  verificador. Ningún camino de dinero los lee (`bill-delta-engine.ts`,
  `recompute-bill-finance.ts`, el confirm: cero menciones). Un veredicto equivocado desinforma
  a un humano; no mueve plata sola.

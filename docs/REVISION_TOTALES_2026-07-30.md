# Documentos a revisar tras el fix de totales — 2026-07-30

Generado al cierre del despliegue del fix de totales de orden.
Backend `e0e0acd0` · store-pos `8e31048` · foto `document_total_photo` (2.752 filas).

## Cómo leer esto

El fix hizo que el total de un documento se derive de sus propias líneas en vez de
parchearse a mano. **2.696 de 2.752 documentos conservaron exactamente el total que
el cliente ya tenía** — incluidas las 1.224 facturas, que no se movió ninguna.

Quedan dos grupos, y son problemas distintos:

- **Grupo A (12)** — el script NO las tocó. Su derivación contradice una factura ya
  emitida, y la factura es el registro contable. Lo que está mal en ellas son las
  LÍNEAS, no el total.
- **Grupo B (49)** — sí se recalcularon, y el número nuevo difiere del que se mostraba
  antes. Ninguna es automáticamente un error: en E2087 el número nuevo es el que dice
  QuickBooks. Cada una necesita una decisión.

Nada de esto bloquea el sistema hoy: los totales que se muestran son coherentes entre
listado y documento en los tres casos.

---

## Grupo A — protegidas, sin modificar (12)

El guard las frenó comparando contra la factura. `derivado` es lo que habrían pasado
a mostrar si no se las protegía.

| Doc | Factura | Estado | Total factura | Derivado | Δ | Cobrado | Líneas ord/fact | Días |
|---|---|---|---|---:|---:|---:|:---:|---:|
| **S10008** | 20012 | paid | $55.99 | $59.91 | +3.92 | $55.99 | 1/1 | 106 |
| **S10010** | 20011 | paid | $479.72 | $513.30 | +33.58 | $479.72 | 4/4 | 106 |
| **S10012** | 20010 | paid | $441.97 | $471.16 | +29.19 | $441.97 | 4/4 | 106 |
| **S10255** | 20246 | paid | $4,982.46 | $4,981.98 | -0.48 | $4,982.46 | 10/10 | 90 |
| **S10261** | 20387 | paid | $5,885.85 | $5,885.81 | -0.04 | $5,885.85 | 7/7 | 91 |
| **S10279** | 20315 | issued | $468.46 | $468.44 | -0.02 | $0.00 | 7/7 | 85 |
| **S10315** | 20333 | paid | $3,492.89 | $3,492.85 | -0.04 | $3,492.89 | 4/4 | 97 |
| **S10354** | 20340 | paid | $1,644.85 | $1,644.88 | +0.03 | $1,644.85 | 6/6 | 78 |
| **S10389** | 20373 | paid | $588.74 | $588.71 | -0.03 | $588.74 | 6/6 | 76 |
| **S10464** | 20446 | paid | $870.82 | $870.80 | -0.02 | $870.82 | 7/7 | 69 |
| **S11132** | 21142 | issued | $852.60 | $1,705.20 | +852.60 | $0.00 | 1/1 | 13 |
| **S11144** | 21116 | paid | $185.81 | $288.44 | +102.63 | $185.81 | 5/5 | 11 |

### Lo que ya se sabe de este grupo

- **S10008 / S10010 / S10012** (14 abril, las tres) — la factura cobró **tax cero**
  sobre líneas marcadas gravables, y el cliente pagó ese total sin tax. La orden
  todavía arrastra el tax, y de ahí sale un saldo fantasma que nunca se cobró.
  Hay un script preparado y sin correr para esto: `src/scripts/fix/align-line-taxable-to-billed.ts`,
  que baja el flag `taxable` de esas líneas para que la derivación reproduzca lo facturado.
- **S11132** ($852,60 contra $1.705,20) — el derivado es **exactamente el doble**. Huele
  a cantidad duplicada o a una línea contada dos veces, no a un problema de tax.
- **S11144** ($185,81 contra $288,44) — NO es parcial: 5 líneas en la orden y 5 en la
  factura, y está pagada por $185,81. Los $102,63 de diferencia no tienen explicación
  todavía.
- **S10255, S10261, S10279, S10315, S10354, S10389, S10464** — diferencias de 2 a 48
  centavos, todas con las líneas completas facturadas. Es el caso de redondeo de
  descuentos porcentuales. Verificar contra QB antes de tocar nada: la regla de
  redondeo ya se comprobó contra QuickBooks en cuatro presupuestos y ganó la de
  redondear la LÍNEA, así que puede que el centavo esté del lado de la factura vieja.
- **S10279** es la única del grupo con la factura `issued` y **cobrado $0,00** — no se
  pagó, así que ahí hay más margen para corregir que en las que ya cobraron.

---

## Grupo B — recalculadas, el total mostrado cambió (49)

`antes` es lo que mostraba la pantalla al momento de la foto; `ahora` es lo que
muestra tras el fix.

| Doc | Tipo | Fecha | Antes | Ahora | Δ |
|---|---|---|---:|---:|---:|
| **E1903** | estimate | May 21 2026 | $12,155.34 | $12,732.74 | +577.40 |
| **S10447** | order | May 06 2026 | $9,022.26 | $9,539.61 | +517.35 |
| **E1845** | estimate | May 18 2026 | $37,297.77 | $36,936.02 | -361.75 |
| **E1916** | estimate | May 22 2026 | $6,134.52 | $6,350.44 | +215.92 |
| **S10578** | order | Jun 01 2026 | $206.68 | $0.00 | -206.68 |
| **E1938** | estimate | May 26 2026 | $11,434.60 | $11,229.67 | -204.93 |
| **E2541** | estimate | Jul 03 2026 | $2,265.00 | $2,401.50 | +136.50 |
| **E2563** | estimate | Jul 07 2026 | $6,249.34 | $6,161.84 | -87.50 |
| **E1910** | estimate | May 22 2026 | $4,250.45 | $4,176.95 | -73.50 |
| **E2070** | estimate | Jun 03 2026 | $3,599.46 | $3,531.21 | -68.25 |
| **E2087** | estimate | Jun 04 2026 | $4,014.03 | $3,952.61 | -61.42 |
| **E1802** | estimate | May 14 2026 | $3,504.00 | $3,444.61 | -59.39 |
| **S10109** | order | Apr 22 2026 | $824.80 | $774.15 | -50.65 |
| **E2110** | estimate | Jun 05 2026 | $2,788.08 | $2,751.33 | -36.75 |
| **S10158** | order | Apr 24 2026 | $498.15 | $530.24 | +32.09 |
| **E2109** | estimate | Jun 05 2026 | $2,298.31 | $2,268.56 | -29.75 |
| **S10696** | order | Jun 10 2026 | $-0.01 | $25.15 | +25.16 |
| **S10040** | order | Apr 16 2026 | $396.35 | $372.01 | -24.34 |
| **E2542** | estimate | Jul 03 2026 | $2,760.60 | $2,737.50 | -23.10 |
| **E1751** | estimate | May 11 2026 | $586.54 | $568.42 | -18.12 |
| **S10006** | order | Apr 14 2026 | $242.99 | $228.07 | -14.92 |
| **S10079** | order | Apr 20 2026 | $214.89 | $201.70 | -13.19 |
| **order_01KY7GF0GQAG** | estimate | Jul 23 2026 | $168.98 | $180.81 | +11.83 |
| **order_01KXGTEYTC4D** | estimate | Jul 14 2026 | $155.72 | $166.62 | +10.90 |
| **S10025** | order | Apr 15 2026 | $119.11 | $111.80 | -7.31 |
| **S10123** | order | Apr 22 2026 | $114.26 | $107.24 | -7.02 |
| **S10013** | order | Apr 14 2026 | $113.98 | $106.98 | -7.00 |
| **S10105** | order | Apr 22 2026 | $95.42 | $89.56 | -5.86 |
| **S10070** | order | Apr 18 2026 | $163.68 | $159.58 | -4.10 |
| **E2562** | estimate | Jul 07 2026 | $280.70 | $277.20 | -3.50 |
| **S10981** | order | Jul 01 2026 | $45.79 | $42.79 | -3.00 |
| **S10106** | order | Apr 22 2026 | $29.63 | $27.81 | -1.82 |
| **S10083** | order | Apr 20 2026 | $172.61 | $174.41 | +1.80 |
| **S10035** | order | Apr 15 2026 | $26.79 | $25.15 | -1.64 |
| **E1497** | estimate | Apr 23 2026 | $31,730.09 | $31,730.72 | +0.63 |
| **E1628** | estimate | Apr 30 2026 | $17,766.50 | $17,766.23 | -0.27 |
| **E1723** | estimate | May 08 2026 | $6,234.06 | $6,234.30 | +0.24 |
| **E1976** | estimate | May 28 2026 | $4,829.46 | $4,829.22 | -0.24 |
| **S11185** | order | Jul 22 2026 | $137.70 | $137.91 | +0.21 |
| **E1977** | estimate | May 28 2026 | $3,047.16 | $3,047.01 | -0.15 |
| **E1885** | estimate | May 20 2026 | $2,806.61 | $2,806.67 | +0.06 |
| **S10036** | order | Apr 15 2026 | $0.96 | $0.90 | -0.06 |
| **E1904** | estimate | May 21 2026 | $7,731.76 | $7,731.72 | -0.04 |
| **E1667** | estimate | May 05 2026 | $3,381.16 | $3,381.18 | +0.02 |
| **E1968** | estimate | May 28 2026 | $6,737.14 | $6,737.16 | +0.02 |
| **E1647** | estimate | May 01 2026 | $5,634.17 | $5,634.18 | +0.01 |
| **E2106** | estimate | Jun 05 2026 | $5,986.09 | $5,986.08 | -0.01 |
| **S10948** | order | Jun 29 2026 | $280.70 | $280.69 | -0.01 |
| **S11284** | order | Jul 29 2026 | $1,342.58 | $1,342.57 | -0.01 |

### Lo que ya se sabe de este grupo

- **E2087** ($4.014,03 → $3.952,61) — **el número nuevo es el correcto y está verificado
  contra QuickBooks**, que dice $3.952,61 exacto. El viejo le cobraba 7% también al
  servicio de instalación de $1.170, que es exento. Sirve de patrón para el resto.
- **S10578** ($206,68 → $0,00) — correcto. Su factura es de $0,00, su única línea tiene
  precio 0 y el cobrado es $0,00. El $206,68 era el dato falso.
- **28 de las 49 son presupuestos**, y la mayoría tiene más de 30 días, o sea que están
  fuera de su validez y pueden moverse libremente según la regla del negocio.
- Las diferencias grandes que faltan mirar: **E1903** (+$577,40), **S10447** (+$517,35),
  **E1845** (−$361,75), **E1916** (+$215,92), **E1938** (−$204,93).

---

## Cómo reproducir cualquiera de estos números

```bash
cd backend
# la foto previa sigue en la base
psql "$DATABASE_URL" -c "SELECT * FROM document_total_photo WHERE ref_number='E2087';"

# volver a comparar en cualquier momento (read-only)
./node_modules/.bin/tsx src/scripts/checks/compare-totals-to-photo.ts

# ver qué derivaría una orden puntual, sin escribir
ONLY=S11132 ./node_modules/.bin/tsx src/scripts/fix/recompute-order-totals.ts
```

Backup verificado de antes del fix: `~/db-backups/ecopowertech-prod-20260730-025830.dump`
(17 MB, 242 tablas, restaurado y comprobado contra prod fila por fila).


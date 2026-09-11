/**
 * Helpers de dinero del GL. Las columnas de dinero del POS ya guardan CENTS
 * (regla `.claude/rules/medusa-core.md` 2026-08-07), pero el driver `pg` las
 * entrega como STRING numeric — nunca `number` — así que todo lector coerciona
 * acá antes de aritmética. `average_unit_cost` es la única excepción: vive en
 * DÓLARES y se redondea a centavos por línea con half-up.
 */

/**
 * "12345" | "12345.00" | 12345 | "-45" → BigInt del valor tal cual llega: la
 * columna YA guarda CENTS (regla 2026-08-07), así que acá NO se multiplica
 * por 100 — sólo se coacciona el string/number del driver `pg` a BigInt,
 * redondeando cualquier resto fraccionario espurio (las columnas son enteras
 * en la práctica; un `numeric` con escala > 0 nunca debería traer uno).
 */
export function centsFromNumeric(
  value: string | number | null | undefined
): bigint {
  if (value === null || value === undefined) return 0n;
  const str = typeof value === "number" ? value.toString() : value.trim();
  if (str === "") return 0n;
  const negative = str.startsWith("-");
  const unsigned = negative ? str.slice(1) : str;
  const [intPart = "", fracPart = ""] = unsigned.split(".");
  let whole = BigInt(intPart.replace(/[^0-9]/g, "") || "0");
  const firstFracDigit = fracPart.replace(/[^0-9]/g, "")[0];
  if (firstFracDigit && Number(firstFracDigit) >= 5) whole += 1n;
  return negative ? -whole : whole;
}

/**
 * `average_unit_cost × quantity` en dólares → centavos, redondeo half-up POR
 * LÍNEA (nunca se acumula en dólares y se redondea al final). Costo NULL/0/
 * cantidad<=0 → 0 (sin línea de COGS, la regla del plan §2).
 */
export function costCentsHalfUp(
  unitCostDollars: string | number | null | undefined,
  quantity: number
): bigint {
  if (unitCostDollars === null || unitCostDollars === undefined) return 0n;
  const dollars =
    typeof unitCostDollars === "number"
      ? unitCostDollars
      : Number(unitCostDollars);
  if (!Number.isFinite(dollars) || dollars <= 0 || quantity <= 0) return 0n;
  const centsFloat = dollars * quantity * 100;
  return BigInt(Math.round(centsFloat));
}

export function absBigInt(v: bigint): bigint {
  return v < 0n ? -v : v;
}

/**
 * Reparto por MAYOR RESTO (largest remainder): centavos enteros
 * proporcionales a `weights`, cuya suma da EXACTAMENTE `total` — sin línea de
 * redondeo. `weights` y `total` no-negativos; si `Σweights === 0` cae a
 * reparto igualitario vía `allocateEqually`.
 */
export function allocateLargestRemainder(
  weights: bigint[],
  total: bigint
): bigint[] {
  const sumWeights = weights.reduce((a, b) => a + b, 0n);
  if (sumWeights === 0n) return allocateEqually(weights.length, total);

  const shares: bigint[] = new Array(weights.length).fill(0n);
  const remainders: { index: number; remainder: bigint }[] = [];
  let allocated = 0n;
  weights.forEach((w, index) => {
    const product = w * total;
    const base = product / sumWeights; // floor (weights/total no-negativos)
    shares[index] = base;
    remainders.push({ index, remainder: product % sumWeights });
    allocated += base;
  });

  let leftover = total - allocated;
  remainders.sort((a, b) =>
    b.remainder > a.remainder ? 1 : b.remainder < a.remainder ? -1 : a.index - b.index
  );
  for (const r of remainders) {
    if (leftover <= 0n) break;
    shares[r.index] = (shares[r.index] ?? 0n) + 1n;
    leftover -= 1n;
  }
  return shares;
}

/** Reparto igualitario de `total` en `n` partes enteras, Σ === total. */
export function allocateEqually(n: number, total: bigint): bigint[] {
  if (n <= 0) return [];
  const base = total / BigInt(n);
  const remainder = total - base * BigInt(n);
  return Array.from({ length: n }, (_, i) => base + (BigInt(i) < remainder ? 1n : 0n));
}

/**
 * bigint/number cents → dollar string with exactly 2 decimals, for QBXML
 * `<Amount>`/`<PaymentAmount>`/`<AppliedAmount>` fields (gl-purchases-v2 §4).
 * Never float math on the cents themselves — only the final /100 division,
 * which is exact for an integer numerator at 2 decimal places.
 */
export function centsToDollarsString(cents: bigint | number): string {
  const n = typeof cents === "bigint" ? cents : BigInt(Math.round(cents));
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const dollars = abs / 100n;
  const remainder = abs % 100n;
  const str = `${negative ? "-" : ""}${dollars.toString()}.${remainder.toString().padStart(2, "0")}`;
  return str;
}

/**
 * gl-purchases-v2: una línea de journal cuyo LADO lo decide el signo del
 * monto — positivo debita `account`, negativo la credita por su valor
 * absoluto, cero omite la línea entera (evita el CHECK "un solo lado > 0"
 * de `validateLines`, igual que el caso `total = 0` de `buildInvoiceLines`).
 * Import type inline para no crear un ciclo con `types.ts`.
 */
export function signedLine(
  role: string,
  account: import("./types").LedgerAccount,
  cents: bigint
): import("./types").LedgerLine | null {
  if (cents === 0n) return null;
  return cents > 0n
    ? { role, account, debit_cents: cents, credit_cents: 0n }
    : { role, account, debit_cents: 0n, credit_cents: -cents };
}

/**
 * `bank_journal_line.role` tiene el CHECK `^[a-z][a-z0-9_]{0,79}$` (gl-core-v1
 * §4) — un role dinámico por cuenta (líneas `qb_account` de vendor bills/
 * credits, gl-purchases-v2) arma su sufijo desde un `qb_list_id` REAL como
 * `"8000018A-1786738459"`: mayúscula y guión, ambos ilegales. Minúsculas +
 * todo lo que no sea `[a-z0-9]` a `_`; el prefijo ya garantiza que arranca
 * con letra.
 */
export function sanitizeRole(prefix: string, id: string): string {
  const suffix = id.toLowerCase().replace(/[^a-z0-9]/g, "_");
  return `${prefix}_${suffix}`.slice(0, 80);
}

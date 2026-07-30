/**
 * E2E — el total de un documento a lo largo de su vida, contra QuickBooks.
 *
 * Replica en el SANDBOX documentos reales cuyo total en QuickBooks ya conocemos
 * (leído del bridge el 2026-07-30 y congelado en
 * `docs/qb-ground-truth-2026-07-30.json`), y los hace recorrer el ciclo entero:
 *
 *     crear estimado → convertir a orden → editar (agregar ítem) → deshacer
 *
 * Dos aserciones por documento, y las dos importan:
 *
 *   1. CONTRA QUICKBOOKS — en cada etapa el total es el que QB facturó.
 *   2. ENTRE ETAPAS — el total no se movió. Un estimado que el cliente aprobó
 *      y que cambia de valor al convertirse es un problema de negocio, no un
 *      detalle de redondeo: el cliente firmó un número.
 *
 * Por qué el set sirve como test y no sólo como muestra: S11242 es el único
 * documento donde las dos convenciones de redondeo del descuento dan distinto
 * (por línea 138.07 → 1699.07, que es lo que QB facturó; agregada 138.08 →
 * 1699.06). Si alguien revierte el fix de `loadOrderMoneyBase`, este documento
 * lo delata solo. Sin él, el test pasaría con el bug puesto.
 *
 * NO toca QuickBooks: el bridge está apagado en el sandbox y este script no le
 * habla. Lee producción SÓLO para copiar la receta (SELECT), y escribe
 * únicamente en la base del sandbox.
 *
 * Run:
 *   cd backend && ./node_modules/.bin/tsx src/scripts/tests/e2e-total-lifecycle-sandbox.ts
 *   DOCS=S11242,S11064 ./node_modules/.bin/tsx src/scripts/tests/e2e-total-lifecycle-sandbox.ts
 */
import { readFileSync, writeFileSync } from "fs";

import { Pool } from "pg";

const SANDBOX_DB =
  process.env.SANDBOX_DATABASE_URL ??
  "postgresql://postgres:sandbox@localhost:5499/medusa";
const SANDBOX_API = process.env.SANDBOX_API ?? "http://localhost:9099";
const TEST_EMAIL = process.env.SANDBOX_EMAIL ?? "sandbox@test.com";
const TEST_PASSWORD = process.env.SANDBOX_PASSWORD ?? "sandbox123";
const CENT = 0.005;

/** Documentos a replicar. Los 18 que hoy coinciden con QB, más los 2 especiales. */
const DEFAULT_DOCS = [
  "S11179", "S10897", "S11167", "S11241", "S11064", "S10737",
  "S11242", "S11243", "S10671", "S10949", "S10612", "S11284",
  "S11210", "S10810", "S11042", "S11132", "S11195", "S10948",
  "S11018", "S11177",
];

/**
 * Ninguno se espera en rojo.
 *
 * S11132 estuvo acá listado como "computed_total es el doble de su factura",
 * heredado de una nota del 2026-07-30. NO era un defecto: la línea pide 40
 * unidades y tiene 20 facturadas, así que la orden vale $1705.20 y su factura
 * parcial $852.60. Las dos cifras son correctas y el "doble" era el síntoma de
 * comparar una ORDEN contra una FACTURA PARCIAL. QuickBooks lo dice él mismo en
 * el Sales Order 6424: `qty 40 · amount 1705.20 · Invoiced 20`.
 *
 * De ahí sale la regla de `pickQbDoc`, y de ahí sale también la advertencia:
 * un "fallo esperado" heredado sin verificar es una forma de normalizar un
 * número equivocado. Se verifica o no se declara.
 */
const KNOWN_BAD: Record<string, string> = {};

type QbDoc = {
  kind: string;
  ref: string;
  txnId: string;
  discount: number;
  tax: string | null;
  total: string | null;
};

type Recipe = {
  doc: string;
  customerId: string | null;
  taxMode: string | null;
  discountType: string | null;
  discountValue: number | null;
  qbTotal: number;
  qbTax: number;
  qbDiscount: number;
  qbRef: string;
  /**
   * El envío es parte del total y no se puede omitir al replicar: S10612 lleva
   * "Uber $30" y la primera versión de este script mandaba shipping 0, así que
   * el documento salía $30 por debajo de QuickBooks EN TODAS las etapas. Se
   * leía como un defecto del cálculo y era una línea que yo no copiaba.
   */
  shippingOptionId: string | null;
  shippingPrice: number;
  lines: {
    variantId: string;
    quantity: number;
    unitPrice: number;
    originalUnitPrice: number | null;
    lineDiscount: unknown | null;
    title: string;
  }[];
};

function prodUrl(): string {
  const fromEnv = process.env.PROD_DATABASE_URL;
  if (fromEnv) return fromEnv;
  const env = readFileSync("./.env", "utf8");
  const line = env.split("\n").find((l) => l.startsWith("DATABASE_URL="));
  if (!line) throw new Error("no DATABASE_URL en backend/.env");
  return line.slice("DATABASE_URL=".length).trim();
}

async function login(): Promise<string> {
  const r = await fetch(`${SANDBOX_API}/auth/user/emailpass`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  if (!r.ok) throw new Error(`login sandbox falló (${r.status})`);
  const j = (await r.json()) as { token: string };
  return j.token;
}

async function api<T>(
  token: string,
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<T> {
  const r = await fetch(`${SANDBOX_API}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const txt = await r.text();
  if (!r.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} → ${r.status}: ${txt.slice(0, 400)}`);
  }
  return (txt ? JSON.parse(txt) : {}) as T;
}

async function loadRecipes(docs: string[]): Promise<Recipe[]> {
  const qb: QbDoc[] = JSON.parse(
    readFileSync("./docs/qb-ground-truth-2026-07-30.json", "utf8")
  );
  const byTxn = new Map(qb.map((q) => [q.txnId, q]));
  const prod = new Pool({
    connectionString: prodUrl(),
    ssl: { rejectUnauthorized: false },
  });
  const out: Recipe[] = [];
  try {
    for (const doc of docs) {
      const head = await prod.query<{
        id: string;
        customer_id: string | null;
        tax_mode: string | null;
        discount_type: string | null;
        discount_value: string | null;
        partial: boolean;
        txn_ids: string[] | null;
      }>(
        `SELECT o.id, o.customer_id,
                o.metadata->>'tax_mode'       AS tax_mode,
                o.metadata->>'discount_type'  AS discount_type,
                o.metadata->>'discount_value' AS discount_value,
                -- Parcialmente facturada = alguna línea tiene menos unidades
                -- facturadas que pedidas. En ese caso su invoice cubre parte
                -- de la orden y NO puede ser el patrón del total.
                EXISTS (SELECT 1 FROM order_item oi
                         WHERE oi.order_id = o.id AND oi.version = o.version
                           AND oi.deleted_at IS NULL
                           AND COALESCE(oi.fulfilled_quantity, 0) < oi.quantity)
                  AS partial,
                ARRAY(SELECT p.qb_txn_id FROM qb_order_pipeline p
                       WHERE p.order_id = o.id AND p.status = 'confirmed'
                         AND p.step IN ('invoice','sales_receipt','sales_order')) AS txn_ids
           FROM "order" o
          WHERE o.metadata->>'document_number' = $1
          LIMIT 1`,
        [doc]
      );
      const h = head.rows[0];
      if (!h) {
        console.log(`  ⏭️  ${doc} — no existe en producción`);
        continue;
      }
      // Qué documento de QuickBooks representa a la ORDEN ENTERA.
      //
      // Una orden parcialmente facturada tiene un invoice que cubre sólo lo
      // despachado; su Sales Order es el que lleva el pedido completo. Preferir
      // siempre el invoice hacía que S11132 pareciera valer el doble de lo que
      // debía, cuando lo que pasaba es que la mitad de la orden todavía no se
      // facturó — y QuickBooks lo dice explícito en la línea del SO:
      // `qty 40 · Invoiced 20`.
      const found = (h.txn_ids ?? [])
        .map((t) => byTxn.get(t))
        .filter((x): x is QbDoc => Boolean(x) && x!.total != null);
      const rank = (k: string) =>
        h.partial
          ? k === "sales_order"
            ? 0
            : 1
          : k === "sales_order"
            ? 1
            : 0;
      const q = [...found].sort((a, b) => rank(a.kind) - rank(b.kind))[0];
      if (!q || q.total == null) {
        console.log(`  ⏭️  ${doc} — sin verdad de QB en el JSON`);
        continue;
      }
      if (h.partial && q.kind !== "sales_order") {
        console.log(
          `  ⚠️  ${doc} — parcialmente facturada y sin Sales Order en el JSON; ` +
            `se compara contra ${q.kind} ${q.ref}, que cubre sólo una parte`
        );
      }
      const lines = await prod.query<{
        variant_id: string | null;
        quantity: string;
        unit_price: string;
        orig: string | null;
        line_discount: string | null;
        title: string | null;
      }>(
        `SELECT li.variant_id, oi.quantity, li.unit_price,
                NULLIF(li.metadata->>'original_unit_price','') AS orig,
                li.metadata->>'line_discount' AS line_discount,
                li.title
           FROM "order" o
           JOIN order_item oi ON oi.order_id = o.id AND oi.version = o.version
                             AND oi.deleted_at IS NULL
           JOIN order_line_item li ON li.id = oi.item_id
          WHERE o.id = $1
          ORDER BY li.id`,
        [h.id]
      );
      const usable = lines.rows.filter((l) => l.variant_id);
      if (usable.length === 0) {
        console.log(`  ⏭️  ${doc} — sin líneas con variante`);
        continue;
      }
      const ship = await prod.query<{ opt: string | null; amt: string | null }>(
        `SELECT sm.shipping_option_id AS opt, sm.amount AS amt
           FROM order_shipping os
           JOIN order_shipping_method sm ON sm.id = os.shipping_method_id
          WHERE os.order_id = $1 AND os.deleted_at IS NULL
            AND os.version = (SELECT o.version FROM "order" o WHERE o.id = $1)
          LIMIT 1`,
        [h.id]
      );
      out.push({
        doc,
        shippingOptionId: ship.rows[0]?.opt ?? null,
        shippingPrice: Number(ship.rows[0]?.amt ?? 0),
        customerId: h.customer_id,
        taxMode: h.tax_mode,
        discountType: h.discount_type,
        discountValue: h.discount_value == null ? null : Number(h.discount_value),
        qbTotal: Number(q.total),
        qbTax: Number(q.tax ?? 0),
        qbDiscount: Number(q.discount ?? 0),
        qbRef: `${q.kind} ${q.ref}`,
        lines: usable.map((l, i) => ({
          variantId: l.variant_id as string,
          quantity: Number(l.quantity),
          unitPrice: Number(l.unit_price),
          originalUnitPrice: l.orig == null ? null : Number(l.orig),
          lineDiscount: l.line_discount ? JSON.parse(l.line_discount) : null,
          title: l.title ?? `line ${i}`,
        })),
      });
    }
  } finally {
    await prod.end();
  }
  return out;
}

/** El total que la aplicación muestra, leído como lo lee `/orders`. */
async function readTotals(
  sb: Pool,
  orderId: string
): Promise<{ computed: number | null; summary: number | null; pos: number | null }> {
  const { rows } = await sb.query<{
    c: string | null;
    s: string | null;
    p: string | null;
  }>(
    `SELECT NULLIF(o.metadata->>'computed_total','')     AS c,
            NULLIF(os.totals->>'current_order_total','') AS s,
            NULLIF(o.metadata->>'pos_total','')          AS p
       FROM "order" o
       LEFT JOIN order_summary os
         ON os.order_id = o.id AND os.version = o.version
      WHERE o.id = $1`,
    [orderId]
  );
  const r = rows[0];
  const n = (v: string | null | undefined) => (v == null ? null : Number(v));
  return { computed: n(r?.c), summary: n(r?.s), pos: n(r?.p) };
}

type Stage = {
  name: string;
  total: number | null;
  /**
   * Presente sólo en la etapa que DEBE mover el total (agregar un ítem). Sin
   * esto, "no se movió" se lee como éxito justo cuando la edición no corrió.
   */
  mustDifferFrom?: number;
};

async function runOne(
  token: string,
  sb: Pool,
  r: Recipe
): Promise<{ doc: string; stages: Stage[]; errors: string[] }> {
  const errors: string[] = [];
  const stages: Stage[] = [];

  // ── 1. Crear el estimado con la receta original ─────────────────────────
  const created = await api<{ draft_order_id: string }>(
    token,
    "/admin/draft-orders/sync-pos",
    {
      method: "POST",
      body: {
        action: "create",
        id: null,
        payload: {
          email: "sandbox@test.com",
          ...(r.customerId ? { customer_id: r.customerId } : {}),
          metadata: {
            pos_created: true,
            document_number: `${r.doc}-E2E`,
            ...(r.taxMode ? { tax_mode: r.taxMode } : {}),
            ...(r.discountType ? { discount_type: r.discountType } : {}),
            ...(r.discountValue != null
              ? { discount_value: r.discountValue }
              : {}),
          },
        },
        items: r.lines.map((l, i) => ({
          localId: `l${i}`,
          variantId: l.variantId,
          quantity: l.quantity,
          // El net con el que la línea fue guardada. Es lo que el POS manda y
          // lo que hace que una línea ya emitida no se re-precie.
          effectiveUnitPrice: l.unitPrice,
          unitPrice: l.originalUnitPrice ?? l.unitPrice,
          lineDiscount: l.lineDiscount,
          title: l.title,
          salesDescription: "",
          sortOrder: i,
          priceListId: null,
          priceListLabel: "Default",
        })),
        ...(r.shippingOptionId
          ? { shipping_option_id: r.shippingOptionId }
          : {}),
        shipping_price: r.shippingPrice,
        // El descuento de orden entra por el mismo camino que el POS.
        ...(r.discountType && (r.discountValue ?? 0) > 0
          ? {
              promotion_code: `E2E-${r.doc}`,
              discount_type: r.discountType,
              discount_value: r.discountValue,
            }
          : {}),
        customer_id: r.customerId,
      },
    }
  );
  const id = created.draft_order_id;

  await api(token, `/admin/draft-orders/${id}/compute-tax`);
  stages.push({ name: "estimado", total: (await readTotals(sb, id)).computed });

  // ── 2. Convertir a orden ────────────────────────────────────────────────
  try {
    await api(token, `/admin/draft-orders/${id}/convert-force`, {
      method: "POST",
      body: {},
    });
    const t = await readTotals(sb, id);
    stages.push({ name: "convertida", total: t.computed ?? t.summary });
  } catch (e) {
    errors.push(`convert: ${(e as Error).message}`);
    stages.push({ name: "convertida", total: null });
    return { doc: r.doc, stages, errors };
  }

  // ── 3. Editar: agregar una línea y volver a sincronizar ─────────────────
  //
  // El sync se manda con el MISMO cuerpo que manda el POS. Con `{skip_qb}` a
  // secas la ruta no re-deriva nada, así que la etapa de edición pasaba sin
  // haber ejercitado el cálculo: el primer intento de este test dio verde con
  // el bug puesto. Un assert de "no se movió" necesita que el sistema haya
  // QUERIDO moverlo.
  const extra = r.lines[0];
  const posBody = (tax: number, total: number) => ({
    skip_qb: true,
    pos_total: total,
    pos_tax_amount: tax,
    pos_tax_rate: r.taxMode === "exempt" ? 0 : 7,
    pos_discount_amount: r.qbDiscount,
    ...(r.discountType && (r.discountValue ?? 0) > 0
      ? { discount_type: r.discountType, discount_value: r.discountValue }
      : {}),
  });

  let addedItemId: string | null = null;
  const beforeEdit = stages[stages.length - 1]?.total ?? r.qbTotal;
  try {
    const before = await sb.query<{ id: string }>(
      `SELECT li.id FROM "order" o
         JOIN order_item oi ON oi.order_id = o.id AND oi.version = o.version
                           AND oi.deleted_at IS NULL
         JOIN order_line_item li ON li.id = oi.item_id
        WHERE o.id = $1`,
      [id]
    );
    const beforeIds = new Set(before.rows.map((x) => x.id));

    await api(token, `/admin/orders/${id}/add-item-force`, {
      method: "POST",
      body: {
        variant_id: extra.variantId,
        quantity: 1,
        unit_price: extra.unitPrice,
        custom_title: `${extra.title} (E2E)`,
      },
    });

    const after = await sb.query<{ id: string }>(
      `SELECT li.id FROM "order" o
         JOIN order_item oi ON oi.order_id = o.id AND oi.version = o.version
                           AND oi.deleted_at IS NULL
         JOIN order_line_item li ON li.id = oi.item_id
        WHERE o.id = $1`,
      [id]
    );
    const fresh = after.rows.map((x) => x.id).filter((x) => !beforeIds.has(x));
    // CONTROL POSITIVO: si la línea no entró, todo lo que siga mide otra cosa.
    if (fresh.length !== 1) {
      throw new Error(
        `add-item-force no agregó exactamente una línea (agregó ${fresh.length}) — ` +
          `la etapa de edición no probaría nada`
      );
    }
    addedItemId = fresh[0];

    await api(token, `/admin/orders/${id}/post-edit-sync`, {
      method: "POST",
      body: posBody(r.qbTax, r.qbTotal + extra.unitPrice),
    });
    const t = await readTotals(sb, id);
    stages.push({
      name: "con ítem extra",
      total: t.computed ?? t.summary,
      mustDifferFrom: beforeEdit,
    });
  } catch (e) {
    errors.push(`add-item: ${(e as Error).message}`);
    stages.push({ name: "con ítem extra", total: null });
  }

  // ── 4. Deshacer la edición: el total tiene que VOLVER ───────────────────
  if (addedItemId) {
    try {
      await api(token, `/admin/orders/${id}/delete-item-force`, {
        method: "POST",
        body: { line_item_id: addedItemId },
      });
      await api(token, `/admin/orders/${id}/post-edit-sync`, {
        method: "POST",
        body: posBody(r.qbTax, r.qbTotal),
      });
      const t = await readTotals(sb, id);
      stages.push({ name: "revertida", total: t.computed ?? t.summary });
    } catch (e) {
      errors.push(`delete-item: ${(e as Error).message}`);
      stages.push({ name: "revertida", total: null });
    }
  }

  return { doc: r.doc, stages, errors };
}

/**
 * El CUARTO camino: una orden creada directamente, sin pasar por un estimado.
 *
 * No es una variante del mismo flujo — es una secuencia distinta de llamadas.
 * `useOrderActions.ts` crea un draft VACÍO, le mete los ítems con
 * `add-item-force`, aplica el descuento y recién entonces llama a
 * `convert-force` (paso 7). Nunca pasa por `compute-tax`, así que el total lo
 * produce enteramente `convert-force`. Si ese camino no escribiera
 * `computed_total`, la orden nacería sin el campo que la lista lee primero.
 */
async function runDirect(
  token: string,
  sb: Pool,
  r: Recipe
): Promise<number | null> {
  const regions = await api<{ regions: { id: string }[] }>(
    token,
    "/admin/regions?limit=1"
  );
  const created = await api<{ draft_order: { id: string } }>(
    token,
    "/admin/draft-orders",
    {
      method: "POST",
      body: {
        email: TEST_EMAIL,
        region_id: regions.regions[0]?.id,
        customer_id: r.customerId,
        items: [],
        metadata: {
          pos_created: true,
          ...(r.taxMode ? { tax_mode: r.taxMode } : {}),
          ...(r.discountType ? { discount_type: r.discountType } : {}),
          ...(r.discountValue != null
            ? { discount_value: r.discountValue }
            : {}),
        },
      },
    }
  );
  const id = created.draft_order.id;

  for (const [i, l] of r.lines.entries()) {
    await api(token, `/admin/draft-orders/${id}/add-item-force`, {
      method: "POST",
      body: {
        variant_id: l.variantId,
        quantity: l.quantity,
        unit_price: l.unitPrice,
        line_discount: l.lineDiscount,
        original_unit_price: l.lineDiscount ? l.originalUnitPrice : null,
        custom_title: l.title,
        sort_order: i,
      },
    });
  }
  if (r.shippingOptionId) {
    await api(token, `/admin/draft-orders/${id}/add-shipping-force`, {
      method: "POST",
      body: {
        shipping_option_id: r.shippingOptionId,
        custom_amount: r.shippingPrice,
      },
    });
  }
  if (r.discountType && (r.discountValue ?? 0) > 0) {
    await api(token, "/admin/pos-discount", {
      method: "POST",
      body: {
        order_id: id,
        discount_type: r.discountType,
        discount_value: r.discountValue,
      },
    });
  }
  // Sin compute-tax — igual que el POS en este camino.
  await api(token, `/admin/draft-orders/${id}/convert-force`, {
    method: "POST",
    body: {},
  });
  // CONTROL: si el guard anti-duplicados bloqueó la conversión, el draft sigue
  // siendo draft y su total nativo (sin impuesto) se leería como un cálculo
  // equivocado. Que falle diciendo la verdad, no con un número inventado.
  const { rows } = await sb.query<{ d: boolean }>(
    `SELECT is_draft_order AS d FROM "order" WHERE id = $1`,
    [id]
  );
  if (rows[0]?.d !== false) {
    throw new Error(
      "convert-force no convirtió el draft (probable guard anti-duplicados: " +
        "mismo cliente y mismas líneas dentro de 45s)"
    );
  }
  // `convert-force` escribe el total más de una vez: primero con la aritmética
  // explícita (sin impuesto todavía) y después con el derivado, ya con el tax
  // resuelto. Leer apenas responde agarra el intermedio — la primera versión de
  // este chequeo reportó $1587.91 contra $1699.07 y lo llamé bug del producto
  // cuando la base ya tenía el número bueno. Se espera a que estabilice.
  return settleTotal(sb, id);
}

/** Lee hasta que dos lecturas seguidas coincidan (máx ~6s). */
async function settleTotal(sb: Pool, id: string): Promise<number | null> {
  let prev: number | null = null;
  for (let i = 0; i < 12; i++) {
    const t = await readTotals(sb, id);
    const cur = t.computed ?? t.summary;
    if (i > 0 && cur != null && prev != null && Math.abs(cur - prev) < CENT) {
      return cur;
    }
    prev = cur;
    await new Promise((r) => setTimeout(r, 500));
  }
  return prev;
}

async function main(): Promise<void> {
  const docs = (process.env.DOCS ?? "").trim()
    ? process.env.DOCS!.split(",").map((s) => s.trim())
    : DEFAULT_DOCS;

  console.log("\nE2E — ciclo de vida del total contra QuickBooks (sandbox)");
  console.log("=".repeat(84));
  console.log("leyendo recetas de producción (read-only)…");
  const recipes = await loadRecipes(docs);
  console.log(`  ${recipes.length} documentos replicables\n`);

  // Modo volcado: escribe las recetas + la verdad de QB para que el chequeo
  // del FRONTEND (store-pos, otro repo, otro lenguaje de build) corra la misma
  // canasta por `computeTotals` y se compare contra el mismo número. Sin esto,
  // el navegador —que es el que produce la cifra que ve el cliente y la que
  // viaja a QuickBooks dentro del pos_invoice— queda sin verificar.
  if (process.env.DUMP_RECIPES) {
    writeFileSync(
      process.env.DUMP_RECIPES,
      JSON.stringify(recipes, null, 1),
      "utf8"
    );
    console.log(
      `volcadas ${recipes.length} recetas → ${process.env.DUMP_RECIPES}`
    );
    return;
  }

  const token = await login();
  const sb = new Pool({ connectionString: SANDBOX_DB });
  const failures: string[] = [];
  const unexpectedPasses: string[] = [];

  try {
    // DOS PASADAS, y no por prolijidad.
    //
    // `convert-force` bloquea una conversión cuyo cliente + huella de líneas
    // (variante:cantidad) coincide con otra orden convertida en los últimos 45
    // segundos — protección real contra la orden duplicada por doble clic. El
    // camino directo replica EXACTAMENTE el mismo documento que el camino del
    // estimado, así que hacer los dos seguidos dispara ese guard: el draft se
    // queda sin convertir y su total nativo (sin impuesto) se lee como si el
    // cálculo estuviera mal. Reportó $1587.91 contra $1699.07 y parecía una
    // orden directa sin tax; era el guard haciendo su trabajo.
    const pass1: {
      r: Recipe;
      res: Awaited<ReturnType<typeof runOne>> | null;
      at: number;
    }[] = [];
    for (const r of recipes) {
      try {
        pass1.push({ r, res: await runOne(token, sb, r), at: Date.now() });
      } catch (e) {
        console.log(`\n${r.doc} — ❌ ${(e as Error).message}`);
        failures.push(`${r.doc}: ${(e as Error).message}`);
        pass1.push({ r, res: null, at: Date.now() });
      }
    }

    for (const { r, res, at } of pass1) {
      if (!res) continue;
      // Con muchos documentos la ventana ya pasó sola; con uno solo hay que
      // esperarla, o el guard bloquea y el test miente.
      const waitMs = 46_000 - (Date.now() - at);
      if (waitMs > 0) {
        console.log(
          `\n… esperando ${Math.ceil(waitMs / 1000)}s la ventana anti-duplicados de ${r.doc}`
        );
        await new Promise((x) => setTimeout(x, waitMs));
      }
      const known = KNOWN_BAD[r.doc];

      const qb = r.qbTotal;
      const parts = res.stages
        .map((s) => {
          if (s.total == null) return `${s.name}=—`;
          const d = Math.round((s.total - qb) * 100) / 100;
          return `${s.name}=$${s.total.toFixed(2)}${Math.abs(d) < CENT ? "" : `(${d > 0 ? "+" : ""}${d.toFixed(2)})`}`;
        })
        .join("  ");

      // Las etapas que reproducen el documento original tienen que dar el
      // total de QuickBooks. La etapa editada NO — esa tiene que moverse.
      const stable = res.stages.filter((s) => s.mustDifferFrom == null);
      const edited = res.stages.filter((s) => s.mustDifferFrom != null);

      const offQb = stable.filter(
        (s) => s.total != null && Math.abs(s.total - qb) >= CENT
      );
      const totals = stable
        .map((s) => s.total)
        .filter((t): t is number => t != null);
      const moved =
        totals.length > 1 &&
        Math.max(...totals) - Math.min(...totals) >= CENT;
      // Control positivo: agregar una línea TIENE que cambiar el total. Si no
      // cambió, la edición no recalculó y las otras etapas no prueban nada.
      const dead = edited.filter(
        (s) =>
          s.total == null ||
          Math.abs(s.total - (s.mustDifferFrom as number)) < CENT
      );

      // El cuarto camino: orden creada directamente, sin estimado.
      let direct: number | null = null;
      let directErr: string | null = null;
      try {
        direct = await runDirect(token, sb, r);
      } catch (e) {
        directErr = (e as Error).message;
      }
      const directOff =
        directErr != null ||
        direct == null ||
        Math.abs(direct - qb) >= CENT;

      const ok =
        offQb.length === 0 &&
        !moved &&
        dead.length === 0 &&
        !directOff &&
        res.errors.length === 0;
      const tag = known ? (ok ? "⚠️ INESPERADO" : "🔶 esperado-malo") : ok ? "✅" : "❌";
      console.log(`${tag} ${r.doc.padEnd(8)} QB $${qb.toFixed(2).padStart(10)} (${r.qbRef})`);
      console.log(`     ${parts}`);
      console.log(
        `     orden directa (sin estimado) = ${
          directErr
            ? `❌ ${directErr.slice(0, 120)}`
            : direct == null
              ? "—"
              : `$${direct.toFixed(2)}${
                  Math.abs(direct - qb) < CENT
                    ? ""
                    : `(${direct - qb > 0 ? "+" : ""}${(direct - qb).toFixed(2)})`
                }`
        }`
      );
      if (moved)
        console.log(
          `     ⚠️  EL TOTAL SE MOVIÓ entre etapas que deberían ser idénticas`
        );
      if (dead.length > 0)
        console.log(
          `     ⚠️  la edición NO movió el total — la etapa no probó nada`
        );
      for (const e of res.errors) console.log(`     ❌ ${e}`);

      if (known && ok) unexpectedPasses.push(`${r.doc} — ${known}`);
      if (!known && !ok) {
        failures.push(
          `${r.doc}: ${moved ? "el total se movió entre etapas idénticas; " : ""}` +
            `${dead.length > 0 ? "la edición no recalculó; " : ""}` +
            `${directOff ? `orden directa ≠ QB (${directErr ?? direct}); ` : ""}` +
            offQb.map((s) => `${s.name} ≠ QB`).join(", ") +
            res.errors.join("; ")
        );
      }
    }
  } finally {
    await sb.end();
  }

  console.log(`\n${"=".repeat(84)}`);
  for (const u of unexpectedPasses)
    console.log(`⚠️  pasó uno que se esperaba malo — revisá la expectativa: ${u}`);
  if (failures.length === 0) {
    console.log("✅ PASS — cada documento coincide con QuickBooks y no se movió en todo el ciclo.");
    return;
  }
  console.log(`❌ FAIL — ${failures.length}:`);
  for (const f of failures) console.log(`   ${f}`);
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

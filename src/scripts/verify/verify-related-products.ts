/**
 * verify-related-products.ts — el contrato de "Related Products" curados,
 * ejercitado contra el SANDBOX de punta a punta (ruta admin → metadata →
 * ruta store), con controles positivos Y negativos.
 *
 * Qué afirma:
 *   §1 PUT valida: self → 400 · 9 ids → 400 · id inexistente → 400.
 *   §2 El orden curado se respeta y el recíproco se agrega SÓLO al agregar.
 *   §3 Quitar no cascadea (el otro lado conserva la relación).
 *   §4 Un draft curado NO sale por la ruta store.
 *   §5 Sin stock en Miami → se hunde al final (control positivo y negativo).
 *   §6 La respuesta store no trae claves internas (vendor/qb/cost).
 *   §7 Con menos de `limit` válidos, completa con la categoría sin repetir.
 *
 * Muta metadata/status/stock de productos del sandbox y los RESTAURA en el
 * finally. Se niega a correr contra cualquier host que no sea localhost.
 *
 * Correr (backend levantado en sandbox, p.ej. ./back-sb):
 *   RELATED_BASE_URL=http://localhost:9099 \
 *   DATABASE_URL=postgresql://postgres:sandbox@localhost:5499/medusa \
 *   ./node_modules/.bin/tsx src/scripts/verify/verify-related-products.ts
 */
import { Client } from "pg";

const BASE = process.env.RELATED_BASE_URL ?? "http://localhost:9099";
const DB = process.env.DATABASE_URL ?? "postgresql://postgres:sandbox@localhost:5499/medusa";
const EMAIL = process.env.SANDBOX_TEST_EMAIL ?? "sandbox@test.com";
const PASS = process.env.SANDBOX_TEST_PASSWORD ?? "sandbox123";
const USA_LOC = process.env.ECOPOWERTECH_MIAMI_LOCATION_ID ?? "sloc_01KFS2AV3TAKR141KC2D6JCGTR";

if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(BASE) || !/@(localhost|127\.0\.0\.1):/.test(DB)) {
  console.error("❌ Este verificador sólo corre contra localhost (sandbox). Abortando.");
  process.exit(2);
}

let failed = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

type Json = Record<string, unknown>;
const http = async (method: string, path: string, headers: Record<string, string>, body?: unknown) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Json = {};
  try { json = JSON.parse(text) as Json; } catch { /* non-json body */ }
  return { status: res.status, json };
};

const main = async () => {
  const pg = new Client({ connectionString: DB });
  await pg.connect();

  const pk = (await pg.query<{ token: string }>(
    "select token from api_key where type='publishable' and revoked_at is null limit 1"
  )).rows[0]?.token;
  if (!pk) throw new Error("sin publishable key en el sandbox");
  const storeH = { "x-publishable-api-key": pk };

  const auth = await http("POST", "/auth/user/emailpass", {}, { email: EMAIL, password: PASS });
  const token = auth.json.token as string | undefined;
  if (!token) throw new Error(`login admin falló (${auth.status})`);
  const adminH = { Authorization: `Bearer ${token}` };

  // Fixtures: una categoría con ≥6 publicados con stock en Miami.
  const fx = (await pg.query<{ id: string }>(`
    with cat as (
      select pcp.product_category_id cid
      from product_category_product pcp
      join product p on p.id = pcp.product_id and p.deleted_at is null and p.status = 'published'
      group by 1 having count(*) >= 6 order by count(*) desc limit 1
    )
    select p.id from product p
    join product_category_product pcp on pcp.product_id = p.id and pcp.product_category_id = (select cid from cat)
    where p.deleted_at is null and p.status = 'published'
      and exists (
        select 1 from product_variant pv
        join product_variant_inventory_item pvi on pvi.variant_id = pv.id
        join inventory_level il on il.inventory_item_id = pvi.inventory_item_id and il.location_id = $1
        where pv.product_id = p.id and pv.deleted_at is null and il.stocked_quantity - il.reserved_quantity > 0)
    order by p.id limit 6`, [USA_LOC])).rows.map((r) => r.id);
  if (fx.length < 6) throw new Error(`fixtures insuficientes (${fx.length}/6)`);
  const [A, B, C, D, E, F] = fx;

  const backupMeta = new Map<string, Json | null>();
  for (const id of fx) {
    const row = (await pg.query<{ metadata: Json | null }>("select metadata from product where id=$1", [id])).rows[0];
    backupMeta.set(id, row.metadata);
  }
  const levelC = (await pg.query<{ id: string; stocked_quantity: string; raw: Json }>(`
    select il.id, il.stocked_quantity, il.raw_stocked_quantity raw from inventory_level il
    join product_variant_inventory_item pvi on pvi.inventory_item_id = il.inventory_item_id
    join product_variant pv on pv.id = pvi.variant_id
    where pv.product_id = $1 and il.location_id = $2`, [C, USA_LOC])).rows;

  const rel = (id: string) => `/admin/products/${id}/related-products`;
  const storeIds = async (id: string, limit = 4) => {
    const r = await http("GET", `/store/products/${id}/related?limit=${limit}`, storeH);
    return { ids: (r.json.ids as string[]) ?? [], products: (r.json.related_products as Json[]) ?? [], status: r.status };
  };

  try {
    // Estado inicial limpio para los 6.
    for (const id of fx) await http("PUT", rel(id), adminH, { ids: [] });

    console.log("\n§1 validaciones del PUT");
    check("self → 400", (await http("PUT", rel(A), adminH, { ids: [A] })).status === 400);
    check("9 ids → 400", (await http("PUT", rel(A), adminH, { ids: Array.from({ length: 9 }, (_, i) => `x${i}`) })).status === 400);
    check("id inexistente → 400", (await http("PUT", rel(A), adminH, { ids: ["prod_ghost"] })).status === 400);

    console.log("\n§2 orden curado + recíproco al agregar");
    const put = await http("PUT", rel(A), adminH, { ids: [B, C, D, E] });
    check("PUT A→[B,C,D,E] 200", put.status === 200, String(put.status));
    check("orden persistido", JSON.stringify(put.json.ids) === JSON.stringify([B, C, D, E]));
    const recip = put.json.reciprocal as { added_to: string[] };
    check("recíproco agregado a B,C,D,E", [B, C, D, E].every((t) => recip.added_to.includes(t)), recip.added_to.join(","));
    const bList = (await http("GET", rel(B), adminH)).json.ids as string[];
    check("B contiene A al final", bList[bList.length - 1] === A);
    const s2 = await storeIds(A);
    check("store devuelve B,C,D,E en ese orden", JSON.stringify(s2.ids) === JSON.stringify([B, C, D, E]), s2.ids.join(","));

    console.log("\n§3 quitar no cascadea");
    await http("PUT", rel(A), adminH, { ids: [B, C, D] });
    const eList = (await http("GET", rel(E), adminH)).json.ids as string[];
    check("E sigue teniendo A", eList.includes(A));
    const put2 = await http("PUT", rel(A), adminH, { ids: [B, C, D, E] });
    check("re-agregar E no duplica en E", ((put2.json.reciprocal as { added_to: string[] }).added_to.length === 0));

    console.log("\n§4 draft curado no sale");
    await pg.query("update product set status='draft' where id=$1", [D]);
    const s4 = await storeIds(A, 8);
    check("D (draft) ausente", !s4.ids.includes(D), s4.ids.join(","));
    check("los demás siguen en orden B,C,E", JSON.stringify(s4.ids.filter((i) => [B, C, E].includes(i))) === JSON.stringify([B, C, E]));
    await pg.query("update product set status='published' where id=$1", [D]);

    console.log("\n§5 sin stock se hunde (controles)");
    const s5a = await storeIds(A);
    check("control negativo: con stock, C va 2º", s5a.ids[1] === C, s5a.ids.join(","));
    for (const l of levelC) {
      await pg.query("update inventory_level set stocked_quantity=0, raw_stocked_quantity=jsonb_build_object('value','0','precision',20) where id=$1", [l.id]);
    }
    const s5b = await storeIds(A);
    check("control positivo: C sin stock va ÚLTIMO de los curados", s5b.ids.indexOf(C) === 3 && s5b.ids[0] === B, s5b.ids.join(","));
    for (const l of levelC) {
      await pg.query("update inventory_level set stocked_quantity=$2, raw_stocked_quantity=$3 where id=$1", [l.id, l.stocked_quantity, l.raw]);
    }
    const s5c = await storeIds(A);
    check("restaurado: C vuelve a 2º", s5c.ids[1] === C, s5c.ids.join(","));

    console.log("\n§6 sin claves internas");
    const leaked = s5c.products.flatMap((p) => [
      ...Object.keys((p.metadata as Json) ?? {}),
      ...((p.variants as Json[]) ?? []).flatMap((v) => Object.keys((v.metadata as Json) ?? {})),
    ]).filter((k) => /vendor|qb_|cost|margin|sourced/i.test(k));
    check("ni vendor/qb/cost/margin en producto ni variante", leaked.length === 0, leaked.join(","));
    check("precio calculado presente", s5c.products.every((p) => ((p.variants as Json[]) ?? []).some((v) => v.calculated_price)));

    console.log("\n§7 relleno por categoría");
    await http("PUT", rel(A), adminH, { ids: [B] });
    const s7 = await storeIds(A);
    check("4 ítems con 1 curado", s7.ids.length === 4, String(s7.ids.length));
    check("B primero", s7.ids[0] === B);
    check("sin repetidos ni self", new Set(s7.ids).size === 4 && !s7.ids.includes(A));
  } finally {
    // Restaurar metadata exacta (no sólo la clave) y stock/status ya restaurados arriba.
    for (const id of fx) {
      await pg.query("update product set metadata=$2 where id=$1", [id, backupMeta.get(id) ?? null]);
    }
    await pg.query("update product set status='published' where id=$1 and status='draft'", [D]);
    for (const l of levelC) {
      await pg.query("update inventory_level set stocked_quantity=$2, raw_stocked_quantity=$3 where id=$1", [l.id, l.stocked_quantity, l.raw]);
    }
    await pg.end();
  }

  console.log(failed ? `\n❌ ${failed} chequeo(s) fallaron.` : "\n✅ Todos los chequeos pasaron.");
  process.exit(failed ? 1 : 0);
};

main().catch((e) => { console.error("💥", e); process.exit(1); });

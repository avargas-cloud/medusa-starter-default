/**
 * verify-migration-name-collisions — ninguna migración PROPIA puede llamarse
 * igual que una de @medusajs/*.
 *
 *   ./node_modules/.bin/tsx src/scripts/verify/verify-migration-name-collisions.ts
 *
 * MikroORM registra todas las migraciones en `mikro_orm_migrations` por NOMBRE,
 * sin importar el módulo. Si una nuestra ya está registrada con el mismo nombre
 * que trae una versión nueva del core, la del core se da por ejecutada y no
 * corre: así quedó `@medusajs/cart` 2.18 sin sus columnas `data` en producción
 * (09/12→09/16/2026, add-to-cart roto) por `Migration20260626000000` de
 * inventory-count. Exit 1 con la lista de colisiones; 0 si no hay.
 */
import { readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const ROOT = join(__dirname, "..", "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (e === "node_modules" || e === ".medusa") continue;
      walk(p, out);
    } else if (/^Migration\d+.*\.(ts|js)$/.test(e) && p.includes("migrations")) {
      out.push(p);
    }
  }
  return out;
}

const own = new Map<string, string>();
for (const p of walk(join(ROOT, "src"))) own.set(basename(p).replace(/\.(ts|js)$/, ""), p);

const core = new Map<string, string>();
const scope = join(ROOT, "node_modules", "@medusajs");
for (const mod of readdirSync(scope)) {
  const dir = join(scope, mod, "dist", "migrations");
  try {
    for (const f of readdirSync(dir)) {
      if (/^Migration\d+.*\.js$/.test(f)) core.set(f.replace(/\.js$/, ""), `@medusajs/${mod}`);
    }
  } catch {
    /* módulo sin migraciones */
  }
}

const collisions = [...own.keys()].filter((n) => core.has(n));
if (collisions.length) {
  console.error("❌ migraciones propias con el MISMO nombre que una del core (MikroORM las confunde):");
  for (const n of collisions) console.error(`   ${n}: ${own.get(n)}  ↔  ${core.get(n)}`);
  console.error("   Renombrá la propia (sufijo distinto) — es idempotente si usa IF NOT EXISTS.");
  process.exit(1);
}
console.log(`✓ ${own.size} migraciones propias, ${core.size} del core, 0 colisiones`);

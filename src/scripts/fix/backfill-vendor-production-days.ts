/**
 * backfill-vendor-production-days.ts
 *
 * Sets metadata.production_days for all active vendors:
 *   - 30 days  if the vendor name contains a Chinese city, province, or "China"
 *   - 10 days  otherwise (domestic / US vendors)
 *
 * Detection is case-insensitive substring match on: full_name, name, company_name.
 *
 * Usage:
 *   cd backend
 *   yarn ts-node src/scripts/fix/backfill-vendor-production-days.ts           # dry-run
 *   yarn ts-node src/scripts/fix/backfill-vendor-production-days.ts --apply   # apply
 *   yarn ts-node src/scripts/fix/backfill-vendor-production-days.ts --apply --force  # overwrite existing values too
 */

import "dotenv/config";
import postgres from "postgres";

const CHINA_KEYWORDS = [
  // Generic
  "china", "chinese", "sino",
  // Major cities
  "shenzhen", "guangzhou", "guangdong", "guandong", "guanzhou",
  "shanghai", "beijing", "tianjin", "chongqing",
  "hangzhou", "zhejiang", "suzhou", "jiangsu", "nanjing",
  "dongguan", "foshan", "zhongshan", "huizhou", "zhuhai",
  "ningbo", "wenzhou", "taizhou", "jinhua", "yiwu",
  "wuhan", "hubei", "changsha", "hunan",
  "shandong", "qingdao", "jinan", "yantai", "weifang",
  "fujian", "fuzhou", "xiamen", "quanzhou",
  "chengdu", "sichuan", "chengdou",
  "kunming", "yunnan",
  "nanchang", "jiangxi",
  "hefei", "anhui",
  "dalian", "shenyang", "liaoning",
  "harbin", "heilongjiang",
  "changchun", "jilin",
  "zhengzhou", "henan",
  "taiyuan", "shanxi",
  "shijiazhuang", "hebei",
  "nanning", "guangxi",
  "guiyang", "guizhou",
  "lanzhou", "gansu",
  "urumqi", "xinjiang",
  "xian", "shaanxi",
  "hong kong", "hongkong",
  "hainan", "ningxia", "qinghai",
  // Common in vendor names
  "shantou", "zhuzhou", "wuxi", "nantong", "linyi", "weifang",
  // Chinese marketplaces / logistics commonly in vendor names
  "alibaba", "aliexpress", "taobao", "1688.com", "made-in-china",
  "veetech", "dhgate",
];

function isChineseVendor(
  name: string,
  fullName: string | null,
  company: string | null,
  addr1: string | null,
  addr2: string | null,
  city: string | null,
  state: string | null,
  country: string | null,
): boolean {
  const haystack = [name, fullName, company, addr1, addr2, city, state, country]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return CHINA_KEYWORDS.some((kw) => haystack.includes(kw));
}

async function main() {
  const apply = process.argv.includes("--apply");
  const force = process.argv.includes("--force");

  const sql = postgres(process.env.DATABASE_URL!, { ssl: false });

  console.log(`\n=== Vendor Production Days Backfill ===`);
  console.log(`Mode  : ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`Force : ${force ? "yes (overwrite existing)" : "no (skip already set)"}`);
  console.log("");

  const vendors = await sql<{
    id: string;
    full_name: string;
    name: string;
    company_name: string | null;
    addr1: string | null;
    addr2: string | null;
    city: string | null;
    state: string | null;
    country: string | null;
    metadata: Record<string, unknown> | null;
  }[]>`
    SELECT id, full_name, name, company_name, addr1, addr2, city, state, country, metadata
    FROM qb_vendor
    WHERE deleted_at IS NULL
    ORDER BY full_name
  `;

  console.log(`Found ${vendors.length} vendors.\n`);

  let chineseCount = 0;
  let domesticCount = 0;
  let skippedCount = 0;
  const toUpdate: { id: string; days: number; name: string; reason: string }[] = [];

  for (const v of vendors) {
    const alreadySet = v.metadata?.production_days != null;

    if (alreadySet && !force) {
      skippedCount++;
      console.log(`  SKIP  ${v.full_name.padEnd(45)} (already ${v.metadata!.production_days} days)`);
      continue;
    }

    const isChina = isChineseVendor(v.name, v.full_name, v.company_name, v.addr1, v.addr2, v.city, v.state, v.country);
    const days = isChina ? 30 : 10;
    const reason = isChina ? "🇨🇳 China" : "🇺🇸 Domestic";

    if (isChina) chineseCount++; else domesticCount++;

    const tag = alreadySet ? "UPDATE" : "SET   ";
    console.log(`  ${tag} ${v.full_name.padEnd(45)} → ${days} days  (${reason})`);
    toUpdate.push({ id: v.id, days, name: v.full_name, reason });
  }

  console.log(`\n--- Summary ---`);
  console.log(`  China    (30 days): ${chineseCount}`);
  console.log(`  Domestic (10 days): ${domesticCount}`);
  console.log(`  Skipped (already set, no --force): ${skippedCount}`);
  console.log(`  To update: ${toUpdate.length}`);

  if (!apply) {
    console.log(`\nDry-run complete. Run with --apply to persist changes.\n`);
    await sql.end();
    return;
  }

  if (toUpdate.length === 0) {
    console.log(`\nNothing to update.\n`);
    await sql.end();
    return;
  }

  console.log(`\nApplying...`);
  let ok = 0;
  let fail = 0;

  for (const { id, days } of toUpdate) {
    try {
      await sql`
        UPDATE qb_vendor
        SET metadata = COALESCE(metadata, '{}'::jsonb) || ${sql.json({ production_days: days })}
        WHERE id = ${id}
      `;
      ok++;
    } catch (e: unknown) {
      console.error(`  ERROR updating ${id}: ${e instanceof Error ? e.message : e}`);
      fail++;
    }
  }

  console.log(`\nDone. ${ok} updated, ${fail} failed.\n`);
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

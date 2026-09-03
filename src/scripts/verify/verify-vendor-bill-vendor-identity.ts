/**
 * verify-vendor-bill-vendor-identity.ts
 *
 * Gate for the VB-1148 fix (2026-09-03, QuickBooks Error 3000).
 *
 * A vendor bill created inside the ~1 minute window between minting a vendor
 * and QuickBooks confirming it froze the placeholder `pending_<ts>_<rand>`
 * ListID into `vendor_qb_list_id_snapshot`, and the BillAdd sent it verbatim.
 *
 * This check has TWO halves, and the second is the one that matters:
 *
 *   §1-§2  the PURE decision behaves — including the negative assertion that a
 *          VALID snapshot is never replaced by a live value. The snapshot
 *          freezes the vendor a document was issued to; "always use live"
 *          would be a different, wrong fix.
 *   §3-§4  the callers actually WIRE it. A pure function nobody calls is the
 *          failure mode this repo has paid for repeatedly, so the payload line
 *          and both snapshot writers are asserted BY NAME against the source.
 *
 * Every source assertion strips `import` lines first: a check that greps the
 * whole file is satisfied by the import alone, which is exactly how §4b of
 * verify-pin-enforcement.ts went blind.
 *
 * No database. Run:
 *   ./node_modules/.bin/tsx src/scripts/verify/verify-vendor-bill-vendor-identity.ts
 */
import { readFileSync } from "fs";
import { join } from "path";

import {
  decideVendorIdentity,
  isUsableQbListId,
} from "../../lib/purchase-orders/vendor-bill-vendor-identity";

const ROOT = join(__dirname, "..", "..");
let failures = 0;

function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Source with `import` lines removed — see the header. */
function bodyOf(relPath: string): string {
  const text = readFileSync(join(ROOT, relPath), "utf8");
  return text
    .split("\n")
    .filter((l) => !/^\s*import\b/.test(l) && !/^\s*}\s*from\s+["']/.test(l))
    .join("\n");
}

console.log("\n§1 — isUsableQbListId");
check("a real QuickBooks ListID is usable", isUsableQbListId("8000239C-1788464542"));
check(
  "the pending placeholder is NOT usable",
  !isUsableQbListId("pending_1788464514168_mggpdn")
);
check("null is not usable", !isUsableQbListId(null));
check("undefined is not usable", !isUsableQbListId(undefined));
check("empty string is not usable", !isUsableQbListId(""));

console.log("\n§2 — decideVendorIdentity");
{
  const v = decideVendorIdentity({
    snapshot_list_id: "80002393-1787602385",
    snapshot_name: "CPS CABINETS LLC",
    live_list_id: "DIFFERENT-9999",
    live_name: "Renamed Vendor",
  });
  // THE NEGATIVE ASSERTION. The snapshot is not a cache to refresh: it is the
  // vendor this document was issued to. A fix that always read live would pass
  // every other case here and silently re-target historical bills.
  check(
    "a VALID snapshot wins over a different live ListID",
    v.resolved && v.list_id === "80002393-1787602385" && v.source === "snapshot",
    JSON.stringify(v)
  );
}
{
  const v = decideVendorIdentity({
    snapshot_list_id: "pending_1788464514168_mggpdn",
    snapshot_name: "CARLOVIS MACHADO (Comm)",
    live_list_id: "8000239C-1788464542",
    live_name: "CARLOVIS MACHADO (Comm)",
  });
  check(
    "a pending snapshot falls back to the live ListID",
    v.resolved && v.list_id === "8000239C-1788464542" && v.source === "live",
    JSON.stringify(v)
  );
}
{
  const v = decideVendorIdentity({
    snapshot_list_id: null,
    snapshot_name: null,
    live_list_id: "8000239C-1788464542",
    live_name: "CARLOVIS MACHADO (Comm)",
  });
  check(
    "a NULL snapshot resolves from the live vendor",
    v.resolved && v.source === "live",
    JSON.stringify(v)
  );
}
{
  const v = decideVendorIdentity({
    snapshot_list_id: "pending_a",
    snapshot_name: "X",
    live_list_id: "pending_b",
    live_name: "X",
  });
  check(
    "both pending fails CLOSED (never queues a doomed payload)",
    !v.resolved,
    JSON.stringify(v)
  );
}
{
  const v = decideVendorIdentity({
    snapshot_list_id: null,
    snapshot_name: null,
    live_list_id: null,
    live_name: null,
  });
  check("no identity at all fails closed", !v.resolved, JSON.stringify(v));
}

console.log("\n§3 — the BillAdd payload uses the RESOLVED identity");
{
  const body = bodyOf("lib/purchase-orders/qb-vendor-bill-enqueue.ts");
  check(
    "the enqueue calls resolveVendorIdentityForBill",
    /resolveVendorIdentityForBill\s*\(/.test(body)
  );
  check(
    "an unresolved identity refuses to queue",
    /if\s*\(\s*!\s*vendorIdentity\.resolved\s*\)/.test(body)
  );
  check(
    "payload.vendor_qb_list_id comes from the verdict",
    /vendor_qb_list_id:\s*vendorIdentity\.list_id/.test(body)
  );
  check(
    "payload.vendor_qb_list_id NO LONGER reads the frozen snapshot",
    !/vendor_qb_list_id:\s*bill\.vendor_qb_list_id_snapshot/.test(body)
  );
}

console.log("\n§4 — no writer may freeze a pending placeholder");
for (const [label, rel] of [
  ["CREATE /admin/vendor-bills", "api/admin/vendor-bills/route.ts"],
  ["PATCH /admin/vendor-bills/:id", "api/admin/vendor-bills/[id]/route.ts"],
] as const) {
  const body = bodyOf(rel);
  const guarded =
    /isUsableQbListId\s*\(\s*vendor\.qb_list_id\s*\)\s*\?\s*vendor\.qb_list_id\s*:\s*null/.test(
      body
    );
  check(`${label} filters the snapshot through isUsableQbListId`, guarded);
}

console.log(
  failures === 0
    ? "\nOK — vendor identity is resolved live and no writer can freeze a placeholder\n"
    : `\nFAILED — ${failures} check(s)\n`
);
process.exit(failures === 0 ? 0 : 1);

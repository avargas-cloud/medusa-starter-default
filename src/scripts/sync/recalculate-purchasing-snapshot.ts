import { runPurchasingSnapshot } from "../../services/purchasing/snapshot.service";

export default async function recalculatePurchasingSnapshot(): Promise<void> {
  console.log("[recalc] Force-running purchasing snapshot for all variants...");
  const result = await runPurchasingSnapshot({ force: true });
  console.log(
    `[recalc] processed=${result.processed} skipped=${result.skipped} errors=${result.errors} durationMs=${result.durationMs}`
  );
}

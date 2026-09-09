import type { MedusaContainer } from "@medusajs/framework/types";
import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";
import { bankingConfig } from "../lib/banking/security";
import { readBankingControl } from "../lib/banking/control";
import { syncPendingBanks } from "../lib/banking/sync";
import { drainBankWebhooks } from "../lib/banking/webhooks";

export default async function bankFeedSync(container: MedusaContainer) {
  if (isScheduledJobsDisabled(container)) return;
  if (!bankingConfig().enabled) return;
  if (!(await readBankingControl()).enabled) return;
  await drainBankWebhooks();
  await syncPendingBanks();
}
export const config = { name: "bank-feed-sync", schedule: "*/1 * * * *" };

import type { MedusaContainer } from "@medusajs/framework/types";

import { readBankingControl } from "../lib/banking/control";
import { bankingConfig } from "../lib/banking/security";
import { syncPendingBanks } from "../lib/banking/sync";
import { drainBankWebhooks } from "../lib/banking/webhooks";

import { isScheduledJobsDisabled } from "./_lib/_scheduled-jobs-guard";

export default async function bankFeedSync(
  container: MedusaContainer
): Promise<void> {
  if (isScheduledJobsDisabled(container)) return;
  if (!bankingConfig().enabled) return;
  if (!(await readBankingControl()).enabled) return;
  await drainBankWebhooks();
  await syncPendingBanks();
}
export const config = { name: "bank-feed-sync", schedule: "*/1 * * * *" };

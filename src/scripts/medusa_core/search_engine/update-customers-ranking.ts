import { ExecArgs } from "@medusajs/framework/types";

/**
 * Applies updated rankingRules to the customers MeiliSearch index.
 * Moves `exactness` before `sort` so exact company_name matches rank higher
 * than recently-created customers when relevance is otherwise equal.
 *
 * Run: yarn medusa exec ./src/scripts/medusa_core/search_engine/update-customers-ranking.ts
 */
export default async function updateCustomersRanking(_: ExecArgs) {
  const { MeiliSearch } = await import("meilisearch");

  const client = new MeiliSearch({
    host: process.env.MEILISEARCH_HOST!,
    apiKey: process.env.MEILISEARCH_API_KEY!,
  });

  const index = client.index("customers");

  console.log("Applying rankingRules to customers index...");
  const task = await index.updateSettings({
    rankingRules: [
      "words",
      "typo",
      "proximity",
      "attribute",
      "exactness",
      "sort",
    ],
  });

  await client.tasks.waitForTask(task.taskUid);
  console.log("Done. New settings:");
  const settings = await index.getSettings();
  console.log("rankingRules:", settings.rankingRules);
}

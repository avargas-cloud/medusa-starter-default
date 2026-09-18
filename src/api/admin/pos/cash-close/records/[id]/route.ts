/** GET /admin/pos/cash-close/records/:id — full record (with snapshot), 404. */
import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

import { getCashClose } from "../../../../../../lib/cash-close/service";
import type { Knexish } from "../../../../../../lib/cash-close/load-day";

export async function GET(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const userId = req.auth_context?.actor_id;
  if (!userId) {
    res.status(401).json({ error: "POS_AUTH_REQUIRED" });
    return;
  }

  const { id } = req.params as { id: string };
  const knex = req.scope.resolve("__pg_connection__") as unknown as Knexish;
  try {
    const record = await getCashClose(knex, id);
    if (!record) {
      res.status(404).json({ error: "CASH_CLOSE_NOT_FOUND" });
      return;
    }
    res.json({ record });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[cash-close] GET record failed: ${message}`);
    res.status(500).json({ error: "CASH_CLOSE_GET_FAILED", message });
  }
}

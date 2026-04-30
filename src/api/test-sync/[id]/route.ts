import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

// 1.5.4: handler import removed — test-sync now enqueues 'pending' for
// the consolidator to process via the same handler.
import { writePipelineRow } from "../../../lib/quickbooks/qb-pipeline";

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const logs: string[] = [];

  try {
    await writePipelineRow({
      orderId: req.params.id,
      step: "estimate",
      status: "pending",
    });
    logs.push(`[INFO] 📥 Enqueued estimate for ${req.params.id}`);
    return res.json({ success: true, logs });
  } catch (e: any) {
    return res.json({ success: false, error: e.stack, logs });
  }
}

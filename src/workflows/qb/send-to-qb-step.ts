import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";

type SendToQbInput = {
  action: "add" | "mod";
  data: any;
  /** When true the step short-circuits and returns a null operationId.
   * Callers can build a QB payload only when QB-relevant fields changed,
   * avoiding unnecessary QBXML round-trips for non-QB edits (images,
   * categories, shipping, etc.). */
  skip?: boolean;
};

export const sendToQbStep = createStep(
  "send-to-qb-step",
  async (input: SendToQbInput, { container }) => {
    const logger = container.resolve("logger");

    if (input.skip) {
      logger.info(
        `[sendToQbStep] skipped — no QB-relevant fields changed (action=${input.action})`
      );
      return new StepResponse(
        { success: true, operationId: null, response: null },
        null
      );
    }

    try {
      // we should pull the bridge URL from environment or hardcode to localhost:3000
      const qbBridgeUrl = process.env.QB_BRIDGE_URL || "http://localhost:3000";

      const reqUrl =
        input.action === "add"
          ? `${qbBridgeUrl}/api/products`
          : `${qbBridgeUrl}/api/products/${input.data.ListID}`;
      const method = input.action === "add" ? "POST" : "PUT";

      logger.info(`Sending item to QB Bridge: ${input.action} - ${reqUrl}`);

      const apiKey = process.env.QB_API_KEY || "";

      const response = await fetch(reqUrl, {
        method,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "bypass-tunnel-reminder": "true",
        },
        body: JSON.stringify({
          action: input.action,
          data: input.data,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `Failed to send to QB Bridge: ${response.status} - ${text}`
        );
      }

      const jsonVal = await response.json();

      // The step returns the operation data
      return new StepResponse(
        {
          success: true,
          operationId: jsonVal.operationId || null,
          response: jsonVal,
        },
        null
      ); // No compensation step for now, maybe delete from QB in compensation? QB doesn't easily support delete via bridge without complex logic.
    } catch (error: any) {
      logger.error(`sendToQbStep error: ${error.message}`);
      throw error;
    }
  }
);

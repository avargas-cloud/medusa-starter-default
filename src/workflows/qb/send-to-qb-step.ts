import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"

type SendToQbInput = {
    action: "add" | "mod"
    data: any
}

export const sendToQbStep = createStep(
    "send-to-qb-step",
    async (input: SendToQbInput, { container }) => {
        const logger = container.resolve("logger")
        
        try {
            // we should pull the bridge URL from environment or hardcode to localhost:3000
            const qbBridgeUrl = process.env.QB_BRIDGE_URL || "http://localhost:3000"
            
            const reqUrl = input.action === "add" ? `${qbBridgeUrl}/api/products` : `${qbBridgeUrl}/api/products/${input.data.ListID}`
            const method = input.action === "add" ? "POST" : "PUT"

            logger.info(`Sending item to QB Bridge: ${input.action} - ${reqUrl}`)

            const response = await fetch(reqUrl, {
                method,
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    action: input.action,
                    data: input.data
                })
            })

            if (!response.ok) {
                const text = await response.text()
                throw new Error(`Failed to send to QB Bridge: ${response.status} - ${text}`)
            }

            const jsonVal = await response.json()
            
            // The step returns the operation data
            return new StepResponse({
                success: true,
                operationId: jsonVal.operationId || null,
                response: jsonVal
            }, null) // No compensation step for now, maybe delete from QB in compensation? QB doesn't easily support delete via bridge without complex logic.

        } catch (error: any) {
            logger.error(`sendToQbStep error: ${error.message}`)
            throw error
        }
    }
)

import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { createPosProductWorkflow, CreatePosProductInput } from "../../../../workflows/pos/create-pos-product"

export const POST = async (req: MedusaRequest<CreatePosProductInput>, res: MedusaResponse) => {
    try {
        const { result, errors } = await createPosProductWorkflow(req.scope).run({
            input: req.body,
            throwOnError: false
        })

        if (errors && errors.length > 0) {
            req.scope.resolve("logger").error(`Failed to create POS product: ${JSON.stringify(errors)}`)
            return res.status(400).json({ error: errors[0].error.message || "Failed to create product" })
        }

        return res.status(200).json({ product: result?.product, qbOperationId: result?.qbOperationId })
    } catch (e: any) {
        return res.status(500).json({ error: e.message })
    }
}

import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { uploadFilesWorkflow } from "@medusajs/medusa/core-flows"

// 1. HANDLE PREFLIGHT (The missing piece)
export const OPTIONS = async (req: MedusaRequest, res: MedusaResponse) => {
    const origin = req.headers.origin

    // Allow the origin from the request (for local development)
    if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin)
    }

    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
    res.setHeader("Access-Control-Allow-Credentials", "true")
    
    // KEY: Authorize custom header
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-upload-context")

    res.status(200).send("")
}

// 2. POST HANDLER (with CORS headers)
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    // Ensure CORS in POST response too
    const origin = req.headers.origin
    if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin)
        res.setHeader("Access-Control-Allow-Credentials", "true")
    }

    const files = req.files as any[]
    const context = req.headers["x-upload-context"] as string

    let prefix = ""
    if (context === "products") prefix = "context_products_"
    if (context === "categories") prefix = "context_categories_"

    // Convert Multer file format to Medusa's expected format
    const filesWithContext = files.map((f) => ({
        filename: prefix ? `${prefix}${f.originalname}` : f.originalname,
        mimeType: f.mimetype,
        content: f.buffer,
        access: "public" as const,
    }))

    try {
        const { result } = await uploadFilesWorkflow(req.scope).run({
            input: {
                files: filesWithContext,
            },
        })

        // Return in Medusa's expected format
        res.json({ 
            files: result.map((file: any) => ({
                url: file.url,
                key: file.key || file.url,
            }))
        })
    } catch (error) {
        console.error("🔴 [Upload Route] Error:", error)
        res.status(500).json({ 
            message: "Upload failed",
            error: error.message 
        })
    }
}

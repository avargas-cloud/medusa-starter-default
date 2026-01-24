import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { IFileModuleService } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

export const POST = async (
    req: MedusaRequest,
    res: MedusaResponse
) => {
    try {
        const fileModuleService: IFileModuleService = req.scope.resolve(Modules.FILE)
        
        // Get uploaded files from request
        const files = req.files as Express.Multer.File[]
        
        if (!files || files.length === 0) {
            return res.status(400).json({ message: "No files uploaded" })
        }

        // Process files: add prod_ prefix for automatic folder routing
        const uploadPromises = files.map(async (file) => {
            // Rename with prod_ prefix for smart routing to products/ folder
            const prefixedFilename = `prod_${file.originalname}`
            
            return fileModuleService.uploadFile({
                filename: prefixedFilename,
                mimeType: file.mimetype,
                content: file.buffer.toString("base64"),
            })
        })

        const uploadedFiles = await Promise.all(uploadPromises)

        return res.json({
            files: uploadedFiles,
        })
    } catch (error) {
        console.error("Product upload error:", error)
        return res.status(500).json({
            message: "Upload failed",
            error: error.message,
        })
    }
}

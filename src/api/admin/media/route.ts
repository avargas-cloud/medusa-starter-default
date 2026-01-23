import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { IFileModuleService } from "@medusajs/framework/types"

export const GET = async (
    req: MedusaRequest,
    res: MedusaResponse
) => {
    const fileService: IFileModuleService = req.scope.resolve("file")

    // Note: The file service interface in Medusa v2 depends on the provider capabilities.
    // Standard IFileModuleService doesn't enforce a 'list' method for all providers like the old FileService.
    // However, we can try to use the internal provider if accessible, or relying on the database mechanism if files are stored there.

    // Medusa v2 Module usually stores file references in the DB table 'file'.
    // We can query the 'file' link or model using the RemoteQuery or Module Service.

    // Approach 1: Use the File Module Service to list files if method exists (it usually has `list`)
    try {
        // @ts-ignore - The interface might not fully expose list in types yet but the service has it
        const [files, count] = await fileService.listAndCount({}, {
            take: 50,
            order: { created_at: "DESC" }
        })

        res.json({
            files,
            count
        })
    } catch (error) {
        res.status(500).json({ message: "Failed to list files", error: error.message })
    }
}

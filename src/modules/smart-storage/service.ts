import { AbstractFileProviderService } from "@medusajs/framework/utils"
import { FileTypes } from "@medusajs/framework/types"
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { parse } from "path"

interface S3FileOptions {
    accessKeyId: string
    secretAccessKey: string
    region: string
    bucket: string
    endpoint?: string
    file_url?: string
}

class SmartStorageService extends AbstractFileProviderService {
    static identifier = "smart-s3"

    protected client: S3Client
    protected options: S3FileOptions

    constructor(_: any, options: S3FileOptions) {
        super()
        this.options = options

        // Initialize S3 client (works with MinIO, DigitalOcean, AWS)
        this.client = new S3Client({
            credentials: {
                accessKeyId: options.accessKeyId,
                secretAccessKey: options.secretAccessKey,
            },
            region: options.region,
            endpoint: options.endpoint,
            forcePathStyle: true, // Important for MinIO/Supabase
        })
    }

    // Smart folder routing logic using phantom prefixes
    private getTargetFolder(filename: string): string {
        if (!filename) return "content"
        const lowerName = filename.toLowerCase()

        // Detect context prefixes for routing
        if (lowerName.startsWith("context_products_") || lowerName.startsWith("prod_")) {
            return "products"
        }
        if (lowerName.startsWith("context_categories_") || lowerName.startsWith("cat_")) {
            return "categories"
        }

        // Default folder for everything else
        return "content"
    }

    // Clean filename by removing phantom context prefixes
    private getCleanFilename(filename: string): string {
        if (!filename) return "file"
        return filename
            .replace(/^context_products_/i, "")
            .replace(/^context_categories_/i, "")
            .replace(/^prod_/i, "")
            .replace(/^cat_/i, "")
    }

    async upload(file: FileTypes.ProviderUploadFileDTO): Promise<FileTypes.ProviderFileResultDTO> {
        // Use originalname or filename, whichever is available
        const fileName = file.filename || (file as any).originalname || "file"
        
        // 1. Detect folder based on phantom prefix
        const folder = this.getTargetFolder(fileName)
        
        console.log("🔵 [Smart Storage] Target folder:", folder)
        
        // 2. Clean the filename to preserve original name (SEO-friendly)
        const cleanName = this.getCleanFilename(fileName)
        const parsedFilename = parse(cleanName)

        // 3. Generate clean key with folder routing
        const fileKey = `${folder}/${parsedFilename.name}-${Date.now()}${parsedFilename.ext}`

        let content: Buffer
        const rawContent = file.content || (file as any).rawContent || (file as any).buffer
        
        if (!rawContent) {
            console.error("[Smart Storage] No content found in upload")
            content = Buffer.from([])
        } else if (rawContent.type === "Buffer" && Array.isArray(rawContent.data)) {
            content = Buffer.from(rawContent.data)
        } else if (Buffer.isBuffer(rawContent)) {
            content = rawContent
        } else if (typeof rawContent === "string") {
            content = Buffer.from(rawContent, "base64")
        } else if (rawContent && typeof (rawContent as any).read === "function") {
            const chunks: Buffer[] = []
            for await (const chunk of rawContent as any) {
                chunks.push(Buffer.from(chunk))
            }
            content = Buffer.concat(chunks)
        } else {
            console.error("[Smart Storage] Unknown content type")
            content = Buffer.from([])
        }

        const command = new PutObjectCommand({
            Bucket: this.options.bucket,
            Key: fileKey,
            Body: content,
            ContentType: file.mimeType,
            ContentLength: content.length,
            ACL: "public-read",
        })

        try {
            console.log("🔵 [Smart Storage] Uploading to S3...")
            await this.client.send(command)

            // Build public URL
            let url = ""
            if (this.options.file_url) {
                // Use configured file_url
                url = `${this.options.file_url}/${fileKey}`
            } else if (this.options.endpoint) {
                // Generic format for S3-compatible services
                url = `${this.options.endpoint}/${this.options.bucket}/${fileKey}`
            } else {
                // Standard AWS format
                url = `https://${this.options.bucket}.s3.${this.options.region}.amazonaws.com/${fileKey}`
            }

            return {
                url,
                key: fileKey,
            }
        } catch (e) {
            console.error(`Error uploading file to ${folder}:`, e)
            throw e
        }
    }

    async delete(file: { fileKey: string }): Promise<void> {
        const command = new DeleteObjectCommand({
            Bucket: this.options.bucket,
            Key: file.fileKey,
        })
        await this.client.send(command)
    }

    async getPresignedDownloadUrl(fileData: { fileKey: string; isPrivate?: boolean }): Promise<string> {
        if (!fileData.isPrivate) {
            // Return public URL
            if (this.options.file_url) {
                return `${this.options.file_url}/${fileData.fileKey}`
            }
            return `${this.options.endpoint}/${this.options.bucket}/${fileData.fileKey}`
        }

        // Generate signed URL for private files
        const command = new GetObjectCommand({
            Bucket: this.options.bucket,
            Key: fileData.fileKey,
        })
        return await getSignedUrl(this.client, command, { expiresIn: 3600 })
    }

    async uploadProtected(file: FileTypes.ProviderUploadFileDTO): Promise<FileTypes.ProviderFileResultDTO> {
        const parsedFilename = parse(file.filename)
        const fileKey = `protected/${parsedFilename.name}-${Date.now()}${parsedFilename.ext}`

        // Convert base64 content to Buffer
        const buffer = Buffer.from(file.content, 'base64')

        const command = new PutObjectCommand({
            Bucket: this.options.bucket,
            Key: fileKey,
            Body: buffer,
            ContentType: file.mimeType,
        })

        await this.client.send(command)

        return {
            url: `${this.options.file_url}/${fileKey}`,
            key: fileKey,
        }
    }
}

export default SmartStorageService

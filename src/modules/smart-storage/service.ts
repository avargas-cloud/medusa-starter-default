import { AbstractFileProviderService } from "@medusajs/framework/utils"
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

interface UploadedFile {
    originalname: string
    buffer: Buffer
    mimetype: string
}

class SmartStorageService extends AbstractFileProviderService {
    static identifier = "smart-storage"

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

    // Smart folder routing logic
    private getTargetFolder(filename: string): string {
        const lowerName = filename.toLowerCase()

        // 1. Prefix-based logic (ideal for agent)
        if (lowerName.startsWith("prod_") || lowerName.includes("/products/")) {
            return "products"
        }
        if (lowerName.startsWith("cat_") || lowerName.includes("/categories/")) {
            return "categories"
        }

        // 2. Default folder for everything else
        return "content"
    }

    async upload(file: UploadedFile): Promise<{ url: string; key: string }> {
        const parsedFilename = parse(file.originalname)
        const folder = this.getTargetFolder(file.originalname)

        // Generate the "Key" (full path in S3)
        // Example: products/prod_shoes_12345.jpg
        const fileKey = `${folder}/${parsedFilename.name}-${Date.now()}${parsedFilename.ext}`

        const command = new PutObjectCommand({
            Bucket: this.options.bucket,
            Key: fileKey,
            Body: file.buffer,
            ContentType: file.mimetype,
        })

        try {
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

    async uploadProtected(file: UploadedFile): Promise<{ url: string; key: string }> {
        const parsedFilename = parse(file.originalname)
        const fileKey = `protected/${parsedFilename.name}-${Date.now()}${parsedFilename.ext}`

        const command = new PutObjectCommand({
            Bucket: this.options.bucket,
            Key: fileKey,
            Body: file.buffer,
            ContentType: file.mimetype,
        })

        await this.client.send(command)

        return {
            url: `${this.options.file_url}/${fileKey}`,
            key: fileKey,
        }
    }
}

export default SmartStorageService

import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { AbstractFileProviderService } from "@medusajs/framework/utils"
import { FileTypes } from "@medusajs/framework/types"

interface FileServiceOptions {
    endpoint?: string
    access_key_id?: string
    secret_access_key?: string
    region?: string
    bucket?: string
    file_url?: string
}

export default class FileMinioFlatService extends AbstractFileProviderService {
    protected s3Client: S3Client
    protected bucket: string
    protected fileUrl: string

    constructor(_: any, options: FileServiceOptions) {
        super()

        this.s3Client = new S3Client({
            endpoint: options.endpoint,
            region: options.region || "us-east-1",
            credentials: {
                accessKeyId: options.access_key_id!,
                secretAccessKey: options.secret_access_key!,
            },
            forcePathStyle: true,
        })

        this.bucket = options.bucket!
        this.fileUrl = options.file_url || options.endpoint!
    }

    async upload(file: FileTypes.ProviderUploadFileDTO): Promise<FileTypes.ProviderFileResultDTO> {
        // Determine folder based on filename (could be extended with metadata)
        const folder = this.getFolderFromFilename(file.filename)

        // Generate unique filename
        const timestamp = Date.now()
        const filename = `${timestamp}-${file.filename}`
        const key = `${folder}/${filename}`

        // Convert base64 content to Buffer
        const buffer = Buffer.from(file.content, 'base64')

        // Upload to MinIO
        await this.s3Client.send(new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: buffer,
            ContentType: file.mimeType,
        }))

        const url = `${this.fileUrl}/${key}`

        return { url, key }
    }

    async delete(file: { fileKey: string }): Promise<void> {
        await this.s3Client.send(new DeleteObjectCommand({
            Bucket: this.bucket,
            Key: file.fileKey,
        }))
    }

    async getPresignedDownloadUrl(fileData: { fileKey: string; isPrivate?: boolean }): Promise<string> {
        if (!fileData.isPrivate) {
            return `${this.fileUrl}/${fileData.fileKey}`
        }

        const command = new GetObjectCommand({
            Bucket: this.bucket,
            Key: fileData.fileKey,
        })

        return await getSignedUrl(this.s3Client, command, { expiresIn: 3600 })
    }

    async uploadProtected(file: FileTypes.ProviderUploadFileDTO): Promise<FileTypes.ProviderFileResultDTO> {
        const key = `protected/${Date.now()}-${file.filename}`

        // Convert base64 content to Buffer
        const buffer = Buffer.from(file.content, 'base64')

        await this.s3Client.send(new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: buffer,
            ContentType: file.mimeType,
        }))

        return {
            url: `${this.fileUrl}/${key}`,
            key
        }
    }

    // Helper to determine folder from filename (smart routing)
    private getFolderFromFilename(filename: string): string {
        const lowerName = filename.toLowerCase()

        // Prefix-based logic
        if (lowerName.startsWith("prod_") || lowerName.includes("/products/")) {
            return "products"
        }
        if (lowerName.startsWith("cat_") || lowerName.includes("/categories/")) {
            return "categories"
        }

        // Default to products
        return "products"
    }
}

import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { AbstractFileProviderService } from "@medusajs/framework/utils"

interface FileServiceOptions {
    endpoint?: string
    access_key_id?: string
    secret_access_key?: string
    region?: string
    bucket?: string
    file_url?: string
}

interface UploadedFile {
    originalname: string
    buffer: Buffer
    mimetype: string
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

    async upload(file: UploadedFile, context?: Record<string, any>): Promise<{ url: string; key: string }> {
        // Determine folder based on context
        const folder = this.getFolderFromContext(context)

        // Generate unique filename
        const timestamp = Date.now()
        const filename = `${timestamp}-${file.originalname}`
        const key = `${folder}/${filename}`

        // Upload to MinIO
        await this.s3Client.send(new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: file.buffer,
            ContentType: file.mimetype,
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

    async uploadProtected(file: UploadedFile): Promise<{ url: string, key: string }> {
        const key = `protected/${Date.now()}-${file.originalname}`

        await this.s3Client.send(new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: file.buffer,
            ContentType: file.mimetype,
        }))

        return {
            url: `${this.fileUrl}/${key}`,
            key
        }
    }

    // Helper to determine folder from context
    private getFolderFromContext(context?: Record<string, any>): string {
        if (!context) return "products"

        // Check for entity type hints in context
        if (context.entity === "category" || context.entityType === "category") {
            return "categories"
        }

        if (context.entity === "product" || context.entityType === "product") {
            return "products"
        }

        // Default to products
        return "products"
    }
}

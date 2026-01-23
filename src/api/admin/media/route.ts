import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3"

export const GET = async (
    req: MedusaRequest,
    res: MedusaResponse
) => {
    try {
        const prefix = (req.query.prefix as string) || ""

        // Create S3 client directly using environment variables
        const s3Client = new S3Client({
            endpoint: process.env.MINIO_ENDPOINT,
            region: "us-east-1",
            credentials: {
                accessKeyId: process.env.MINIO_ACCESS_KEY || "",
                secretAccessKey: process.env.MINIO_SECRET_KEY || "",
            },
            forcePathStyle: true, // Required for MinIO
        })

        const bucket = process.env.MINIO_BUCKET || "medusa-media"

        // List objects from S3/MinIO with delimiter to get folders
        const command = new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            Delimiter: "/", // This makes S3 return CommonPrefixes (folders)
            MaxKeys: 100,
        })

        const response = await s3Client.send(command)

        // Folders (CommonPrefixes)
        const folders = (response.CommonPrefixes || []).map((item) => ({
            id: item.Prefix,
            name: item.Prefix?.replace(prefix, "").replace("/", "") || "",
            type: "folder" as const,
            prefix: item.Prefix,
        }))

        // Files (Contents)
        const files = (response.Contents || [])
            .filter(item => item.Key !== prefix) // Exclude the folder itself
            .map((item) => ({
                id: item.Key,
                url: `${process.env.MINIO_ENDPOINT}/${bucket}/${item.Key}`,
                name: item.Key?.replace(prefix, "") || "",
                key: item.Key,
                size: item.Size,
                type: "file" as const,
                last_modified: item.LastModified,
            }))

        res.json({
            folders,
            files,
            prefix,
            count: folders.length + files.length
        })
    } catch (error) {
        console.error("Media library error:", error)
        res.status(500).json({
            message: "Failed to list files",
            error: error.message,
            folders: [],
            files: [],
            count: 0
        })
    }
}

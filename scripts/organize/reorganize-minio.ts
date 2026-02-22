import { S3Client, ListObjectsV2Command, CopyObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3"
import dotenv from "dotenv"

dotenv.config()

const s3Client = new S3Client({
    endpoint: process.env.MINIO_ENDPOINT,
    region: "us-east-1",
    credentials: {
        accessKeyId: process.env.MINIO_ACCESS_KEY!,
        secretAccessKey: process.env.MINIO_SECRET_KEY!,
    },
    forcePathStyle: true,
})

const BUCKET = process.env.MINIO_BUCKET!

interface FileMapping {
    oldKey: string
    newKey: string
    size: number
}

async function reorganizeMinIO(dryRun = true) {
    console.log("🔄 Starting MinIO reorganization...")
    console.log(`Mode: ${dryRun ? "DRY RUN (preview only)" : "LIVE (will move files)"}`)
    console.log(`Bucket: ${BUCKET}`)
    console.log("=".repeat(60))

    const fileMappings: FileMapping[] = []
    const duplicates: string[] = []
    const seenFilenames = new Set<string>()

    // Process products/ folder
    console.log("\n📁 Processing products/ folder...")
    await processFolder("products", fileMappings, duplicates, seenFilenames)

    // Process categories/ folder
    console.log("\n📁 Processing categories/ folder...")
    await processFolder("categories", fileMappings, duplicates, seenFilenames)

    console.log("\n" + "=".repeat(60))
    console.log("📊 REORGANIZATION SUMMARY")
    console.log("=".repeat(60))
    console.log(`Total files to move: ${fileMappings.length}`)
    console.log(`Duplicate filenames found: ${duplicates.length}`)

    if (duplicates.length > 0) {
        console.log(`\n⚠️  First 10 duplicates:`)
        duplicates.slice(0, 10).forEach(dup => console.log(`  - ${dup}`))
        if (duplicates.length > 10) {
            console.log(`  ... and ${duplicates.length - 10} more`)
        }
    }

    console.log("\n" + "=".repeat(60))

    if (dryRun) {
        console.log("\n💡 This was a DRY RUN - no changes were made")
        console.log("   Run without --dry-run to execute the reorganization")

        // Save mappings to file for review
        const fs = await import("fs/promises")
        await fs.writeFile(
            "minio-reorganization-plan.json",
            JSON.stringify({ fileMappings, duplicates }, null, 2)
        )
        console.log("\n📄 Saved reorganization plan to: minio-reorganization-plan.json")
    } else {
        console.log("\n🚀 Executing reorganization...")
        await executeMoves(fileMappings)
        await cleanupEmptyFolders()
        console.log("\n✅ Reorganization completed!")
    }
}

async function processFolder(
    baseFolder: string,
    mappings: FileMapping[],
    duplicates: string[],
    seenFilenames: Set<string>
) {
    let continuationToken: string | undefined
    let totalFound = 0

    do {
        const listCommand = new ListObjectsV2Command({
            Bucket: BUCKET,
            Prefix: `${baseFolder}/`,
            ContinuationToken: continuationToken,
        })

        const response = await s3Client.send(listCommand)
        const objects = response.Contents || []

        for (const obj of objects) {
            if (!obj.Key) continue

            // Skip if already in flat structure (no subdirectories)
            const parts = obj.Key.split("/")
            if (parts.length === 2) {
                // Already flat: products/file.jpg
                continue
            }

            // Extract filename from nested path
            // products/9599/image.jpg → image.jpg
            const filename = parts[parts.length - 1]
            const newKey = `${baseFolder}/${filename}`

            totalFound++

            // Check for duplicates
            if (seenFilenames.has(newKey)) {
                // Handle duplicate: add timestamp suffix
                const ext = filename.split(".").pop()
                const name = filename.replace(`.${ext}`, "")
                const newFilename = `${name}-${Date.now()}.${ext}`
                const uniqueKey = `${baseFolder}/${newFilename}`

                duplicates.push(filename)
                mappings.push({
                    oldKey: obj.Key,
                    newKey: uniqueKey,
                    size: obj.Size || 0,
                })
                seenFilenames.add(uniqueKey)
            } else {
                mappings.push({
                    oldKey: obj.Key,
                    newKey,
                    size: obj.Size || 0,
                })
                seenFilenames.add(newKey)
            }
        }

        continuationToken = response.NextContinuationToken
    } while (continuationToken)

    console.log(`  Found ${totalFound} files in nested folders`)
}

async function executeMoves(mappings: FileMapping[]) {
    let moved = 0
    const total = mappings.length

    for (const mapping of mappings) {
        try {
            // Copy to new location
            await s3Client.send(new CopyObjectCommand({
                Bucket: BUCKET,
                CopySource: `${BUCKET}/${mapping.oldKey}`,
                Key: mapping.newKey,
            }))

            // Delete old location
            await s3Client.send(new DeleteObjectCommand({
                Bucket: BUCKET,
                Key: mapping.oldKey,
            }))

            moved++
            if (moved % 50 === 0) {
                console.log(`  Progress: ${moved}/${total} files moved`)
            }
        } catch (error) {
            console.error(`  ❌ Failed to move: ${mapping.oldKey}`, error)
        }
    }

    console.log(`  ✅ Moved ${moved}/${total} files successfully`)
}

async function cleanupEmptyFolders() {
    console.log("\n🧹 Cleaning up empty folders...")
    // Note: S3/MinIO doesn't have "folders" - they're just key prefixes
    // Empty folders are automatically removed when last file is deleted
    console.log("  ✅ Empty folders automatically cleaned")
}

// Run script
const isDryRun = !process.argv.includes("--live")
reorganizeMinIO(isDryRun)
    .then(() => {
        process.exit(0)
    })
    .catch((err) => {
        console.error("❌ Reorganization failed:", err)
        process.exit(1)
    })

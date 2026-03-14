#!/usr/bin/env tsx

/**
 * PHASE 5B: Assign Category Thumbnails from MinIO
 * Searches for images in MinIO (categories/ folder) and assigns as thumbnail
 */

import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { Client as PgClient } from 'pg'
import dotenv from 'dotenv'

dotenv.config()

const s3Client = new S3Client({
    endpoint: process.env.MINIO_ENDPOINT!,
    region: 'us-east-1',
    credentials: {
        accessKeyId: process.env.MINIO_ACCESS_KEY!,
        secretAccessKey: process.env.MINIO_SECRET_KEY!
    },
    forcePathStyle: true
})

const BUCKET = process.env.MINIO_BUCKET || 'medusa-media'
const CATEGORY_FOLDER = 'categories/'

async function assignCategoryThumbnails() {
    const pgClient = new PgClient({
        connectionString: process.env.DATABASE_URL
    })

    try {
        await pgClient.connect()

        console.log('\n' + '='.repeat(80))
        console.log('🚀 PHASE 5B: ASSIGN CATEGORY THUMBNAILS FROM MINIO')
        console.log('='.repeat(80) + '\n')

        // Step 1: Get all MinIO files in categories/ folder
        console.log(`📥 Listing files in MinIO bucket: ${BUCKET}/${CATEGORY_FOLDER}...`)

        const minioFiles = new Map<string, string>()  // filename -> full path

        let continuationToken: string | undefined
        let totalFiles = 0

        do {
            const command = new ListObjectsV2Command({
                Bucket: BUCKET,
                Prefix: CATEGORY_FOLDER,
                ContinuationToken: continuationToken
            })

            const response = await s3Client.send(command)

            if (response.Contents) {
                for (const obj of response.Contents) {
                    if (obj.Key) {
                        const filename = obj.Key.split('/').pop() || ''
                        if (filename && !filename.startsWith('.')) {
                            minioFiles.set(filename.toLowerCase(), obj.Key)
                            totalFiles++
                        }
                    }
                }
            }

            continuationToken = response.NextContinuationToken
        } while (continuationToken)

        console.log(`   ✅ Found ${totalFiles} files in MinIO\n`)

        // Step 2: Get categories with woocommerce_image metadata
        const result = await pgClient.query(`
            SELECT id, name, handle, metadata, thumbnail
            FROM product_category
            WHERE metadata ? 'woocommerce_image'
        `)

        console.log(`📊 Categories with woocommerce_image: ${result.rows.length}\n`)

        // Step 3: Match and assign thumbnails
        console.log('🔗 Matching and assigning thumbnails...\n')

        let matched = 0
        let notFound = 0
        let alreadySet = 0
        const notFoundFiles: Array<{ name: string, filename: string }> = []

        for (const cat of result.rows) {
            const wooImage = cat.metadata.woocommerce_image
            const filename = wooImage.filename

            // Check if already has thumbnail
            if (cat.thumbnail) {
                console.log(`⏭️  ${cat.name} - Already has thumbnail: ${cat.thumbnail}`)
                alreadySet++
                continue
            }

            // Try to find in MinIO (case-insensitive)
            const minioPath = minioFiles.get(filename.toLowerCase())

            if (minioPath) {
                // Construct full URL
                const thumbnailUrl = `${process.env.MINIO_ENDPOINT}/${BUCKET}/${minioPath}`

                // Update category thumbnail
                await pgClient.query(`
                    UPDATE product_category
                    SET thumbnail = $1
                    WHERE id = $2
                `, [thumbnailUrl, cat.id])

                console.log(`✅ ${cat.name}`)
                console.log(`   File: ${filename}`)
                console.log(`   URL: ${thumbnailUrl}`)
                matched++
            } else {
                console.log(`❌ ${cat.name}`)
                console.log(`   File not found in MinIO: ${filename}`)
                notFound++
                notFoundFiles.push({ name: cat.name, filename })
            }
        }

        console.log('\n' + '='.repeat(80))
        console.log('🎉 PHASE 5B COMPLETE - THUMBNAILS ASSIGNED')
        console.log('='.repeat(80))
        console.log(`\n📊 Summary:`)
        console.log(`   Categories processed: ${result.rows.length}`)
        console.log(`   ✅ Thumbnails assigned: ${matched}`)
        console.log(`   ⏭️  Already had thumbnail: ${alreadySet}`)
        console.log(`   ❌ Not found in MinIO: ${notFound}`)

        if (notFoundFiles.length > 0) {
            console.log(`\n📋 Missing files in MinIO:`)
            notFoundFiles.forEach(item => {
                console.log(`   ${item.name}: ${item.filename}`)
            })
        }

        console.log(`\n📝 Action Required:`)
        console.log(`   1. Refresh Admin UI`)
        console.log(`   2. Navigate to categories`)
        console.log(`   3. Verify thumbnails are displayed`)

        if (notFound > 0) {
            console.log(`   4. Upload ${notFound} missing files to MinIO: ${BUCKET}/${CATEGORY_FOLDER}`)
        }

        console.log('\n✅ Migration complete!\n')

    } catch (error) {
        console.error('\n❌ Error:', (error as Error).message)
        if (error instanceof Error && error.stack) {
            console.error(error.stack)
        }
        process.exit(1)
    } finally {
        await pgClient.end()
    }
}

assignCategoryThumbnails()

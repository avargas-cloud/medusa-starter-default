import { loadEnv, defineConfig } from '@medusajs/framework/utils'

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET || "supersecret",
      cookieSecret: process.env.COOKIE_SECRET || "supersecret",
    },
    cookieOptions: {
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 10 * 60 * 60 * 1000, // 10 hours
    }
  },
  admin: {
    backendUrl: process.env.MEDUSA_BACKEND_URL || "https://medusa-starter-default-production-b69e.up.railway.app",
  },
  plugins: [
    // Deleted incompatible @medusajs/admin plugin
  ],
  modules: [
    {
      resolve: "@medusajs/medusa/event-bus-redis",
      options: {
        redisUrl: process.env.REDIS_URL,
      },
    },
    {
      resolve: "@medusajs/medusa/workflow-engine-redis",
      options: {
        redis: {
          redisUrl: process.env.REDIS_URL,
        },
      },
    },
    {
      resolve: "@medusajs/medusa/cache-redis",
      options: {
        redisUrl: process.env.REDIS_URL,
      },
    },
    {
      resolve: "@medusajs/medusa/locking",
      options: {
        providers: [
          {
            resolve: "@medusajs/medusa/locking-redis",
            id: "locking-redis",
            is_default: true,
            options: {
              redisUrl: process.env.REDIS_URL,
            },
          },
        ],
      },
    },
    {
      resolve: "./src/modules/product-attributes",
    },
    {
      resolve: "@medusajs/medusa/file",
      options: {
        providers: [
          {
            resolve: "./src/modules/smart-storage",
            id: "smart-s3",
            options: {
              file_url: process.env.MINIO_ENDPOINT ? `${process.env.MINIO_ENDPOINT}/${process.env.MINIO_BUCKET}` : "",
              accessKeyId: process.env.MINIO_ACCESS_KEY,
              secretAccessKey: process.env.MINIO_SECRET_KEY,
              region: "us-east-1",
              bucket: process.env.MINIO_BUCKET,
              endpoint: process.env.MINIO_ENDPOINT,
            },
          },
        ],
      },
    },
    {
      resolve: "@rokmohar/medusa-plugin-meilisearch",
      options: {
        config: {
          host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
          apiKey: process.env.MEILISEARCH_API_KEY || "masterKey",
        },
        settings: {
          products: {
            indexSettings: {
              searchableAttributes: [
                "title",
                "description",
                "handle",
                "variant_sku",
                "metadata_material",
                "metadata_category"
              ],
              displayedAttributes: [
                "id",
                "title",
                "handle",
                "thumbnail",
                "variant_sku",
                "metadata"
              ],
              sortableAttributes: [
                "title",
                "id",
                "created_at",
                "updated_at",
                "status"
              ],
              typoTolerance: {
                enabled: true,
                minWordSizeForTypos: {
                  oneTypo: 7,
                  twoTypos: 10,
                },
              },
            },
            primaryKey: "id",
            // Transformer: Flatten variant SKUs and metadata for searchability
            transformer: (product: any) => {
              return {
                id: product.id,
                title: product.title,
                description: product.description,
                handle: product.handle,
                thumbnail: product.thumbnail,
                // KEY: Extract all variant SKUs into flat array
                variant_sku: product.variants?.map((v: any) => v.sku).filter(Boolean) || [],
                // Index metadata for advanced filtering
                status: product.status, // ✅ CRITICAL: Required for table
                metadata: product.metadata || {},
                metadata_material: product.metadata?.material || null,
                metadata_category: product.metadata?.category || null,
              }
            }
          },
        },
      },
  ]
})

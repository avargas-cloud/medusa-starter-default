import { loadEnv, defineConfig } from '@medusajs/framework/utils'

console.log("🔵 Loading medusa-config.ts")
console.log("🔵 CWD:", process.cwd())
loadEnv(process.env.NODE_ENV || 'development', process.cwd())
console.log("🔵 REDIS_URL:", process.env.REDIS_URL ? "FOUND" : "MISSING")
console.log("🔵 DATABASE_URL:", process.env.DATABASE_URL ? "FOUND" : "MISSING")
console.log("🔵 WORKER_MODE:", process.env.WORKER_MODE || "NOT SET (will default to 'shared')")

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
    // CRITICAL: Enable subscribers by setting workerMode to 'shared'
    // Without this, subscribers will NOT load (even if code is correct)
    workerMode: (process.env.WORKER_MODE || "shared") as "shared" | "worker" | "server",
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
    // Google OAuth Authentication
    // TEMPORARILY DISABLED: Plugin causing build errors
    // {
    //   resolve: "medusa-plugin-auth",
    //   options: {
    //     strict: "store",  // Only for store (customers), not admin
    //     google: {
    //       clientID: process.env.GOOGLE_CLIENT_ID!,
    //       clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    //       store: {
    //         callbackUrl: `${process.env.MEDUSA_BACKEND_URL}/store/auth/google/callback`,
    //         successRedirect: `${process.env.STOREFRONT_URL}/account`,
    //         failureRedirect: `${process.env.STOREFRONT_URL}/login`,
    //         expiresIn: 7 * 24 * 3600 * 1000,  // 7 days
    //       },
    //       admin: {
    //         // Admin OAuth disabled - use email/password for staff
    //         callbackUrl: `${process.env.MEDUSA_BACKEND_URL}/admin/auth/google/callback`,
    //         successRedirect: `${process.env.MEDUSA_BACKEND_URL}/app`,
    //         failureRedirect: `${process.env.MEDUSA_BACKEND_URL}/app/login`,
    //       },
    //     },
    //   },
    // },
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
                "status",
                "metadata",
                "updated_at",
                "created_at"
              ],
              sortableAttributes: [
                "title",
                "id",
                "created_at",
                "updated_at",
                "status"
              ],
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
                // ✅ CRITICAL: Timestamps for O(1) sync staleness detection
                updated_at: new Date(product.updated_at).getTime(),
                created_at: new Date(product.created_at).getTime(),
              }
            }
          },
        },
      },
    },
  ]
})

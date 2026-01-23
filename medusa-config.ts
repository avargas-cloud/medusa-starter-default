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
      resolve: "@medusajs/file-s3",
      id: "file",
      options: {
        file_url: process.env.MINIO_ENDPOINT ? `${process.env.MINIO_ENDPOINT}/${process.env.MINIO_BUCKET}` : undefined,
        access_key_id: process.env.MINIO_ACCESS_KEY,
        secret_access_key: process.env.MINIO_SECRET_KEY,
        region: "us-east-1",
        bucket: process.env.MINIO_BUCKET,
        endpoint: process.env.MINIO_ENDPOINT,
        s3_force_path_style: true,
      },
    },
  ]
})

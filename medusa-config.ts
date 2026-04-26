// @ts-ignore — loadEnv and defineConfig exist at runtime but TypeScript types are missing in this Medusa version
import { loadEnv, defineConfig } from "@medusajs/framework/utils";

console.log("🔵 Loading medusa-config.ts");
console.log("🔵 CWD:", process.cwd());
loadEnv(process.env.NODE_ENV || "development", process.cwd());
console.log("🔵 REDIS_URL:", process.env.REDIS_URL ? "FOUND" : "MISSING");
console.log("🔵 DATABASE_URL:", process.env.DATABASE_URL ? "FOUND" : "MISSING");
console.log(
  "🔵 WORKER_MODE:",
  process.env.WORKER_MODE || "NOT SET (will default to 'shared')"
);

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    databaseDriverOptions: {
      connection: {
        ssl: {
          rejectUnauthorized: false,
        },
      },
      pool: {
        // min: 0 → Knex won't keep idle connections alive.
        // Railway proxy drops idle TCP connections after ~20-30s,
        // causing "Connection ended unexpectedly". No idle connections = no drops.
        min: 0,
        max: 10,
        idleTimeoutMillis: 20000, // close connections before Railway proxy does
        acquireTimeoutMillis: 30000,
      },
    },
    redisUrl: process.env.REDIS_URL,
    redisOptions: {
      connectTimeout: 45000,
      keepAlive: 10000, // TCP keepalive — prevents Railway proxy from dropping idle socket
      enableOfflineQueue: true,
      family: 4,
      retryStrategy: (times: number) => Math.min(times * 3000, 30000),
    },
    // CRITICAL: Enable subscribers by setting workerMode to 'shared'
    // Without this, subscribers will NOT load (even if code is correct)
    workerMode: (process.env.WORKER_MODE || "shared") as
      | "shared"
      | "worker"
      | "server",
    http: {
      // ✅ CORS: All origins must come from environment variables.
      // Set STORE_CORS, ADMIN_CORS, AUTH_CORS on Railway — no hardcoded fallbacks in production.
      storeCors:
        process.env.STORE_CORS ||
        (process.env.NODE_ENV === "production"
          ? "" // Must be set via STORE_CORS env var on Railway
          : "http://localhost:4321,https://localhost:4321,http://localhost:8000,https://docs.medusajs.com,http://localhost:3001"),

      adminCors:
        process.env.ADMIN_CORS ||
        (process.env.NODE_ENV === "production"
          ? "" // Must be set via ADMIN_CORS env var on Railway
          : "http://localhost:5173,http://localhost:9000,http://localhost:3001"),

      authCors:
        process.env.AUTH_CORS ||
        (process.env.NODE_ENV === "production"
          ? "" // Must be set via AUTH_CORS env var on Railway
          : "http://localhost:4321,https://localhost:4321,http://localhost:5173,http://localhost:9000,http://localhost:3001"),

      jwtSecret: process.env.JWT_SECRET || "supersecret",
      cookieSecret: process.env.COOKIE_SECRET || "supersecret",
      authMethodsPerActor: {
        user: ["emailpass"],
        customer: ["emailpass", "google"], // Enable email/password + Google OAuth
        pos_user: ["emailpass"], // POS-only staff accounts
      },
    },
    cookieOptions: {
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 10 * 60 * 60 * 1000, // 10 hours
    },
  },
  admin: {
    backendUrl:
      process.env.NODE_ENV === "production"
        ? "https://medusa-starter-default-production-b69e.up.railway.app"
        : "http://localhost:9000",
  },
  plugins: [
    // MinIO / S3 File Storage
    {
      resolve: "@medusajs/file-s3",
      options: {
        file_url: process.env.MINIO_ENDPOINT,
        access_key_id: process.env.MINIO_ACCESS_KEY,
        secret_access_key: process.env.MINIO_SECRET_KEY,
        region: "us-east-1", // MinIO doesn't use regions but SDK requires it
        bucket: process.env.MINIO_BUCKET,
        endpoint: process.env.MINIO_ENDPOINT,
        // MinIO-specific S3 settings
        s3_force_path_style: true, // Required for MinIO
        // Uncomment if MinIO uses self-signed certificate
        // s3_ssl_enabled: false,
      },
    },
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
    {
      resolve: "@medusajs/notification-sendgrid",
      options: {
        api_key: process.env.SENDGRID_API_KEY,
        from: process.env.SENDGRID_FROM || "noreply@ecopowertech.com",
      },
    },
  ],
  modules: [
    // ─── Payment Module ───────────────────────────────────────────────────────
    {
      resolve: "@medusajs/medusa/payment",
      options: {
        providers: [
          {
            resolve: "./src/modules/authorize-net",
            id: "authorize-net",
            options: {
              apiLoginId: process.env.AUTHORIZENET_API_LOGIN_ID,
              transactionKey: process.env.AUTHORIZENET_TRANSACTION_KEY,
              environment: process.env.AUTHORIZENET_ENVIRONMENT || "sandbox",
            },
          },
        ],
      },
    },
    // ─── Infrastructure Modules ───────────────────────────────────────────────
    {
      resolve: "@medusajs/medusa/event-bus-redis",
      options: {
        redisUrl: process.env.REDIS_URL,
        redisOptions: {
          connectTimeout: 45000,
          keepAlive: 10000,
          pingInterval: 20000, // Explicit PING to keep Railway proxy alive
          enableOfflineQueue: true,
          family: 4,
          retryStrategy: (times: number) => {
            return Math.min(times * 3000, 30000);
          },
        },
      },
    },
    {
      resolve: "@medusajs/medusa/workflow-engine-redis",
      options: {
        redis: {
          redisUrl: process.env.REDIS_URL,
          connectTimeout: 45000,
          keepAlive: 10000,
          pingInterval: 20000,
          enableOfflineQueue: true,
          family: 4,
          retryStrategy: (times: number) => {
            return Math.min(times * 3000, 30000);
          },
        },
      },
    },
    {
      resolve: "@medusajs/medusa/cache-redis",
      options: {
        redisUrl: process.env.REDIS_URL,
        redisOptions: {
          connectTimeout: 45000,
          keepAlive: 10000,
          pingInterval: 20000,
          enableOfflineQueue: true,
          family: 4,
          retryStrategy: (times: number) => {
            return Math.min(times * 3000, 30000);
          },
        },
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
              redisOptions: {
                connectTimeout: 45000,
                keepAlive: 10000,
                pingInterval: 20000,
                enableOfflineQueue: true,
                family: 4,
                retryStrategy: (times: number) => {
                  return Math.min(times * 3000, 30000);
                },
              },
            },
          },
        ],
      },
    },
    {
      resolve: "@medusajs/medusa/auth",
      options: {
        providers: [
          {
            resolve: "@medusajs/auth-emailpass",
            id: "emailpass",
            options: {
              // Hash settings for password (scrypt)
              hashConfig: {
                logN: 15,
                r: 8,
                p: 1,
              },
            },
          },
          ...(process.env.GOOGLE_CLIENT_ID
            ? [
                {
                  resolve: "@medusajs/auth-google",
                  id: "google",
                  options: {
                    clientId: process.env.GOOGLE_CLIENT_ID,
                    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
                    callbackUrl:
                      process.env.GOOGLE_CALLBACK_URL ||
                      (process.env.NODE_ENV === "production"
                        ? "https://medusa-starter-default-production-b69e.up.railway.app/auth/customer/google/callback"
                        : // Dev: Route through HTTPS frontend proxy to avoid Chrome HTTPS-First mode issues
                          // (backend is HTTP-only, Chrome auto-upgrades http://localhost:9000 → https → ERR_SSL)
                          `${process.env.STOREFRONT_URL || "https://localhost:4321"}/api/auth/google/callback`),
                  },
                },
              ]
            : []),
        ],
      },
    },
    {
      resolve: "./src/modules/product-attributes",
    },
    {
      resolve: "./src/modules/pos-user",
    },
    {
      resolve: "./src/modules/invoices",
    },
    {
      resolve: "./src/modules/credit_memos",
    },
    {
      resolve: "./src/modules/finance",
    },
    {
      resolve: "./src/modules/document-templates",
    },
    {
      resolve: "./src/modules/quickbooks-catalog",
    },
    {
      resolve: "./src/modules/inventory-count",
    },
    {
      resolve: "./src/modules/unmet-demand",
    },
    {
      resolve: "./src/modules/purchase-orders",
    },
    {
      resolve: "./src/modules/purchasing",
    },
    {
      resolve: "@medusajs/medusa/tax",
      options: {
        providers: [
          {
            resolve: "./src/modules/pos-tax",
            id: "pos-tax",
          },
        ],
      },
    },
    {
      resolve: "@medusajs/medusa/file",
      options: {
        providers: [
          {
            resolve: "./src/modules/smart-storage",
            id: "smart-s3",
            options: {
              file_url: process.env.MINIO_ENDPOINT
                ? `${process.env.MINIO_ENDPOINT}/${process.env.MINIO_BUCKET}`
                : "",
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
    // Fulfillment Module with Custom Providers
    {
      resolve: "@medusajs/medusa/fulfillment",
      options: {
        providers: [
          // Default manual fulfillment
          {
            resolve: "@medusajs/medusa/fulfillment-manual",
            id: "manual",
            options: {},
          },
          // Store Pickup - Always Free
          {
            resolve: "./src/modules/store-pickup",
            id: "store-pickup",
            options: {},
          },
          // Uber Shipping - Fixed price, POS only
          {
            resolve: "./src/modules/uber-shipping",
            id: "uber-shipping",
            options: {},
          },
          // Ground Shipping - Conditional Pricing
          {
            resolve: "./src/modules/ground-shipping",
            id: "ground-shipping",
            options: {},
          },
          // UPS Ground - Native UPS Ground Service
          {
            resolve: "./src/modules/ups-ground-shipping",
            id: "ups-ground",
            options: {
              clientId: process.env.UPS_CLIENT_ID,
              clientSecret: process.env.UPS_CLIENT_SECRET,
              serviceCode: "03",
              serviceName: "UPS Ground",
              shipperName: process.env.UPS_SHIPPER_NAME || "Ecopowertech",
              shipperAddressLine1: process.env.UPS_SHIPPER_ADDRESS_LINE1 || "",
              shipperCity: process.env.UPS_SHIPPER_CITY || "",
              shipperState: process.env.UPS_SHIPPER_STATE || "",
              shipperPostalCode: process.env.UPS_SHIPPER_POSTAL_CODE || "",
              shipperCountry: process.env.UPS_SHIPPER_COUNTRY || "US",
            },
          },
          // UPS Next Day Air
          {
            resolve: "./src/modules/ups-next-day-air",
            id: "ups-next-day-air",
            options: {
              clientId: process.env.UPS_CLIENT_ID,
              clientSecret: process.env.UPS_CLIENT_SECRET,
              serviceCode: "01",
              serviceName: "Next Day Air",
              shipperName: process.env.UPS_SHIPPER_NAME || "Ecopowertech",
              shipperAddressLine1: process.env.UPS_SHIPPER_ADDRESS_LINE1 || "",
              shipperCity: process.env.UPS_SHIPPER_CITY || "",
              shipperState: process.env.UPS_SHIPPER_STATE || "",
              shipperPostalCode: process.env.UPS_SHIPPER_POSTAL_CODE || "",
              shipperCountry: process.env.UPS_SHIPPER_COUNTRY || "US",
            },
          },
          // UPS 2nd Day Air
          {
            resolve: "./src/modules/ups-2nd-day-air",
            id: "ups-2nd-day-air",
            options: {
              clientId: process.env.UPS_CLIENT_ID,
              clientSecret: process.env.UPS_CLIENT_SECRET,
              serviceCode: "02",
              serviceName: "2nd Day Air",
              shipperName: process.env.UPS_SHIPPER_NAME || "Ecopowertech",
              shipperAddressLine1: process.env.UPS_SHIPPER_ADDRESS_LINE1 || "",
              shipperCity: process.env.UPS_SHIPPER_CITY || "",
              shipperState: process.env.UPS_SHIPPER_STATE || "",
              shipperPostalCode: process.env.UPS_SHIPPER_POSTAL_CODE || "",
              shipperCountry: process.env.UPS_SHIPPER_COUNTRY || "US",
            },
          },
          // UPS 3 Day Select
          {
            resolve: "./src/modules/ups-3-day-select",
            id: "ups-3-day-select",
            options: {
              clientId: process.env.UPS_CLIENT_ID,
              clientSecret: process.env.UPS_CLIENT_SECRET,
              serviceCode: "12",
              serviceName: "3 Day Select",
              shipperName: process.env.UPS_SHIPPER_NAME || "Ecopowertech",
              shipperAddressLine1: process.env.UPS_SHIPPER_ADDRESS_LINE1 || "",
              shipperCity: process.env.UPS_SHIPPER_CITY || "",
              shipperState: process.env.UPS_SHIPPER_STATE || "",
              shipperPostalCode: process.env.UPS_SHIPPER_POSTAL_CODE || "",
              shipperCountry: process.env.UPS_SHIPPER_COUNTRY || "US",
            },
          },
        ],
      },
    },
    // Railway Meilisearch connection in plugin causes 40-60s startup delay, testing if it's acceptable
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
                "metadata_category",
              ],
              displayedAttributes: [
                "id",
                "title",
                "handle",
                "thumbnail",
                "variant_sku",
                "status",
                "metadata",
                "description",
                "category_handles",
                "updated_at",
                "created_at",
              ],
              sortableAttributes: [
                "title",
                "id",
                "created_at",
                "updated_at",
                "status",
              ],
              filterableAttributes: [
                "status",
                "id",
                "variant_sku",
                "category_handles",
                "metadata_category",
                "metadata_material",
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
                variant_sku:
                  product.variants?.map((v: any) => v.sku).filter(Boolean) ||
                  [],
                // Index metadata for advanced filtering
                status: product.status, // ✅ CRITICAL: Required for table
                metadata: product.metadata || {},
                metadata_material: product.metadata?.material || null,
                metadata_category: product.metadata?.category || null,
                category_handles:
                  product.categories?.map((c: any) => c.handle).filter(Boolean) || [],
                // ✅ CRITICAL: Timestamps for O(1) sync staleness detection
                updated_at: new Date(product.updated_at).getTime(),
                created_at: new Date(product.created_at).getTime(),
              };
            },
          },
          customers: {
            indexSettings: {
              searchableAttributes: [
                "email",
                "first_name",
                "last_name",
                "company_name",
                "phone",
              ],
              filterableAttributes: [
                "customer_type",
                "price_level",
                "has_account",
                "groups",
                "status",
              ],
              displayedAttributes: [
                "id",
                "email",
                "first_name",
                "last_name",
                "company_name",
                "phone",
                "has_account",
                "groups",
                "metadata",
                "created_at",
                "updated_at",
                "customer_type",
                "price_level",
                "acquisition_channel",
                "list_id",
                "status",
              ],
            },
            primaryKey: "id",
            transformer: (customer: any) => {
              const meta = customer.metadata || {};
              const groupNames = customer.groups?.map((g: any) => g.name) || [];
              let priceLevel = "Retail";
              if (groupNames.includes("Wholesale")) priceLevel = "Wholesale";
              if (meta.price_level || meta.qb_price_level)
                priceLevel = meta.price_level || meta.qb_price_level;

              return {
                id: customer.id,
                email: customer.email,
                first_name: customer.first_name,
                last_name: customer.last_name,
                company_name: customer.company_name,
                phone: customer.phone,
                has_account: customer.has_account,
                status: customer.has_account ? "Registered" : "Guest",
                groups: groupNames,
                metadata: meta,
                created_at: new Date(customer.created_at).getTime(),
                updated_at: new Date(customer.updated_at).getTime(),

                // Extracted top-level fields for the POS table view
                customer_type:
                  meta.qb_customer_type || meta.customer_type || "Standard",
                price_level: priceLevel,
                acquisition_channel: meta.acquisition_channel || "",
                list_id: meta.qb_list_id || "",
              };
            },
          },
        },
      },
    },
  ],
});

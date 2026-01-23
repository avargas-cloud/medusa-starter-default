import Medusa from "@medusajs/js-sdk"

export const sdk = new Medusa({
    baseUrl: process.env.MEDUSA_BACKEND_URL || "https://medusa-starter-default-production-b69e.up.railway.app",
    debug: process.env.NODE_ENV === "development",
    auth: {
        type: "session",
    },
})

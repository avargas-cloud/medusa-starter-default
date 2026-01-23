import Medusa from "@medusajs/js-sdk"

export let BASE_URL = "http://localhost:9000"

// Robust URL resolution for both Browser (Admin UI) and Node (Server scripts)
if (typeof window !== "undefined") {
    // Browser: Use localhost if on localhost, otherwise assume production
    BASE_URL = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
        ? "http://localhost:9000"
        : "https://medusa-starter-default-production-b69e.up.railway.app"
} else if (typeof process !== "undefined" && process.env?.MEDUSA_BACKEND_URL) {
    // Node: Use env var
    BASE_URL = process.env.MEDUSA_BACKEND_URL
} else {
    // Fallback
    BASE_URL = "https://medusa-starter-default-production-b69e.up.railway.app"
}

export const sdk = new Medusa({
    baseUrl: BASE_URL,
    debug: false,
    auth: {
        type: "session",
    },
})

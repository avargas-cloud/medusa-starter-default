import type { MiddlewaresConfig } from "@medusajs/medusa"

export const config: MiddlewaresConfig = {
    routes: [
        {
            matcher: "/admin/*",
            middlewares: [],
        },
        {
            matcher: "/store/*",
            middlewares: [],
        },
    ],
}

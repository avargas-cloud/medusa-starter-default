import { defineMiddlewares, authenticate } from "@medusajs/framework/http"

export default defineMiddlewares({
    routes: [
        {
            matcher: "/admin/attributes*",
            middlewares: [
                (req, res, next) => {
                    console.log(`🔍 [Middleware] Request to ${req.originalUrl || req.url}`)
                    console.log(`🔍 [Middleware] Cookies present: ${!!req.headers.cookie}`)
                    next()
                },
                authenticate("user", ["session", "bearer", "api-key"])
            ],
        },
        {
            matcher: "/admin/attribute-sets*",
            middlewares: [authenticate("user", ["session", "bearer", "api-key"])],
        },
        {
            matcher: "/admin/products/:id/attributes",
            middlewares: [authenticate("user", ["session", "bearer", "api-key"])],
        },
        {
            matcher: "/admin/products/:id/attributes/batch",
            middlewares: [authenticate("user", ["session", "bearer", "api-key"])],
        }
    ],
})

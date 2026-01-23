import { defineMiddlewares } from "@medusajs/medusa"
import { authenticate } from "@medusajs/medusa"

export default defineMiddlewares({
    routes: [
        {
            matcher: "/admin/attributes*",
            middlewares: [authenticate("user", ["session", "bearer", "api-key"])],
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

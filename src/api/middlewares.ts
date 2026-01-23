import { defineMiddlewares, authenticate } from "@medusajs/framework/http"

export default defineMiddlewares({
    routes: [
        {
            matcher: "/admin/attributes*",
            middlewares: [authenticate(["user", "admin"], ["session", "bearer", "api-key"])],
        },
        {
            matcher: "/admin/attribute-sets*",
            middlewares: [authenticate(["user", "admin"], ["session", "bearer", "api-key"])],
        },
        {
            matcher: "/admin/products/:id/attributes",
            middlewares: [authenticate(["user", "admin"], ["session", "bearer", "api-key"])],
        },
        {
            matcher: "/admin/products/:id/attributes/batch",
            middlewares: [authenticate(["user", "admin"], ["session", "bearer", "api-key"])],
        }
    ],
})

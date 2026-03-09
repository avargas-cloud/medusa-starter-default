import { defineMiddlewares } from "@medusajs/medusa"
import { addCategoryBreadcrumbs } from "./middlewares/add-category-breadcrumbs"

export default defineMiddlewares({
  routes: [
    {
      matcher: "/store/product-categories/:id",
      method: "GET",
      middlewares: [
        addCategoryBreadcrumbs,
      ],
    },
  ],
})

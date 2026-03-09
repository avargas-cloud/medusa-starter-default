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
    {
      matcher: "/store/product-categories",
      method: "GET",
      middlewares: [
        (req, res, next) => {
          // Clone the query into scope so route.ts can read the "draft" filters
          req.scope.register({
            customQueryParams: {
              resolve: () => ({
                is_active: req.query.is_active,
                is_internal: req.query.is_internal,
                parent_category_id: req.query.parent_category_id
              })
            }
          });

          // Delete the problematic keys from req.query so Medusa core validation passes
          if (req.query.is_active !== undefined) delete req.query.is_active;
          if (req.query.is_internal !== undefined) delete req.query.is_internal;
          if (req.query.parent_category_id !== undefined) delete req.query.parent_category_id;

          next();
        }
      ],
    }
  ],
})

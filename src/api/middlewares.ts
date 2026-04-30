import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { defineMiddlewares } from "@medusajs/medusa";

import { addCategoryBreadcrumbs } from "./middlewares/add-category-breadcrumbs";
import { syncCustomerMeili } from "./middlewares/sync-customer-meili";
import { validateDraftOrderCustomer } from "./middlewares/validate-draft-order-customer";

// Inline CORS middleware for /pos/* routes.
// Reads STORE_CORS env var — same origins as the storefront.
// No external `cors` npm dep needed.
const posAllowedOrigins = new Set(
  (process.env.STORE_CORS || "http://localhost:3001,http://localhost:3000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

function posCorsMiddleware(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  const origin = req.headers.origin ?? "";
  if (posAllowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,POST,PATCH,PUT,DELETE,OPTIONS"
    );
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type,Authorization,x-publishable-api-key"
    );
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}

// Open CORS for /pub/* — these are genuinely public endpoints (no auth, no publishable key).
// Any origin may call them (branding data, etc.).
function pubCorsMiddleware(
  _req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (_req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}

export default defineMiddlewares({
  routes: [
    // Increase body parser limit for send-email routes — extra attachments arrive as base64
    {
      matcher: "/admin/draft-orders/:id/send-email",
      method: "POST",
      bodyParser: { sizeLimit: "50mb" },
      middlewares: [],
    },
    // pdf-link receives posState (localStorage snapshot w/ attached base64 images).
    // Default 100kb is too tight; 2mb is ~10× the realistic max usage.
    {
      matcher: "/admin/draft-orders/:id/pdf-link",
      method: "POST",
      bodyParser: { sizeLimit: "2mb" },
      middlewares: [],
    },
    // CORS for POS-specific routes (no Medusa auth gating — validated in-route)
    {
      matcher: "/pos/*",
      middlewares: [posCorsMiddleware],
    },
    // Open CORS for public endpoints (no publishable key required)
    {
      matcher: "/pub/*",
      middlewares: [pubCorsMiddleware],
    },
    {
      matcher: "/store/product-categories/:id",
      method: "GET",
      middlewares: [addCategoryBreadcrumbs],
    },
    // Sync edited customer to MeiliSearch after a successful PATCH.
    {
      matcher: "/admin/customers/:id",
      method: ["PATCH"],
      middlewares: [syncCustomerMeili],
    },
    // Guard against zombie-customer creation in Medusa's findOrCreateCustomerStep.
    // Runs before createOrderWorkflow on POST /admin/draft-orders.
    {
      matcher: "/admin/draft-orders",
      method: ["POST"],
      middlewares: [validateDraftOrderCustomer],
    },
  ],
});

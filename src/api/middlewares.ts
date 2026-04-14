import { defineMiddlewares } from "@medusajs/medusa";
import { addCategoryBreadcrumbs } from "./middlewares/add-category-breadcrumbs";
import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";

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
  ],
});

import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { defineMiddlewares } from "@medusajs/medusa";

import { addCategoryBreadcrumbs } from "./middlewares/add-category-breadcrumbs";
import {
  protectClosedDocument,
  rejectClosedEffectiveDate,
} from "./middlewares/closed-accounting-period";
import { idempotency } from "./middlewares/idempotency";
import { syncCustomerMeili } from "./middlewares/sync-customer-meili";
import { validateDraftOrderCustomer } from "./middlewares/validate-draft-order-customer";

// Inline CORS middleware for /pos/* routes.
// Reads STORE_CORS env var — same origins as the storefront.
// Each entry may be a literal origin OR a regex wrapped in slashes
// (e.g. `/^https?:\/\/.+\.vercel\.app$/`), mirroring Medusa's
// parseCorsOrigins so preview wildcards work the same way as /store/*.
type CorsRule = { kind: "literal"; value: string } | { kind: "regex"; value: RegExp };

function parsePosCorsEntries(raw: string): CorsRule[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map<CorsRule>((entry) => {
      const m = entry.match(/^([/~@;%#'])(.*?)\1([gimsuy]*)$/);
      if (m) {
        try {
          return { kind: "regex", value: new RegExp(m[2] ?? "", m[3] ?? "") };
        } catch {
          /* fall through to literal */
        }
      }
      return { kind: "literal", value: entry };
    });
}

const posAllowedOrigins = parsePosCorsEntries(
  process.env.STORE_CORS || "http://localhost:3001,http://localhost:3000"
);

function originAllowed(origin: string): boolean {
  if (!origin) return false;
  for (const rule of posAllowedOrigins) {
    if (rule.kind === "literal") {
      if (rule.value === origin) return true;
    } else if (rule.value.test(origin)) {
      return true;
    }
  }
  return false;
}

function posCorsMiddleware(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
) {
  const origin = req.headers.origin ?? "";
  if (originAllowed(origin)) {
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
    // Accounting period lock. Historical document content is immutable after
    // close; explicit later-period operations (payments, PO receipts and
    // order→invoice creation) remain available through their own routes.
    {
      matcher: "/admin/orders/:id/*",
      method: ["POST", "PATCH", "PUT", "DELETE"],
      middlewares: [protectClosedDocument("order")],
    },
    {
      matcher: "/admin/orders/:id",
      method: ["POST", "PATCH", "PUT", "DELETE"],
      middlewares: [protectClosedDocument("order")],
    },
    {
      matcher: "/admin/invoices/:id/*",
      method: ["POST", "PATCH", "PUT", "DELETE"],
      middlewares: [protectClosedDocument("invoice")],
    },
    {
      matcher: "/admin/invoices/:id",
      method: ["PATCH", "PUT", "DELETE"],
      middlewares: [protectClosedDocument("invoice")],
    },
    {
      matcher: "/admin/pos/credit_memos/:id/*",
      method: ["POST", "PATCH", "PUT", "DELETE"],
      middlewares: [protectClosedDocument("credit_memo")],
    },
    {
      matcher: "/admin/pos/credit_memos/:id",
      method: ["PATCH", "PUT", "DELETE"],
      middlewares: [protectClosedDocument("credit_memo")],
    },
    {
      matcher: "/admin/purchase-orders/:id/*",
      method: ["POST", "PATCH", "PUT", "DELETE"],
      middlewares: [protectClosedDocument("purchase_order")],
    },
    {
      matcher: "/admin/purchase-orders/:id",
      method: ["PATCH", "PUT", "DELETE"],
      middlewares: [protectClosedDocument("purchase_order")],
    },
    {
      matcher: "/admin/vendor-bills/:id/*",
      method: ["POST", "PATCH", "PUT", "DELETE"],
      middlewares: [protectClosedDocument("vendor_bill")],
    },
    {
      matcher: "/admin/vendor-bills/:id",
      method: ["PATCH", "PUT", "DELETE"],
      middlewares: [protectClosedDocument("vendor_bill")],
    },
    {
      matcher: "/admin/inventory-counts/:id/*",
      method: ["POST", "PATCH", "PUT", "DELETE"],
      middlewares: [protectClosedDocument("inventory_count")],
    },
    {
      matcher: "/admin/inventory-counts/:id",
      method: ["PATCH", "PUT", "DELETE"],
      middlewares: [protectClosedDocument("inventory_count")],
    },
    {
      matcher: "/admin/invoices",
      method: "POST",
      middlewares: [rejectClosedEffectiveDate],
    },
    {
      matcher: "/admin/vendor-bills",
      method: "POST",
      middlewares: [rejectClosedEffectiveDate],
    },
    {
      matcher: "/admin/purchase-orders",
      method: "POST",
      middlewares: [rejectClosedEffectiveDate],
    },
    // Increase body parser limit for send-email routes — extra attachments arrive as base64
    {
      matcher: "/admin/draft-orders/:id/send-email",
      method: "POST",
      bodyParser: { sizeLimit: "50mb" },
      middlewares: [],
    },
    {
      matcher: "/admin/purchase-orders/:id/send-email",
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
    // Uber Direct webhook: HMAC (X-Uber-Signature) verifies the RAW bytes —
    // re-stringified JSON does not round-trip byte-identically in Node.
    {
      matcher: "/pub/webhooks/uber",
      method: "POST",
      bodyParser: { preserveRawBody: true },
      middlewares: [],
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
      middlewares: [
        validateDraftOrderCustomer,
        idempotency("admin.draft-orders.create"),
      ],
    },
    // ── Idempotency-Key dedup (Phase 3a) — blocks same-key double-submit on
    // these create routes. No-op unless the client sends an Idempotency-Key.
    {
      matcher: "/admin/trip-objectives/objectives",
      method: ["POST"],
      middlewares: [idempotency("admin.trip-objectives.objectives")],
    },
    {
      matcher: "/admin/customer-payments",
      method: ["POST"],
      middlewares: [idempotency("admin.customer-payments")],
    },
    {
      matcher: "/admin/china-finance/wire-transfers",
      method: ["POST"],
      middlewares: [idempotency("admin.china-finance.wire-transfers")],
    },
    {
      matcher: "/admin/qb-catalog/vendors",
      method: ["POST"],
      middlewares: [idempotency("admin.qb-catalog.vendors")],
    },
    // Label purchases must never double-run (a dup buys a second label). The
    // route ALSO claims order_delivery.idempotency_key domain-side (resume
    // without re-buying); this middleware adds the in-flight 409 + replay.
    {
      matcher: "/admin/orders/:id/create-shipment",
      method: ["POST"],
      middlewares: [idempotency("admin.orders.create-shipment")],
    },
    // Local Delivery handoff (own driver) — fulfills + ships + marks
    // delivered in one shot; a double-click must replay, never re-run.
    {
      matcher: "/admin/orders/:id/driver-delivery",
      method: ["POST"],
      middlewares: [idempotency("admin.orders.driver-delivery")],
    },
  ],
});

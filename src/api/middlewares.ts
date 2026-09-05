import { authenticate } from "@medusajs/framework/http";
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
import { protectSupervisorPin } from "./middlewares/protect-supervisor-pin";
import { protectWebOrderFields } from "./middlewares/protect-web-order-fields";
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
    // El PIN de supervisor NO se cambia por la ruta nativa de Medusa. Vive en
    // `store.metadata`, y `POST /admin/stores/:id` acepta cualquier metadata sin
    // saber nada de PINes — así que cualquier cajero (todos son usuarios admin
    // en este sistema) podía reemplazarlo SIN conocer el anterior y pasarse
    // todos los gates, incluidos los que sí verifican del lado del servidor.
    // El único camino legítimo es POST /admin/pos/supervisor-pin.
    {
      matcher: "/admin/stores/:id",
      method: ["POST", "PATCH", "PUT"],
      middlewares: [protectSupervisorPin],
    },
    {
      matcher: "/admin/stores",
      method: ["POST", "PATCH", "PUT"],
      middlewares: [protectSupervisorPin],
    },
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
    // Campos de contrato de una orden WEB por la ruta nativa → PIN de
    // supervisor. La metadata operativa pasa libre; órdenes POS no se tocan.
    {
      matcher: "/admin/orders/:id",
      method: ["POST", "PATCH", "PUT"],
      middlewares: [protectWebOrderFields],
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
    {
      matcher: "/admin/factory-orders/:id/send-email",
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
    // POS-specific routes: CORS **y autenticación**.
    //
    // Hasta el 2026-09-05 acá sólo estaba `posCorsMiddleware`, con el comentario
    // "no Medusa auth gating — validated in-route". Esa validación in-route no
    // existía en ningún handler: `grep -rn "auth_context" src/api/pos/` no
    // devolvía una sola coincidencia real. El malentendido está escrito en
    // `pos/document-templates/route.ts`: "POS users authenticate with pos_user
    // tokens which satisfy storeCors auth". **CORS no autentica.** Es una
    // instrucción para navegadores; `curl` la ignora, y por eso
    // `GET /pos/document-templates` contestaba 200 con 390 KB sin un solo
    // header, mientras `/admin/document-templates` contestaba 401.
    //
    // El actor es `user` (admin de Medusa): el POS loguea contra
    // `/auth/user/emailpass` y ya manda el Bearer en cada llamada
    // (`store-pos/hooks/useDocumentTemplates.ts` vía `medusaFetch`, con
    // `enabled: !!token`), así que esto NO requiere ningún cambio de frontend.
    //
    // El ORDEN importa dos veces: `posCorsMiddleware` corta el preflight OPTIONS
    // con 204 antes de que `authenticate` lo vea, y deja puestas las cabeceras
    // CORS antes de que un 401 salga — si no, el navegador reportaría un error
    // de CORS en vez del 401 real y el síntoma sería indescifrable.
    {
      matcher: "/pos/*",
      middlewares: [posCorsMiddleware, authenticate("user", ["bearer", "session"])],
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
    // The POS estimate save (create branch) orchestrates draft creation + N
    // add-item-force calls from the browser. Without a key here, a double-submit
    // creates a SECOND estimate outright — the native /admin/draft-orders guard
    // above never sees it, because sync-pos calls that route server-side and
    // does NOT forward the client's Idempotency-Key. The POS sends a key only on
    // action:"create"; an update save is a legitimate repeat and must not dedup.
    {
      matcher: "/admin/draft-orders/sync-pos",
      method: ["POST"],
      middlewares: [idempotency("admin.draft-orders.sync-pos")],
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

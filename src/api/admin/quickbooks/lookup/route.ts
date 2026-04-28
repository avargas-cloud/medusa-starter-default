import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";

import {
  bridgeFetch,
  POLL_INTERVAL_MS,
  MAX_POLL_ATTEMPTS,
} from "../../../../lib/quickbooks/client/core";

type QbDocType =
  | "Estimate"
  | "SalesOrder"
  | "Invoice"
  | "SalesReceipt"
  | "CreditMemo"
  | "Check"
  | "ReceivePayment"
  | "PurchaseOrder"
  | "Customer"
  | "Item";

type CustomerSearchField = "fullName" | "companyName" | "email";
type CustomerMatchMode = "exact" | "contains";

interface DocTypeConfig {
  queryElement: string;
  retElement: string;
  rsElement: string;
}

const DOC_TYPE_CONFIG: Record<
  Exclude<QbDocType, "Customer" | "Item">,
  DocTypeConfig
> = {
  Estimate: {
    queryElement: "EstimateQueryRq",
    retElement: "EstimateRet",
    rsElement: "EstimateQueryRs",
  },
  SalesOrder: {
    queryElement: "SalesOrderQueryRq",
    retElement: "SalesOrderRet",
    rsElement: "SalesOrderQueryRs",
  },
  Invoice: {
    queryElement: "InvoiceQueryRq",
    retElement: "InvoiceRet",
    rsElement: "InvoiceQueryRs",
  },
  SalesReceipt: {
    queryElement: "SalesReceiptQueryRq",
    retElement: "SalesReceiptRet",
    rsElement: "SalesReceiptQueryRs",
  },
  CreditMemo: {
    queryElement: "CreditMemoQueryRq",
    retElement: "CreditMemoRet",
    rsElement: "CreditMemoQueryRs",
  },
  Check: {
    queryElement: "CheckQueryRq",
    retElement: "CheckRet",
    rsElement: "CheckQueryRs",
  },
  ReceivePayment: {
    queryElement: "ReceivePaymentQueryRq",
    retElement: "ReceivePaymentRet",
    rsElement: "ReceivePaymentQueryRs",
  },
  PurchaseOrder: {
    queryElement: "PurchaseOrderQueryRq",
    retElement: "PurchaseOrderRet",
    rsElement: "PurchaseOrderQueryRs",
  },
};

const VALID_DOC_TYPES: QbDocType[] = [
  ...(Object.keys(DOC_TYPE_CONFIG) as Exclude<QbDocType, "Customer" | "Item">[]),
  "Customer",
  "Item",
];

const ITEM_RET_KEYS = [
  "ItemServiceRet",
  "ItemInventoryRet",
  "ItemNonInventoryRet",
  "ItemOtherChargeRet",
  "ItemDiscountRet",
  "ItemPaymentRet",
  "ItemSalesTaxRet",
  "ItemGroupRet",
  "ItemInventoryAssemblyRet",
  "ItemFixedAssetRet",
];

/**
 * POST /admin/quickbooks/lookup
 *
 * Queries QB Bridge for a document by doc type and identifier.
 *
 * Transactional doc types (Estimate, SalesOrder, Invoice, etc.):
 *   Body: { docType, refNumber }
 *   Returns: { success, txnId, refNumber, docType, customerName?, amount? }
 *
 * Customer:
 *   Body: { docType: "Customer", customerSearch: { field, value, matchMode? } }
 *   Returns: { success, results: CustomerHit[] }
 *
 * Item:
 *   Body: { docType: "Item", refNumber: <SKU> }
 *   Returns: { success, results: ItemHit[] }
 */
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  const body = (req.body ?? {}) as {
    docType?: string;
    refNumber?: string;
    customerSearch?: {
      field?: CustomerSearchField;
      value?: string;
      matchMode?: CustomerMatchMode;
    };
  };
  const docType = body.docType;

  if (!docType || !VALID_DOC_TYPES.includes(docType as QbDocType)) {
    res
      .status(400)
      .json({ error: `docType must be one of: ${VALID_DOC_TYPES.join(", ")}` });
    return;
  }

  if (docType === "Customer") {
    return handleCustomerLookup(body.customerSearch ?? {}, res);
  }
  if (docType === "Item") {
    return handleItemLookup(body.refNumber ?? "", res);
  }

  if (!body.refNumber?.trim()) {
    res.status(400).json({ error: "refNumber is required" });
    return;
  }

  const cfg =
    DOC_TYPE_CONFIG[docType as Exclude<QbDocType, "Customer" | "Item">];
  const ref = body.refNumber.trim();

  const qbxml = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<?qbxml version="10.0"?>`,
    `<QBXML><QBXMLMsgsRq onError="stopOnError">`,
    `<${cfg.queryElement} requestID="1">`,
    `<RefNumber>${ref}</RefNumber>`,
    `</${cfg.queryElement}>`,
    `</QBXMLMsgsRq></QBXML>`,
  ].join("");

  try {
    const rawResult = await runDirectQuery(qbxml);

    // Unwrap the nested QB response envelope
    const qbMsgs: Record<string, unknown> =
      (rawResult as any)?.QBXML?.QBXMLMsgsRs ??
      (rawResult as any)?.QBXMLMsgsRs ??
      rawResult;

    const retRaw: unknown =
      (qbMsgs as any)?.[cfg.rsElement]?.[cfg.retElement] ??
      (rawResult as any)?.[cfg.rsElement]?.[cfg.retElement] ??
      (rawResult as any)?.[cfg.retElement];

    if (!retRaw) {
      res
        .status(404)
        .json({ error: `${docType} #${ref} not found in QuickBooks` });
      return;
    }

    const doc: Record<string, any> = Array.isArray(retRaw) ? retRaw[0] : retRaw;
    const txnId: string = doc.TxnID || "";

    if (!txnId) {
      res
        .status(404)
        .json({ error: `${docType} #${ref} returned no TxnID from QB` });
      return;
    }

    // Extract optional enrichment fields (varies by doc type)
    const customerName: string =
      doc.CustomerRef?.FullName ||
      doc.PayeeEntityRef?.FullName ||
      doc.EntityRef?.FullName ||
      "";

    const amount: number =
      parseFloat(
        doc.Subtotal || doc.TotalAmount || doc.Amount || doc.TxnAmount || "0"
      ) || 0;

    const editSequence: string = doc.EditSequence || "";

    res.json({
      success: true,
      txnId,
      editSequence: editSequence || null,
      refNumber: ref,
      docType,
      customerName: customerName || null,
      amount: amount || null,
    });
  } catch (error: unknown) {
    const msg =
      error instanceof Error ? error.message : "Failed to look up TXIND";
    console.error(`[QB Lookup ${docType} #${body.refNumber}] Error:`, error);
    res.status(500).json({ error: msg });
  }
}

// ─── Bridge helpers ────────────────────────────────────────────────────────

async function runDirectQuery(qbxml: string): Promise<Record<string, unknown>> {
  const enqueueRes = await bridgeFetch("POST", "/api/sync/direct-query", {
    qbxml,
  });
  const operationId: string =
    enqueueRes?.operationId || enqueueRes?.operation_id;
  if (!operationId) throw new Error("Bridge did not return operationId");

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const statusRes = await bridgeFetch(
      "GET",
      `/api/sync/status/${operationId}`
    );
    const op = statusRes?.operation;
    if (!op) continue;
    if (op.status === "completed") {
      return op.result as Record<string, unknown>;
    }
    if (op.status === "failed") {
      throw new Error(`QB query failed: ${op.error || "Unknown error"}`);
    }
  }
  throw new Error(
    "QB query timed out — QuickBooks Desktop may be offline or QBWC not connected"
  );
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ─── Customer lookup ───────────────────────────────────────────────────────

async function handleCustomerLookup(
  search: {
    field?: CustomerSearchField;
    value?: string;
    matchMode?: CustomerMatchMode;
  },
  res: MedusaResponse
): Promise<void> {
  const field = search.field;
  const value = (search.value ?? "").trim();
  const matchMode: CustomerMatchMode = search.matchMode ?? "exact";

  if (!field || !["fullName", "companyName", "email"].includes(field)) {
    res.status(400).json({
      error: "customerSearch.field must be one of: fullName, companyName, email",
    });
    return;
  }
  if (!value) {
    res.status(400).json({ error: "customerSearch.value is required" });
    return;
  }

  // Build CustomerQueryRq:
  //   fullName + exact    → <FullName> filter (single match)
  //   fullName + contains → <NameFilter><MatchCriterion>Contains</MatchCriterion>
  //   companyName / email → fetch a page (MaxReturned=200) and filter server-side
  let filterXml = "";
  let postFilter:
    | { field: "CompanyName" | "Email"; value: string }
    | null = null;

  if (field === "fullName") {
    if (matchMode === "exact") {
      filterXml = `<FullName>${escapeXml(value)}</FullName>`;
    } else {
      filterXml =
        `<NameFilter>` +
        `<MatchCriterion>Contains</MatchCriterion>` +
        `<Name>${escapeXml(value)}</Name>` +
        `</NameFilter>` +
        `<MaxReturned>50</MaxReturned>` +
        `<ActiveStatus>All</ActiveStatus>`;
    }
  } else {
    filterXml =
      `<MaxReturned>5000</MaxReturned>` + `<ActiveStatus>All</ActiveStatus>`;
    postFilter = {
      field: field === "companyName" ? "CompanyName" : "Email",
      value: value.toLowerCase(),
    };
  }

  const qbxml = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<?qbxml version="10.0"?>`,
    `<QBXML><QBXMLMsgsRq onError="stopOnError">`,
    `<CustomerQueryRq requestID="1">`,
    filterXml,
    `<OwnerID>0</OwnerID>`,
    `</CustomerQueryRq>`,
    `</QBXMLMsgsRq></QBXML>`,
  ].join("");

  try {
    const rawResult = await runDirectQuery(qbxml);
    const qbMsgs: Record<string, unknown> =
      (rawResult as any)?.QBXML?.QBXMLMsgsRs ??
      (rawResult as any)?.QBXMLMsgsRs ??
      rawResult;

    const retRaw: unknown =
      (qbMsgs as any)?.CustomerQueryRs?.CustomerRet ??
      (rawResult as any)?.CustomerQueryRs?.CustomerRet;

    const docs: Record<string, any>[] = !retRaw
      ? []
      : Array.isArray(retRaw)
        ? retRaw
        : [retRaw];

    console.log(
      `[QB Lookup Customer ${field}=${value}] QB returned ${docs.length} customers (postFilter=${postFilter ? postFilter.field : "none"})`
    );

    const filtered = postFilter
      ? docs.filter((d) =>
          (d[postFilter!.field] ?? "")
            .toString()
            .toLowerCase()
            .includes(postFilter!.value)
        )
      : docs;

    console.log(
      `[QB Lookup Customer ${field}=${value}] After filter: ${filtered.length} matches`
    );

    const results = filtered.map((d) => ({
      listId: d.ListID || "",
      editSequence: d.EditSequence || null,
      displayName: d.FullName || d.Name || "",
      companyName: d.CompanyName || null,
      email: d.Email || null,
      phone: d.Phone || null,
      isActive: d.IsActive !== "false",
    }));

    res.json({ success: true, results });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Customer lookup failed";
    console.error(`[QB Lookup Customer ${field}=${value}] Error:`, error);
    res.status(500).json({ error: msg });
  }
}

// ─── Item lookup ───────────────────────────────────────────────────────────

async function handleItemLookup(
  refNumber: string,
  res: MedusaResponse
): Promise<void> {
  const sku = refNumber.trim();
  if (!sku) {
    res
      .status(400)
      .json({ error: "refNumber (SKU) is required for Item lookup" });
    return;
  }

  // QB Items are queried by FullName (the SKU). Returns any item type
  // (Inventory, NonInventory, Service, etc.) that matches.
  const qbxml = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<?qbxml version="10.0"?>`,
    `<QBXML><QBXMLMsgsRq onError="stopOnError">`,
    `<ItemQueryRq requestID="1">`,
    `<FullName>${escapeXml(sku)}</FullName>`,
    `</ItemQueryRq>`,
    `</QBXMLMsgsRq></QBXML>`,
  ].join("");

  try {
    const rawResult = await runDirectQuery(qbxml);
    const qbMsgs: Record<string, unknown> =
      (rawResult as any)?.QBXML?.QBXMLMsgsRs ??
      (rawResult as any)?.QBXMLMsgsRs ??
      rawResult;

    const itemQueryRs: Record<string, unknown> | undefined =
      (qbMsgs as any)?.ItemQueryRs ?? (rawResult as any)?.ItemQueryRs;

    if (!itemQueryRs) {
      res
        .status(404)
        .json({ error: `Item "${sku}" not found in QuickBooks` });
      return;
    }

    const results: {
      listId: string;
      editSequence: string | null;
      sku: string;
      title: string | null;
      qbItemType: string;
      isActive: boolean;
    }[] = [];

    for (const retKey of ITEM_RET_KEYS) {
      const raw = (itemQueryRs as any)[retKey];
      if (!raw) continue;
      const docs: Record<string, any>[] = Array.isArray(raw) ? raw : [raw];
      const qbItemType = retKey
        .replace(/^Item/, "")
        .replace(/Ret$/, "");
      for (const d of docs) {
        results.push({
          listId: d.ListID || "",
          editSequence: d.EditSequence || null,
          sku: d.FullName || d.Name || "",
          title:
            d.SalesDesc ||
            d.PurchaseDesc ||
            d.Desc ||
            d.SalesAndPurchase?.SalesDesc ||
            d.SalesAndPurchase?.PurchaseDesc ||
            null,
          qbItemType,
          isActive: d.IsActive !== "false",
        });
      }
    }

    if (results.length === 0) {
      res
        .status(404)
        .json({ error: `Item "${sku}" not found in QuickBooks` });
      return;
    }

    res.json({ success: true, results });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Item lookup failed";
    console.error(`[QB Lookup Item ${sku}] Error:`, error);
    res.status(500).json({ error: msg });
  }
}

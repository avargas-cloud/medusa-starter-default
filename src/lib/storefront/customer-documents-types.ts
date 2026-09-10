/**
 * src/lib/storefront/customer-documents-types.ts
 * Output shapes for customer-documents.ts — a strict allowlist projection
 * (never a spread of a raw DB row). See customer-documents.ts for the
 * forbidden-field list and the money-cents-to-dollars convention.
 */

export type CustomerInvoiceItem = {
  sku: string | null;
  description: string;
  quantity: number;
  refunded_quantity: number;
  unit_price: number;
  total: number;
  order_line_item_id: string | null;
};

export type CustomerInvoiceTracking = {
  carrier: string | null;
  tracking_number: string;
  tracking_url: string | null;
  shipped_at: string | null;
};

export type CustomerInvoiceAddress = {
  first_name: string | null; last_name: string | null; company: string | null;
  address_1: string | null; address_2: string | null; city: string | null;
  province: string | null; postal_code: string | null; country_code: string | null; phone: string | null;
};

export type CustomerInvoice = {
  id: string;
  invoice_number: string;
  order_id: string;
  order_display_id: number | null;
  status: string;
  issued_at: string | null;
  subtotal: number;
  discount: number;
  shipping: number;
  tax: number;
  total: number;
  refunded_amount: number;
  shipping_address: CustomerInvoiceAddress | null;
  items: CustomerInvoiceItem[];
  tracking: CustomerInvoiceTracking[];
};

export type CustomerShipmentLine = {
  order_line_item_id: string;
  quantity: number;
  sku: string | null;
  title: string | null;
};

export type CustomerShipment = {
  id: string;
  order_id: string;
  order_display_id: number | null;
  invoice_id: string | null;
  invoice_number: string | null;
  invoice_scope: string | null;
  carrier: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  service: string | null;
  status: string;
  status_detail: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  lines: CustomerShipmentLine[];
};

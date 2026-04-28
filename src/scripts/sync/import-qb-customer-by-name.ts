/**
 * Imports a single QuickBooks customer into Medusa by FullName.
 *
 * Run:
 *   yarn medusa exec ./src/scripts/sync/import-qb-customer-by-name.ts
 *
 * Hard-coded for FLORIDA CONVERSION LLC (Sales Receipt 27925 backfill).
 * If the customer already exists in Medusa (matched by qb_list_id) the script
 * is a no-op and just prints the existing customer_id.
 */

import { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";
import postgres from "postgres";

import {
  bridgeFetch,
  POLL_INTERVAL_MS,
  MAX_POLL_ATTEMPTS,
} from "../../lib/quickbooks/client/core";

const QB_FULL_NAME = "FLORIDA CONVERSION  LLC"; // double space per QB record (matches receipt header)
const WHOLESALE_GROUP_ID = "cusgroup_01KGMKM66SZVRE4ZDZBC5862HT";

interface QbAddress {
  Addr1?: string;
  Addr2?: string;
  Addr3?: string;
  City?: string;
  State?: string;
  PostalCode?: string;
  Country?: string;
}

interface QbCustomer {
  ListID: string;
  EditSequence: string;
  Name: string;
  FullName: string;
  CompanyName?: string;
  FirstName?: string;
  LastName?: string;
  Phone?: string;
  AltPhone?: string;
  Email?: string;
  BillAddress?: QbAddress;
  ShipAddress?: QbAddress;
  CustomerTypeRef?: { FullName?: string };
  PriceLevelRef?: { FullName?: string };
}

function joinAddrLines(a?: QbAddress): string {
  if (!a) return "";
  return [a.Addr1, a.Addr2, a.Addr3].filter(Boolean).join(", ");
}

async function queryCustomerByFullName(
  fullName: string,
  log: (msg: string) => void
): Promise<QbCustomer | null> {
  const safe = fullName.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const qbxml = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<?qbxml version="10.0"?>`,
    `<QBXML><QBXMLMsgsRq onError="stopOnError">`,
    `<CustomerQueryRq requestID="1">`,
    `<FullName>${safe}</FullName>`,
    `</CustomerQueryRq>`,
    `</QBXMLMsgsRq></QBXML>`,
  ].join("");

  log(`[QB] Sending CustomerQueryRq for FullName="${fullName}"...`);
  const enqueueRes = await bridgeFetch("POST", "/api/sync/direct-query", {
    qbxml,
  });
  const operationId: string =
    enqueueRes?.operationId || enqueueRes?.operation_id;
  if (!operationId) throw new Error("Bridge did not return operationId");
  log(`[QB] operationId=${operationId}, polling...`);

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const statusRes = await bridgeFetch(
      "GET",
      `/api/sync/status/${operationId}`
    );
    const op = statusRes?.operation;
    if (!op) continue;
    if (op.status === "completed") {
      const ret =
        op.result?.QBXML?.QBXMLMsgsRs?.CustomerQueryRs?.CustomerRet ?? null;
      if (!ret) return null;
      return Array.isArray(ret) ? ret[0] : ret;
    }
    if (op.status === "failed") {
      throw new Error(`CustomerQuery failed: ${op.error || "Unknown"}`);
    }
    log(`[QB] poll ${attempt}/${MAX_POLL_ATTEMPTS} → ${op.status}`);
  }
  throw new Error("CustomerQuery polling timed out");
}

export default async function importQbCustomerByName({ container }: ExecArgs) {
  const logger = container.resolve("logger");
  const customerModule = container.resolve(Modules.CUSTOMER);
  const log = (m: string) => logger.info(m);

  // 1. Query QB
  const qb = await queryCustomerByFullName(QB_FULL_NAME, log);
  if (!qb) {
    logger.error(`❌ QB customer "${QB_FULL_NAME}" not found.`);
    return;
  }
  log(
    `✅ QB customer found: ListID=${qb.ListID} EditSeq=${qb.EditSequence} ` +
      `Name="${qb.Name}" Company="${qb.CompanyName ?? ""}"`
  );

  // 2. Skip if already in Medusa (by qb_list_id)
  const existingByQbId = await customerModule.listCustomers(
    {} as any,
    { take: 1 } as any
  );
  // Use raw SQL — listCustomers metadata filtering is limited
  const sql = postgres(process.env.DATABASE_URL!);
  const existingRows = await sql<{ id: string }[]>`
    SELECT id FROM customer
    WHERE metadata->>'qb_list_id' = ${qb.ListID}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  void existingByQbId;
  if (existingRows.length > 0) {
    logger.info(
      `ℹ️  Customer already exists in Medusa: ${existingRows[0].id} — no-op.`
    );
    await sql.end();
    return;
  }

  // 3. Resolve names + email placeholder
  const firstName =
    qb.FirstName?.trim() ||
    qb.Name?.trim().split(/\s+/)[0] ||
    "FLORIDA CONVERSION";
  const lastName =
    qb.LastName?.trim() ||
    qb.Name?.trim().split(/\s+/).slice(1).join(" ") ||
    "LLC";

  const slug =
    `${qb.CompanyName || qb.Name}`
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9\s]/g, "")
      .trim()
      .replace(/\s+/g, ".") || "customer";
  const email = qb.Email?.trim()?.toLowerCase().includes("@")
    ? qb.Email.trim().toLowerCase()
    : `${slug}@noemail.ecopowertech.com`;
  const isDummyEmail = !qb.Email?.includes("@");

  const priceLevel = (qb.PriceLevelRef?.FullName || "").toLowerCase();
  const isWholesale =
    priceLevel.includes("wholesale") || priceLevel.includes("distributor");

  // 4. Create customer
  const created = (await customerModule.createCustomers({
    email,
    first_name: firstName,
    last_name: lastName,
    company_name: qb.CompanyName || null,
    phone: qb.Phone || qb.AltPhone || null,
    has_account: false,
    metadata: {
      legacy_customer: true,
      qb_list_id: qb.ListID,
      qb_edit_sequence: qb.EditSequence,
      qb_display_name: qb.Name,
      qb_customer_type: qb.CustomerTypeRef?.FullName || "",
      qb_price_level: isWholesale ? "Wholesale" : "Retail",
      email_is_placeholder: isDummyEmail,
      qb_original_email: qb.Email || "",
      imported_by: "import-qb-customer-by-name (SR 27925 backfill)",
    },
  })) as any;
  log(`✅ Customer created: ${created.id} (${email})`);

  // 5. Create addresses
  const billStreet = joinAddrLines(qb.BillAddress);
  if (billStreet && qb.BillAddress?.City && qb.BillAddress?.PostalCode) {
    await customerModule.createCustomerAddresses({
      customer_id: created.id,
      company: qb.CompanyName || null,
      first_name: firstName,
      last_name: lastName,
      address_1: billStreet,
      city: qb.BillAddress.City,
      province: qb.BillAddress.State || null,
      postal_code: qb.BillAddress.PostalCode,
      country_code: (qb.BillAddress.Country || "US").toLowerCase(),
      phone: qb.Phone || null,
      is_default_billing: true,
      is_default_shipping: !qb.ShipAddress,
    });
    log(`   📮 Billing address added`);
  }

  const shipStreet = joinAddrLines(qb.ShipAddress);
  if (
    shipStreet &&
    shipStreet !== billStreet &&
    qb.ShipAddress?.City &&
    qb.ShipAddress?.PostalCode
  ) {
    await customerModule.createCustomerAddresses({
      customer_id: created.id,
      company: qb.CompanyName || null,
      first_name: firstName,
      last_name: lastName,
      address_1: shipStreet,
      city: qb.ShipAddress.City,
      province: qb.ShipAddress.State || null,
      postal_code: qb.ShipAddress.PostalCode,
      country_code: (qb.ShipAddress.Country || "US").toLowerCase(),
      phone: qb.Phone || null,
      is_default_billing: false,
      is_default_shipping: true,
    });
    log(`   📦 Shipping address added`);
  }

  // 6. Assign to customer group
  const groupId = isWholesale ? WHOLESALE_GROUP_ID : null;
  if (groupId) {
    await sql`
      INSERT INTO customer_group_customer (id, customer_id, customer_group_id, created_at, updated_at)
      VALUES (
        ${"cgc_" + Math.random().toString(36).slice(2, 14)},
        ${created.id},
        ${groupId},
        NOW(),
        NOW()
      )
      ON CONFLICT DO NOTHING
    `;
    log(`   👥 Added to ${isWholesale ? "Wholesale" : "Retail"} group`);
  }

  await sql.end();

  log(`\n${"=".repeat(60)}`);
  log(`✅ DONE — customer_id=${created.id}`);
  log(`   Use this customer_id when creating the POS Order.`);
  log(`${"=".repeat(60)}`);
}

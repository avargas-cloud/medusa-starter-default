#!/usr/bin/env tsx
import * as dotenv from "dotenv";
import { resolve } from "path";

// Load the correct .env for the workspace
dotenv.config({ path: resolve(__dirname, "../../../../.env") });

import {
  bridgeFetch,
  pollRawOperationResult,
} from "../../lib/quickbooks/client/core";
import { unapplyPaymentFromInvoiceInQb } from "../../lib/quickbooks/client/payments";

async function main() {
  console.log("=========================================");
  console.log("🧪 QBXML ReceivePaymentMod Test");
  console.log("=========================================\n");

  const paymentTxnId = process.argv[2];
  const invoiceTxnId = process.argv[3];

  if (!paymentTxnId || !invoiceTxnId) {
    console.error("❌ ERROR: Missing arguments.");
    console.log(
      "Usage: npx -y tsx src/scripts/tests/test-qb-payment-mod.ts <PaymentTxnId> <InvoiceTxnId>"
    );
    console.log(
      "Example: npx -y tsx src/scripts/tests/test-qb-payment-mod.ts 6A5C-17112345 6A5B-17112344"
    );
    process.exit(1);
  }

  console.log(
    `🔍 1. Fetching Payment ${paymentTxnId} from QB to get EditSequence...`
  );

  let editSequence: string | undefined;

  try {
    const paymentData = await bridgeFetch(
      "GET",
      `/api/payments/${paymentTxnId}`
    );
    const operationId = paymentData?.operationId;
    if (!operationId) {
      throw new Error("No operationId returned for payment query");
    }

    console.log(`⏳ Waiting for QB response (Operation ID: ${operationId})...`);
    const rawResult = await pollRawOperationResult(operationId);

    const resObj =
      rawResult?.QBXML?.QBXMLMsgsRs?.ReceivePaymentQueryRs?.ReceivePaymentRet ??
      rawResult?.ReceivePaymentQueryRs?.ReceivePaymentRet ??
      rawResult?.ReceivePaymentRet;

    editSequence = resObj?.EditSequence;

    if (!editSequence) {
      console.error(
        `❌ Could not find EditSequence in QB response for Payment ${paymentTxnId}`
      );
      console.log(
        "Raw Response Snippet:",
        JSON.stringify(rawResult).slice(0, 300)
      );
      process.exit(1);
    }

    console.log(`✅ Extracted EditSequence: ${editSequence}`);
  } catch (error: any) {
    console.error(`❌ Failed to fetch payment from QB: ${error.message}`);
    process.exit(1);
  }

  console.log(
    `\n📤 2. Sending ReceivePaymentMod (Unapply) for Invoice ${invoiceTxnId}...`
  );
  try {
    const result = await unapplyPaymentFromInvoiceInQb({
      creditTxnId: paymentTxnId,
      invoiceId: invoiceTxnId,
      editSequence: editSequence,
    });

    if (result.success) {
      console.log("✅ bridge operation queued successfully:");
      console.log(JSON.stringify(result.data, null, 2));
      console.log(
        "\n⏳ NOTE: Check the QuickBooks Web Connector or Bridge logs to see if the XML executes successfully."
      );
    } else {
      console.error("❌ Bridge rejected the unapply request:");
      console.error(result.error);
    }
  } catch (error: any) {
    console.error(`❌ Exception while unapplying payment: ${error.message}`);
  }
}

main();

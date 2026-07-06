/**
 * Standalone assertion of deriveChinaTransferState against the real state
 * combinations observed in the sandbox (Veetech POs). Run with tsx:
 *   cd backend && npx tsx src/scripts/verify/verify-china-transfer-derivation.ts
 */
import { deriveChinaTransferState } from "../../api/admin/purchase-orders/_lib/china-transfer";

type Case = {
  name: string;
  required: boolean;
  hasLinkedTransfer: boolean;
  status: string;
  unitsReceived: number;
  expect: string;
};

const cases: Case[] = [
  { name: "PO-1091 submitted/0/noIT", required: true, hasLinkedTransfer: false, status: "submitted", unitsReceived: 0, expect: "missing_convertible" },
  { name: "PO-1087 submitted/0/IT", required: true, hasLinkedTransfer: true, status: "submitted", unitsReceived: 0, expect: "linked" },
  { name: "partial/326/IT", required: true, hasLinkedTransfer: true, status: "partially_received", unitsReceived: 326, expect: "linked" },
  { name: "partial/50/noIT", required: true, hasLinkedTransfer: false, status: "partially_received", unitsReceived: 50, expect: "missing_after_receipt" },
  { name: "received/550/noIT", required: true, hasLinkedTransfer: false, status: "received", unitsReceived: 550, expect: "missing_after_receipt" },
  { name: "draft/0/noIT (agent)", required: true, hasLinkedTransfer: false, status: "draft", unitsReceived: 0, expect: "not_convertible_status" },
  { name: "cancelled/0/noIT (agent)", required: true, hasLinkedTransfer: false, status: "cancelled", unitsReceived: 0, expect: "not_convertible_status" },
  { name: "non-agent submitted", required: false, hasLinkedTransfer: false, status: "submitted", unitsReceived: 0, expect: "not_required" },
];

let failed = 0;
for (const c of cases) {
  const got = deriveChinaTransferState(c).state;
  const ok = got === c.expect;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name.padEnd(28)} → ${got}${ok ? "" : ` (expected ${c.expect})`}`);
}
console.log(`\n${failed === 0 ? "ALL PASS" : `${failed} FAILED`} (${cases.length} cases)`);
process.exit(failed === 0 ? 0 : 1);

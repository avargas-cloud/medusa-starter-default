# QB Session Handoff — 2026-03-29

## Sales Receipt — Working! (3 bugs found from first successful run)

The Sales Receipt QB sync is now working. First successful SR was created today. Three issues spotted from the screenshot and fixed in this session (NOT yet committed, NOT yet tested):

---

## Fix 1 — Shipping Amount ÷100 (by probar)

**File:** `backend/src/lib/quickbooks/handlers/handle-sales-receipt-created.ts`

**Problem:** `pos_invoice.shipping` is stored in **cents** (e.g. 1499 = $14.99) but was being passed directly as dollars to `buildShippingQbItem`, resulting in $1,499.00 in QB.

**Fix (line ~133):**
```ts
// BEFORE:
invoiceShippingAmount = Number(row.shipping)
// AFTER:
invoiceShippingAmount = Number(row.shipping) / 100
```

---

## Fix 2 — Payment Method "card" → "Credit Card" (por probar)

**File:** `backend/src/lib/quickbooks/order-flow-core.ts`

**Problem:** `mapPaymentMethodToQb('card')` fell through to the default branch → `'Card'` (capitalized). QB doesn't have a "Card" payment method, so the column showed empty.

**Fix (line ~783):**
```ts
case "card":
case "credit card": return "Credit Card"
// also added:
case "ach": return "EFT"
```

---

## Fix 3 — Memo "Medusa Invoice 20020" (por probar)

**File:** `backend/src/lib/quickbooks/handlers/handle-sales-receipt-created.ts`

**Problem:** Memo was set to `"Sales Receipt {qb_ref_number}"` (e.g. "Sales Receipt 10007") — the QB number, not traceable to Medusa.

**Fix (line ~128-130):**
```ts
// BEFORE:
const seq = row.qb_ref_number || row.invoice_number
if (seq) {
    srRefNumber = String(seq)
    memo = memo ? `${memo} | Sales Receipt ${seq}` : `Sales Receipt ${seq}`
}

// AFTER:
const seq = row.qb_ref_number || row.invoice_number
if (seq) {
    srRefNumber = String(seq)
}
if (row.invoice_number) {
    const invLabel = `Medusa Invoice ${row.invoice_number}`
    memo = memo ? `${memo} | ${invLabel}` : invLabel
}
```

---

## Uncommitted Backend Changes (commit these)

- `backend/src/lib/quickbooks/handlers/handle-sales-receipt-created.ts` — shipping ÷100, memo fix
- `backend/src/lib/quickbooks/order-flow-core.ts` — payment method 'card' → 'Credit Card'
- `backend/src/lib/quickbooks/qb-pipeline.ts` — pipeline deduplication (orderId OR referenceId)
- `backend/src/api/admin/pos/credit_memos/[id]/complete/route.ts` — QB discount+shipping lines
- `backend/src/api/admin/pos/credit_memos/sync/route.ts` — TS "Memoes" pluralization fix
- `backend/src/lib/quickbooks/client/sales-receipts.ts` — payload cleanup

## Uncommitted POS Changes (commit these)

- `ecopowertech-store-pos/app/(pos)/returns/_components/CreateReturnModal.tsx` — carry discount+shipping from invoice
- `ecopowertech-store-pos/app/(pos)/returns/[id]/hooks/useReturn.ts` — discountType 'amount' → 'fixed'
- `ecopowertech-store-pos/app/(pos)/returns/[id]/_components/ReturnSummaryBar.tsx` — readOnly prop
- `ecopowertech-store-pos/app/(pos)/returns/[id]/page.tsx` — pass readOnly to ReturnSummaryBar
- `ecopowertech-store-pos/components/pos/ShippingSection.tsx` — readOnly prop
- `ecopowertech-store-pos/components/pos/PromotionStrip.tsx` — readOnly prop

---

## Credit Memo QB Flow — Code Ready, NOT Tested

When completing a credit memo (`POST /api/admin/pos/credit_memos/:id/complete`), the QB credit memo now includes:
- Product lines
- Subtotal + Discount lines (via `buildQbOrderDiscountLines`)
- Shipping line (via `buildShippingQbItem`)

This mirrors the Invoice QB flow exactly. Not tested yet.

Also: POS Create Return modal now pre-fills discount and shipping from the parent invoice (read-only). Not tested yet.

---

## Pipeline Deduplication — Code Ready, NOT Tested

`qb-pipeline.ts` now correctly deduplicates rows when `orderId=null` (e.g. credit_memo, write_check steps). Changed guard from `input.orderId &&` to `(input.orderId || input.referenceId) &&`. SQL uses `::text` casts to avoid PG type inference error.

---

## Future Work: Full Refund Flow in QB

### Step 1: Write Check (WriteCheckAdd)
When refunding a customer by check, create a WriteCheck in QB:
```xml
<WriteCheckAddRq>
  <WriteCheckAdd>
    <AccountRef><FullName>Checking</FullName></AccountRef>
    <PayeeEntityRef><ListID>{customerId}</ListID></PayeeEntityRef>
    <TxnDate>{date}</TxnDate>
    <RefNumber>{checkNumber}</RefNumber>
    <Memo>Refund for Medusa Invoice {invoiceNumber}</Memo>
    <ExpenseLineAdd>
      <AccountRef><FullName>Returns & Allowances</FullName></AccountRef>
      <Amount>{amount}</Amount>
    </ExpenseLineAdd>
  </WriteCheckAdd>
</WriteCheckAddRq>
```

### Step 2: Apply Refund (links Credit Memo + Write Check)
```
credit_memo (confirmed) → write_check (WriteCheckAdd) → apply_refund (ReceivePaymentAdd)
```

### Files to create:
1. `quickbooks-bridge/src/qbxml/builders/write-check.ts` — new QBXML builder
2. `quickbooks-bridge/src/rest/routes/write-checks.ts` — new bridge endpoint
3. `backend/src/lib/quickbooks/client/write-checks.ts` — new client
4. `backend/src/api/admin/pos/credit_memos/[id]/complete/route.ts` — queue write_check after CM

---

## Bridge Reminder

Bridge repo is on the **remote server** (local clone only). After committing bridge changes:
1. Ask user to `git pull` on server
2. Then `npm run build` (dist/ is gitignored, must recompile)
3. Then restart bridge process

---

## Bridge Committed Changes (already on server)

All HRESULT 0x80040400 fixes are pushed and deployed:
- `3f307cb` — removed `<ItemSalesTaxRef>` from SalesReceiptAdd (not valid for SR)
- `151bfe8` — Desc before Quantity, Memo in header
- `86f5131` — tsconfig exclude refunds.ts (was blocking tsc)
- `d7e862f` — quantity guard (undefined → omit `<Quantity>`)

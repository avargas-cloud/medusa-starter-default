# Treasury — Credit-Memo Cross-Category COGS Movement

*Plan doc · owner: Alejandro Vargas · design reviewed by Codex (GPT-5.5) 2026-07-17*

## 1. Problem

A credit memo is born from a RETURN of goods with a given sourcing category (China vs Local). When those goods were originally sold, the customer's cash was distributed with a `china_cogs`/`local_cogs` share — i.e. money was effectively parked in a specific bank account to replenish that category's inventory.

When the customer later REDEEMS that credit against goods of a **different** category, a real obligation to the *other* category's vendor is created, but **no new cash comes in**. The money to fund it is parked in the wrong bank account. Nobody is told; the accountant never gets a chance to rebalance the banks.

Today the system does NOT surface or correct this on a normal cash day. Worse (see §3), the recent fix that feeds redemption COGS into the day's ratio actually **double-funds** the obligation.

## 2. Decisions (settled with the user)

- **Live derivation, single code path.** Backing is derived live from the credit memo's line items every time the report runs — never snapshotted at issuance. Rationale: store-pos is actively being corrected day-to-day; live picks up data fixes automatically, and it tells the accountant how to move money with today's best-known numbers. No dual-mode (snapshot-new + live-legacy) that would confuse maintainers. Frozen only at Confirm & Lock.
- **Positive inter-bank movements, NOT negative split rows** (Codex High-severity #2). A `china_cogs` split going negative would emit a nonsense "wire −$40 to China" instruction. Model movements as a separate list of positive `from_bucket → to_bucket` transfers.
- **Vector delta, not category comparison** (Codex High #4). Both sides can be mixed china+local. Compute Δchina / Δlocal; a total mismatch is surfaced as surplus/shortfall, not a transfer.
- **Backing provenance gates the suggestion** (Codex High #3). Only `cash_backed` credits auto-suggest a movement.
- **Remove double-count** (Codex High #1). See §3 — the single most important change.
- **Durable resolution + derivation hash** (Codex #7). Confirm/ignore decisions persist keyed by `payment_application_id` + a hash of the derived inputs; a stale hash invalidates the decision and forces re-resolve.
- **Exception states, no deadlock** (Codex #8): `confirm` / `ignore` / `mark_unattributable`, all audited.
- **Tax is out of scope** — UI states it resolves COGS only.

## 3. The double-count fix (do this FIRST — it changes existing behavior)

Currently (`load-sales-by-application.ts`): credit-memo-redeemed lines are `is_cash_funded=false` (excluded from revenue/cash) **but still feed `cogs_china_cents`/`cogs_local_cents`**, which drive the day's split ratio. So a China-credit → Local-goods redemption already nudges the day's split toward local by stealing part of **other** cash sales' pool.

If we ALSO add an explicit `china→local` movement, the local obligation is funded **twice**.

**Fix:** credit-memo-redeemed COGS must be **pulled out of the normal cash-split ratio** and routed exclusively through the new movement section.
- In `load-sales-by-application.ts`, the `cogs` CTE must count **only cash-funded lines** (`WHERE is_cash_funded`), same filter the `app_revenue` CTE already uses. Today `cogs` reads from `weighted` (all lines); it must read from `weighted WHERE is_cash_funded`.
- The redeemed (non-cash) lines' china/local breakdown moves into a NEW loader (`loadCreditMemoMovements`, §5) that computes backing vs consumption per redemption.
- Net effect: the day's `cogs_china`/`cogs_local` totals become **cash-only** (correct — they only ever drove the cash split); credit obligations live in `bucket_movements`.

> ⚠️ This supersedes the `2026-07-16` fix. That fix was directionally aimed at the same problem but solved it in the wrong layer (the ratio). We're relocating it to an explicit, accountant-approved movement.

## 4. Data model

Movements are LIVE while open, FROZEN at lock. Only the **resolution decisions** need durable storage before lock.

### New table: `treasury_cm_movement_resolution`
```
id                    TEXT PK            (tcm_<ulid>)
payment_application_id TEXT NOT NULL     -- the redemption this resolves
resolution            TEXT NOT NULL      -- 'confirmed' | 'ignored' | 'unattributable'
derivation_hash       TEXT NOT NULL      -- sha256 of the derived inputs (see §5.3)
movement_json         JSONB NOT NULL     -- the resolved movement at decision time (from/to/cents/vectors)
reason                TEXT NULL          -- required for ignored / unattributable
resolved_by_user_id   TEXT NULL
resolved_at           TIMESTAMPTZ NOT NULL DEFAULT now()
created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
UNIQUE (payment_application_id) WHERE ... -- one live resolution per redemption; re-resolve = UPDATE
```
- Partial unique index on `payment_application_id` (one active resolution per redemption).
- On re-resolve, UPDATE in place (or upsert). If `derivation_hash` no longer matches the live derivation, the UI shows the row as **stale** and the decision doesn't count toward gating until re-confirmed.
- At Confirm & Lock, the resolved movements are copied into `snapshot_json` (frozen forever); the resolution rows remain as the audit trail.

No column added to credit memos (live derivation → nothing to snapshot at issuance).

## 5. Backend

### 5.1 New loader `_lib/load-cm-movements.ts` → `loadCreditMemoMovements(pg, dayStart, dayEnd)`
Reuses the exact CTE shape of `loadCreditMemoCogsGaps` (already computes per-redemption china/local COGS of the REDEEMED goods = **consumption**). Extend it to ALSO compute **backing** = china/local COGS of the credit memo's OWN returned line items (`pos_credit_memo_item` joined to product/variant for `is_sourced_via_agent` + cost fallback, same `COST_FALLBACK_EXPR`).

Per redemption (`payment_application`), emit:
```ts
interface CreditMemoMovementView {
  payment_application_id: string
  payment_id: string
  reference: string | null           // "CM-1090"
  customer_id: string | null
  invoice_id: string | null
  order_id: string | null
  redeemed_on: string                // pa.applied_at::date
  amount_applied_cents: number
  backing:     { china_cents: number; local_cents: number; total_cents: number }
  consumption: { china_cents: number; local_cents: number; total_cents: number }
  // vector delta → the suggested inter-bank movement (positive, directional):
  suggested_movement: { from: 'china_cogs'|'local_cogs'; to: 'china_cogs'|'local_cogs'; cents: number } | null
  surplus_shortfall_cents: number    // backing.total - consumption.total, when ≠ 0
  backing_status: 'cash_backed' | 'partially_cash_backed' | 'unbacked' | 'unknown'
  derivation_hash: string
  resolution: 'confirmed'|'ignored'|'unattributable'|null  // joined from resolution table
  resolution_stale: boolean          // true if stored hash ≠ current derivation_hash
}
```

### 5.2 Vector delta
`Δchina = consumption.china − backing.china`, `Δlocal = consumption.local − backing.local`.
The rebalance is `move = min(|Δchina|, |Δlocal|)` in the direction that covers the shortfall:
- consumption more local than backing (Δlocal>0, Δchina<0) → move `min(...)` **china_cogs → local_cogs**.
- symmetric for the reverse.
Only emit `suggested_movement` when `backing_status='cash_backed'` and `move > 0`.

### 5.3 `derivation_hash`
`sha256` over the sorted tuple of: `payment_application_id`, `amount_applied_cents`, backing line `(variant_id, is_china, unit_cost_cents, qty)`, consumption line `(variant_id, is_china, unit_cost_cents, qty)`. Any item edit / re-tag / cost change flips the hash → stale.

### 5.4 Backing status
- `unbacked` — credit memo has no line items (goodwill/manual adjustment) → no movement.
- `unknown` — a backing line's product is deleted or has no cost/origin → no auto-suggest, must be `mark_unattributable`.
- `partially_cash_backed` — some backing lines resolved, some unknown → suggest on the resolved portion only.
- `cash_backed` — all backing lines have cost + origin.

### 5.5 Wire into `computeLiveRangeReport` (`load-daily-report.ts`)
- Call `loadCreditMemoMovements`; attach as `report.credit_memo_movements`.
- Keep the existing `CreditMemoCogsGapView` for the zero-cash-pool visibility case OR fold it in (movements with `backing_status='unbacked'` on a zero-cash day). Decide during build; likely the movement section **absorbs** the old gap panel.
- `mergeContributions` concatenates `credit_memo_movements` across days (like `credit_memo_cogs_gaps`).

### 5.6 New endpoints
- `POST /admin/accounting/treasury/daily/cm-movement/resolve`
  `{ payment_application_id, resolution: 'confirmed'|'ignored'|'unattributable', reason?, derivation_hash }`
  Validates the hash matches the live derivation (409 `STALE_DERIVATION` if not), upserts the resolution row. `ignored`/`unattributable` require `reason`. Accountant permission.
- Gating in `daily/log` POST (mirror the `unattributated_payments` block, §3 of log/route.ts):
  recompute fresh, then **409 `CM_MOVEMENTS_UNRESOLVED`** if any `credit_memo_movements` row is unresolved OR stale. At lock, the movements are already in the freshly-recomputed `report` → frozen into `snapshot_json` as-is.
- **Locked-day guard** (Codex #9): reject creating/editing a `payment_application` whose `applied_at` lands in an already-locked date. Add a check in the apply path (`finance/payments/:id/apply` and the credit_memo complete route) — 409 with "that day is locked, apply on an open day."

### 5.7 Movements do NOT touch `cash_splits`
The `sum(splits)==net_cash` invariant is untouched (movements are a separate list). Movements are sum-zero (from−, to+) and rendered/executed as their own positive wire instructions.

## 6. Frontend (store-pos)

### 6.1 New `CreditMemoMovementsPanel.tsx`
Replaces/absorbs `CreditMemoCogsGapPanel`. Per §UX:
```
CREDIT MEMO COGS MOVEMENTS
Δ net: $40 china_cogs → local_cogs (aggregate of confirmed rows)
 CM-1234  $100  backing China $40 → redeemed Local   suggest $40 china→local   [confirm][ignore]
 CM-1240  ... (stale badge if resolution_stale)                                  [confirm][ignore]
```
- Each `confirm` / `ignore` posts to `cm-movement/resolve`; `ignore`/`unattributable` open a reason prompt.
- Stale rows show an amber "changed since resolved — re-confirm" badge and don't count as resolved.
- Aggregate Δ at top sums only `confirmed` rows.

### 6.2 Gating in `ExportButtons.tsx`
Extend `confirmBlocked` to also block when `report.credit_memo_movements` has any unresolved-or-stale row. Tooltip explains why. (Backend enforces it too — 409 `CM_MOVEMENTS_UNRESOLVED` — the UI gate is UX, the route is truth.)

### 6.3 Types
Add `credit_memo_movements?: CreditMemoMovementView[]` to `TreasuryDailyReport` in both `backend/.../daily/types.ts` and `store-pos/lib/treasury-types.ts`. Add `CM_MOVEMENTS_UNRESOLVED` warning code.

## 7. Verify plan (sandbox only)

`scripts/verify/verify-treasury-cm-movements.ts` covering:
1. **Double-count gone:** a China-credit redeemed against Local goods on a day WITH other cash sales → the day's `cogs_china/local` reflect only cash lines; the local obligation appears ONLY as a movement, not in the ratio. Assert the split matches a hand-computed value that excludes the redemption.
2. **Vector delta:** mixed backing (China$30/Local$10) vs mixed consumption (China$10/Local$30) → suggested movement `$20 china→local`, surplus/shortfall = 0.
3. **Surplus/shortfall:** backing total ≠ consumption total → difference surfaced separately, no phantom transfer.
4. **Backing status:** goodwill credit (no line items) → `unbacked`, no suggestion; deleted product → `unknown` → must `mark_unattributable`.
5. **Partial redemption cumulative cap:** $100 credit applied $60 then $40 across two days → cumulative backing consumed never exceeds the credit's original backing.
6. **Gating:** unresolved/stale movement → `daily/log` POST returns 409; resolve all → lock succeeds; snapshot freezes the movements.
7. **Stale hash:** resolve a row, edit an item, reload → row goes stale, gating re-blocks.
8. **Locked-day guard:** apply a payment into a locked date → 409.
9. **Invariant:** `sum(cash_splits)==net_cash` holds in every case (movements never perturb it).

Sandbox E2E: real browser click-through of the section (confirm, ignore-with-reason, stale re-confirm, lock).

## 8. Build status (2026-07-17)

**DONE (backend + store-pos, type-check + lint green):**
- §3 double-count fix — `cogs` CTE now `WHERE is_cash_funded`.
- Migration `1780100000000` — `treasury_cm_movement_resolution`.
- `load-cm-movements.ts` — SQL loader + pure `deriveCmMovement()` (vector delta, backing status, hash, needs_attention filter).
- Wired into `load-daily-report.ts` (live + merge) + `CM_MOVEMENTS_UNRESOLVED` warning.
- `cm-movement/resolve` route (hash validation, locked-day guard, upsert) + gating in `daily/log`.
- store-pos: `CreditMemoMovementsPanel`, `ExportButtons` gating, types.
- `verify-treasury-cm-movements.ts` — 24 pure-math assertions PASS.
- Read-only prod probe confirmed real cross-category cases (CM-1094 China$132→Local, CM-1077 Local$110→China, CM-1081 mixed→$17 china→local).

**Decisions locked during build:**
- **Cost is live-preferred** (product metadata → frozen item cost fallback), origin always live. Self-contained to the movement feature; the cash-COGS path stays frozen-preferred (different question).
- **Backing uses RESTOCKED qty** (`quantity − damaged_qty`): damaged/non-restocked returns free no parked cash → 0 backing. Real data confirms it matters (CM-1057: 6 all-damaged lines → $0 backing → no movement). **⚠️ Confirm with user this matches intent.**
- **Scaling bases are intentionally asymmetric** (correct, not a bug): consumption scales by `amount_applied/invoice_total` (portion of the invoice this app funded); backing scales by `amount_applied/credit_total` (portion of the credit consumed) → implicit cumulative cap across partial redemptions.
- Movements panel and the old `CreditMemoCogsGapPanel` **coexist** (different concerns: cross-category rebalance vs zero-cash-day unrouted COGS).

**DEFERRED (documented, low-frequency, hot-path):**
- **Locked-day apply guard** (Codex #9): rejecting a `payment_application` whose `applied_at` lands in an already-locked day. Applies normally land on today (not locked), so this only fires for backdated applies into a past locked day — rare. Touches the shared apply hot path → own change + test.

**Still open to confirm:**
- Exact allocation base for partial redemptions: currently invoice/credit totals (incl. tax/shipping via `pi.total` / `cp.amount`). Codex #6 suggested merchandise subtotal post-discount excl tax/shipping — confirm with business.
- Permission model for `resolve` (accounting-only gate?).
- Sandbox E2E of the endpoints + UI + migration (pure math + SQL already validated).

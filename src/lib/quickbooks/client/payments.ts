import {
  DRY_RUN,
  bridgeFetch,
  pollRawOperationResult,
  pollOperationResult,
} from "./core";
import {
  QbReceivePaymentPayload,
  QbBridgeResult,
  QbAsyncResult,
} from "./types";

/**
 * Una aplicación del pago, tal como QuickBooks la tiene HOY.
 *
 * El par `discount*` se lee y se re-emite por la misma razón que existe todo
 * este read-merge-replace: `AppliedToTxnMod` es REPLACE-ALL. Una aplicación que
 * ya llevaba un write-off de redondeo y se re-manda SIN él pierde el descuento,
 * y el centavo que se había saldado vuelve a aparecer como saldo abierto de una
 * factura que nadie va a pagar — silenciosamente, y sólo en las facturas que NO
 * son el objetivo del Mod actual. Es exactamente la forma del clobber de agosto
 * 2026, con otro campo.
 */
export interface AppliedInvoiceState {
  invoiceId: string;
  amount: number;
  /** Descuento ya aplicado en QB a ESTA aplicación (dólares). */
  discountAmount?: number;
  /** Cuenta contra la que se posteó ese descuento. */
  discountAccountListId?: string;
}

export interface PaymentCurrentState {
  editSequence: string;
  appliedToInvoices: AppliedInvoiceState[];
  /** Header totals — lets callers cross-check the applied list against what the
   * header claims is applied (totalAmount − unusedPayment). */
  totalAmount: number | null;
  unusedPayment: number | null;
  /** QB customer ListID from the payment's own CustomerRef — the bridge's
   * /merge-apply route requires it, and reading it here saves callers a lookup. */
  customerListId: string | null;
}

/**
 * Mergea UNA aplicación nueva contra la lista que QuickBooks tiene hoy, y
 * devuelve la lista COMPLETA que hay que re-emitir.
 *
 * Existe como función pura y exportada, y no como veinte líneas dentro de
 * `mergeApplyPaymentInQb`, porque es la regla que decide si un write-off ya
 * asentado sobrevive — y una regla enterrada dentro de una función que hace red
 * no se puede probar sin montar el bridge entero.
 *
 * Dos invariantes, los dos por `AppliedToTxnMod` = REPLACE-ALL:
 *
 * 1. **Toda aplicación que no es el objetivo viaja INTACTA**, con su descuento.
 *    Omitirlo se lo borra: esa factura recupera su centavo abierto sin que nada
 *    falle, y sólo se nota mirando la factura.
 * 2. **`undefined` en el objetivo significa "no lo toques", nunca "borralo".**
 *    Un apply posterior a la misma factura por un motivo cualquiera no puede
 *    revertir el ajuste; anularlo es una operación explícita.
 */
export function mergeAppliedInvoices(
  current: readonly AppliedInvoiceState[],
  target: AppliedInvoiceState
): AppliedInvoiceState[] {
  const merged: AppliedInvoiceState[] = current.map((a) => ({ ...a }));
  const idx = merged.findIndex((a) => a.invoiceId === target.invoiceId);
  const existing = idx >= 0 ? merged[idx] : undefined;

  const incoming =
    Number(target.discountAmount ?? 0) > 0 &&
    (target.discountAccountListId ?? "").trim().length > 0
      ? {
          discountAmount: Number(target.discountAmount),
          discountAccountListId: target.discountAccountListId!.trim(),
        }
      : null;

  const preserved =
    existing?.discountAmount !== undefined &&
    existing?.discountAccountListId !== undefined
      ? {
          discountAmount: existing.discountAmount,
          discountAccountListId: existing.discountAccountListId,
        }
      : {};

  const entry: AppliedInvoiceState = {
    invoiceId: target.invoiceId,
    amount: target.amount,
    ...(incoming ?? preserved),
  };

  if (idx >= 0) merged[idx] = entry;
  else merged.push(entry);
  return merged;
}

export interface MergeApplyResult {
  operationId: string;
  newEditSequence: string | null;
  totalAppliedCount: number;
}

/**
 * Records a payment receipt in QuickBooks (async).
 * With autoApply: false, creates an unapplied credit that can be applied to the Invoice later.
 *
 * `opts.idempotencyKey` is OPT-IN per caller, and deliberately so. This is an
 * ADD: without a key, a retry after a lost bridge response mints a duplicate
 * ReceivePayment. But a key that is not unique-per-intended-document is WORSE
 * than no key — the bridge would dedupe two legitimately distinct payments into
 * one, and the second would silently never reach QB (missing money, not a
 * visible duplicate). So only pass a key you can prove is 1:1 with the QB
 * document you intend to create:
 *   - `payment:<cpay_id>`   ✅ one ReceivePayment per customer_payment row
 *   - anything keyed on order id  ❌ an order can be paid more than once
 *   - the transfer path (TxnDel + recreate) ❌ recreates are meant to repeat
 *
 * Bridge semantics (queue/operation-queue.ts): for write actions a matching
 * 'completed' or 'processing' op is RETURNED instead of re-queued, so a retry
 * after a lost response cannot duplicate. A 'failed' op is NOT matched, so a
 * genuine retry still proceeds. The bridge purges completed/failed ops after
 * 6h, so protection is bounded to that window — fine against our 20-minute
 * timeout, and the same bound every other keyed ADD already lives with.
 */
export async function receivePaymentInQb(
  payload: QbReceivePaymentPayload,
  opts?: { idempotencyKey?: string }
): Promise<QbBridgeResult<QbAsyncResult>> {
  if (DRY_RUN) {
    console.log(
      `[QB DRY RUN] Would record payment in QB: $${payload.amount} from ${payload.customerId}`
    );
    return {
      success: true,
      dryRun: true,
      data: {
        operationId: "DRY_RUN",
        txnId: "DRY_RUN_PAYMENT_TXNID",
        refNumber: "DRY_RUN_REF",
      },
    };
  }

  try {
    const body = {
      autoApply: false, // default: keep as open credit for e-commerce flow
      ...payload,
    };
    const data = await bridgeFetch(
      "POST",
      "/api/payments",
      body,
      opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : undefined
    );
    const operationId = data?.operationId;
    if (!operationId)
      throw new Error("Bridge did not return an operationId for Payment");
    return { success: true, data: { operationId } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Applies an existing unapplied ReceivePayment to an invoice via ReceivePaymentMod.
 * Uses POST /api/payments/{creditTxnId}/apply — modifies the existing QB payment in-place
 * rather than creating a new one. Requires EditSequence to avoid creating a duplicate record.
 */
export async function applyPaymentToInvoiceInQb(payload: {
  customerId: string;
  amount: number | string;
  invoiceId: string;
  creditTxnId: string;
  editSequence: string;
  memo?: string;
}): Promise<QbBridgeResult<QbAsyncResult>> {
  if (DRY_RUN) {
    console.log(
      `[QB DRY RUN] Would apply payment ${payload.creditTxnId} to invoice ${payload.invoiceId}`
    );
    return { success: true, dryRun: true, data: { operationId: "DRY_RUN" } };
  }

  try {
    const data = await bridgeFetch(
      "POST",
      `/api/payments/${payload.creditTxnId}/apply`,
      {
        customerId: payload.customerId,
        invoiceId: payload.invoiceId,
        amount: payload.amount,
        editSequence: payload.editSequence,
        ...(payload.memo !== undefined ? { memo: payload.memo } : {}),
      }
    );
    const operationId = data?.operationId;
    if (!operationId)
      throw new Error("Bridge did not return an operationId for apply-payment");
    return { success: true, data: { operationId } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Voids a payment entirely in QuickBooks.
 */
export async function voidPaymentInQb(
  paymentTxnId: string
): Promise<QbBridgeResult<QbAsyncResult>> {
  if (DRY_RUN) {
    console.log(`[QB DRY RUN] Would void payment ${paymentTxnId}`);
    return {
      success: true,
      dryRun: true,
      data: { operationId: "DRY_RUN", txnId: paymentTxnId },
    };
  }

  try {
    const data = await bridgeFetch(
      "POST",
      `/api/payments/${paymentTxnId}/void`,
      {}
    );
    const operationId = data?.operationId;
    if (!operationId)
      throw new Error("Bridge did not return an operationId for void-payment");
    return { success: true, data: { operationId, txnId: paymentTxnId } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Updates ONLY the TxnDate of a ReceivePayment (batch_day edit).
 *
 * Always queries QB fresh for the current EditSequence (cache is unreliable —
 * QB bumps it on every Mod/reconcile), then issues a ReceivePaymentMod with
 * just the new date. The bridge builder emits <TxnDate> when `date` is set
 * (receivePayment.ts). Safe for applied payments: the Mod carries no
 * AppliedToTxnMod, so existing applications are untouched.
 */
export async function updatePaymentTxnDateInQb(
  paymentTxnId: string,
  date: string,
  log: (msg: string) => void = console.log
): Promise<QbBridgeResult<QbAsyncResult>> {
  if (DRY_RUN) {
    console.log(
      `[QB DRY RUN] Would update payment ${paymentTxnId} TxnDate → ${date}`
    );
    return {
      success: true,
      dryRun: true,
      data: { operationId: "DRY_RUN", txnId: paymentTxnId },
    };
  }

  try {
    const state = await fetchPaymentCurrentState(paymentTxnId, log);
    const modResp = await bridgeFetch("PUT", `/api/payments/${paymentTxnId}`, {
      EditSequence: state.editSequence,
      date,
    });
    const operationId = modResp?.operationId;
    if (!operationId)
      throw new Error(
        "Bridge did not return an operationId for payment TxnDate mod"
      );
    return { success: true, data: { operationId, txnId: paymentTxnId } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Updates ONLY the PaymentMethodRef of a ReceivePayment (payment method edit).
 *
 * Always queries QB fresh for the current EditSequence (same self-healing
 * pattern as updatePaymentTxnDateInQb — cache is unreliable, QB bumps it on
 * every Mod/reconcile), then issues a ReceivePaymentMod with just the new
 * PaymentMethodRef. No AppliedToTxnMod is sent, so existing applications are
 * untouched.
 */
export async function updatePaymentMethodInQb(
  paymentTxnId: string,
  qbMethodName: string,
  log: (msg: string) => void = console.log
): Promise<QbBridgeResult<QbAsyncResult>> {
  if (DRY_RUN) {
    console.log(
      `[QB DRY RUN] Would update payment ${paymentTxnId} PaymentMethod → ${qbMethodName}`
    );
    return {
      success: true,
      dryRun: true,
      data: { operationId: "DRY_RUN", txnId: paymentTxnId },
    };
  }

  try {
    const state = await fetchPaymentCurrentState(paymentTxnId, log);
    const modResp = await bridgeFetch("PUT", `/api/payments/${paymentTxnId}`, {
      EditSequence: state.editSequence,
      paymentMethod: qbMethodName,
    });
    const operationId = modResp?.operationId;
    if (!operationId)
      throw new Error(
        "Bridge did not return an operationId for payment method mod"
      );
    return { success: true, data: { operationId, txnId: paymentTxnId } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Fetches the CURRENT live state of a ReceivePayment from QB:
 * - fresh EditSequence
 * - the full AppliedToTxnRet list (which invoices it currently pays, and how much)
 *
 * Used as the first step of mergeApplyPaymentInQb — you must know the current state
 * before issuing a ReceivePaymentMod, because AppliedToTxnMod is REPLACE-ALL semantics
 * in QB SDK (any application not included in the Mod gets silently unapplied).
 */
export async function fetchPaymentCurrentState(
  creditTxnId: string,
  log: (msg: string) => void = console.log,
  opts?: {
    /**
     * When true, throw if the header reports applied money but AppliedToTxnRet
     * came back empty — the tell of a ReceivePaymentQuery missing
     * IncludeLineItems (stale bridge). A Mod built from that state would
     * silently unapply every existing application (the Aug-2026 clobber bug).
     * Callers that only need the EditSequence (TxnDate/PaymentMethod mods,
     * which carry no AppliedToTxnMod) leave this off so a bridge regression
     * doesn't block harmless header edits.
     */
    requireTrustworthyAppliedList?: boolean;
  }
): Promise<PaymentCurrentState> {
  const res = await bridgeFetch("GET", `/api/payments/${creditTxnId}`);
  const operationId: string = res?.operationId || res?.operation?.id;
  if (!operationId) {
    throw new Error("Bridge did not return an operationId for payment query");
  }

  const raw = await pollRawOperationResult(operationId, log);
  const msgs = raw?.QBXML?.QBXMLMsgsRs ?? raw?.QBXMLMsgsRs ?? raw ?? {};
  const retRaw =
    msgs?.ReceivePaymentQueryRs?.ReceivePaymentRet ??
    raw?.ReceivePaymentQueryRs?.ReceivePaymentRet ??
    raw?.ReceivePaymentRet ??
    null;

  if (!retRaw) {
    throw new Error(
      `QB returned no ReceivePaymentRet for TxnID=${creditTxnId}`
    );
  }

  const ret: any = Array.isArray(retRaw) ? retRaw[0] : retRaw;
  const editSequence: string | undefined = ret?.EditSequence;
  if (!editSequence) {
    throw new Error(`QB response for TxnID=${creditTxnId} has no EditSequence`);
  }

  const appliedRaw = ret?.AppliedToTxnRet;
  const appliedArr: any[] = appliedRaw
    ? Array.isArray(appliedRaw)
      ? appliedRaw
      : [appliedRaw]
    : [];

  const appliedToInvoices: AppliedInvoiceState[] = appliedArr
    .map((a) => {
      const rawAmount = parseFloat(String(a?.PaymentAmount ?? a?.Amount ?? "0"));
      // Descuento vigente en QB para esta aplicación. Se preserva a través del
      // merge porque el Mod es REPLACE-ALL: omitirlo lo BORRA (ver el docstring
      // de AppliedInvoiceState).
      const rawDiscount = parseFloat(String(a?.DiscountAmount ?? ""));
      const discountAccount = String(
        a?.DiscountAccountRef?.ListID ?? ""
      ).trim();
      const hasDiscount =
        Number.isFinite(rawDiscount) &&
        Math.abs(rawDiscount) > 0.005 &&
        discountAccount.length > 0;
      return {
        invoiceId: String(a?.TxnID || ""),
        amount: Number.isFinite(rawAmount) ? Math.abs(rawAmount) : 0,
        ...(hasDiscount
          ? {
              discountAmount: Math.abs(rawDiscount),
              discountAccountListId: discountAccount,
            }
          : {}),
      };
    })
    .filter((a) => a.invoiceId && a.amount > 0);

  const totalAmountRaw = parseFloat(String(ret?.TotalAmount ?? ""));
  const unusedPaymentRaw = parseFloat(String(ret?.UnusedPayment ?? ""));
  const totalAmount = Number.isFinite(totalAmountRaw) ? totalAmountRaw : null;
  const unusedPayment = Number.isFinite(unusedPaymentRaw)
    ? unusedPaymentRaw
    : null;

  if (opts?.requireTrustworthyAppliedList) {
    const appliedPerHeader =
      totalAmount !== null && unusedPayment !== null
        ? totalAmount - unusedPayment
        : null;
    if (
      appliedToInvoices.length === 0 &&
      appliedPerHeader !== null &&
      appliedPerHeader > 0.005
    ) {
      throw new Error(
        `QB header for payment TxnID=${creditTxnId} reports $${appliedPerHeader.toFixed(2)} applied ` +
          `but ReceivePaymentQuery returned no AppliedToTxnRet — the bridge query is missing ` +
          `IncludeLineItems. REFUSING to build a Mod from this state: AppliedToTxnMod is ` +
          `REPLACE-ALL and would silently unapply the existing applications.`
      );
    }
  }

  return {
    editSequence: String(editSequence),
    appliedToInvoices,
    totalAmount,
    unusedPayment,
    customerListId: ret?.CustomerRef?.ListID
      ? String(ret.CustomerRef.ListID)
      : null,
  };
}

/**
 * Merge-applies a ReceivePayment to an invoice WITHOUT unapplying any existing
 * applications. Internally:
 *   1. Queries the live payment to get fresh EditSequence + current applied list.
 *   2. Merges the new application into that list (if invoiceId already exists,
 *      overwrites the amount; otherwise appends).
 *   3. Sends a single ReceivePaymentMod with all applications via the bridge's
 *      /merge-apply endpoint.
 *
 * IMPORTANT: callers MUST wrap this in `withQbLockResult(paymentTxnId, ...)` to
 * prevent race conditions. Two concurrent merge-applies on the same payment would
 * both read the same "before" state and one would clobber the other.
 */
export async function mergeApplyPaymentInQb(payload: {
  customerId: string;
  amount: number | string;
  invoiceId: string;
  creditTxnId: string;
  memo?: string;
  /**
   * Write-off de redondeo para ESTA aplicación (dólares + cuenta). Sólo afecta a
   * `invoiceId`; las demás aplicaciones conservan el descuento que ya tengan en
   * QuickBooks. Omitirlo NO borra un descuento previo de esta factura — para eso
   * hay que anular el ajuste explícitamente.
   */
  discountAmount?: number;
  discountAccountListId?: string;
  log?: (msg: string) => void;
  onQueued?: (operationId: string) => Promise<void>;
}): Promise<QbBridgeResult<MergeApplyResult>> {
  const log = payload.log ?? console.log;

  if (DRY_RUN) {
    log(
      `[QB DRY RUN] Would merge-apply payment ${payload.creditTxnId} to invoice ${payload.invoiceId}`
    );
    return {
      success: true,
      dryRun: true,
      data: {
        operationId: "DRY_RUN",
        newEditSequence: null,
        totalAppliedCount: 1,
      },
    };
  }

  const newAmount = Number(payload.amount);
  if (!Number.isFinite(newAmount) || newAmount <= 0) {
    return {
      success: false,
      error: `Invalid amount: ${payload.amount}`,
    };
  }

  try {
    // ── Step 1: fetch live state ───────────────────────────────────────────
    const state = await fetchPaymentCurrentState(payload.creditTxnId, log, {
      requireTrustworthyAppliedList: true,
    });
    log(
      `[QB] 🔎 Payment ${payload.creditTxnId} current state: EditSeq=${state.editSequence}, applied to ${state.appliedToInvoices.length} invoice(s)`
    );

    // ── Step 2: merge the new application into the list ────────────────────
    //
    // Las aplicaciones que NO son el objetivo viajan intactas — descuento
    // incluido. Reescribir una de ellas sin su `DiscountAmount` la dejaría sin
    // el write-off que ya tenía (Mod = REPLACE-ALL), y esa factura volvería a
    // mostrar el centavo abierto sin que nada falle ni se registre.
    const merged = mergeAppliedInvoices(state.appliedToInvoices, {
      invoiceId: payload.invoiceId,
      amount: newAmount,
      ...(payload.discountAmount !== undefined
        ? { discountAmount: payload.discountAmount }
        : {}),
      ...(payload.discountAccountListId !== undefined
        ? { discountAccountListId: payload.discountAccountListId }
        : {}),
    });

    const carriedDiscounts = merged.filter(
      (a) => a.discountAmount !== undefined
    ).length;
    if (carriedDiscounts > 0) {
      log(
        `[QB] 💠 Mod lleva ${carriedDiscounts} aplicación(es) con descuento de redondeo — preservarlas es obligatorio: AppliedToTxnMod es REPLACE-ALL`
      );
    }

    // ── Step 3: send the Mod with full list ────────────────────────────────
    const enqueueRes = await bridgeFetch(
      "POST",
      `/api/payments/${payload.creditTxnId}/merge-apply`,
      {
        customerId: payload.customerId,
        editSequence: state.editSequence,
        applications: merged,
        ...(payload.memo !== undefined ? { memo: payload.memo } : {}),
      }
    );

    const operationId: string = enqueueRes?.operationId;
    if (!operationId) {
      throw new Error("Bridge did not return operationId for merge-apply");
    }

    // Notify caller that the operation is enqueued so it can write a `submitted`
    // pipeline row before we block on polling. This prevents orphaned `pending` rows
    // if the process crashes during the poll.
    if (payload.onQueued) {
      await payload.onQueued(operationId);
    }

    // ── Step 4: poll for Mod completion to capture new EditSequence ────────
    const modResult = await pollOperationResult(operationId, log);
    const newEditSequence = modResult.editSequence || null;

    return {
      success: true,
      data: {
        operationId,
        newEditSequence,
        totalAppliedCount: merged.length,
      },
    };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

/**
 * Applies a QB Credit Memo to an Invoice by creating a new ReceivePayment (Add)
 * with SetCredit. Used when customer_payment.type === 'credit_memo'.
 * Unlike mergeApplyPaymentInQb, this does NOT query an existing ReceivePayment —
 * the creditMemoTxnId belongs to a CreditMemo record, not a ReceivePayment.
 */
export async function applyCreditMemoToInvoiceInQb(payload: {
  customerId: string;
  creditMemoTxnId: string;
  invoiceTxnId: string;
  amount: number;
  refNumber?: string;
  memo?: string;
  /**
   * `payment_application.id` (papp_…). Rides as the bridge Idempotency-Key so a
   * re-sent ADD collapses into the original op instead of minting a second
   * ReceivePayment. MUST be 1:1 with the document — a key keyed by anything
   * coarser (order id, payment id) would make the bridge swallow a second
   * LEGITIMATE application, which is worse than a duplicate: money silently
   * missing instead of visibly doubled.
   */
  applicationId?: string;
  log?: (msg: string) => void;
  onQueued?: (operationId: string) => Promise<void>;
}): Promise<QbBridgeResult<MergeApplyResult>> {
  const log = payload.log ?? console.log;

  if (DRY_RUN) {
    log(
      `[QB DRY RUN] Would apply credit memo ${payload.creditMemoTxnId} to invoice ${payload.invoiceTxnId}`
    );
    return {
      success: true,
      dryRun: true,
      data: {
        operationId: "DRY_RUN",
        newEditSequence: null,
        totalAppliedCount: 1,
      },
    };
  }

  try {
    const enqueueRes = await bridgeFetch(
      "POST",
      "/api/payments",
      {
        customerId: payload.customerId,
        totalAmount: 0,
        invoiceId: payload.invoiceTxnId,
        paymentAmount: 0,
        creditTxnId: payload.creditMemoTxnId,
        amount: payload.amount,
        ...(payload.refNumber ? { refNumber: payload.refNumber } : {}),
        ...(payload.memo ? { memo: payload.memo } : {}),
      },
      payload.applicationId
        ? { idempotencyKey: `apply-payment:${payload.applicationId}` }
        : undefined
    );

    const operationId: string = enqueueRes?.operationId;
    if (!operationId)
      throw new Error(
        "Bridge did not return operationId for credit-memo apply"
      );

    if (payload.onQueued) {
      await payload.onQueued(operationId);
    }

    const addResult = await pollOperationResult(operationId, log);
    return {
      success: true,
      data: {
        operationId,
        newEditSequence: addResult?.editSequence || null,
        totalAppliedCount: 1,
      },
    };
  } catch (err: any) {
    const msg: string = err?.message || String(err);
    // QB Error 3120 on AppliedToTxnAdd means the invoice has no open balance.
    // QB's "auto apply credits" preference can pay the invoice before our step runs.
    // Treat this as success — the credit IS applied, just by QB rather than us.
    // Root fix: disable "Automatically apply credits" in QB Desktop preferences
    // (Edit → Preferences → Sales & Customers → Company Preferences).
    if (msg.includes("3120")) {
      log(
        `[QB] ⚠️ applyCreditMemoToInvoiceInQb got 3120 for invoice ${payload.invoiceTxnId} — invoice already at $0 balance (QB auto-apply). Treating as success.`
      );
      return {
        success: true,
        data: { operationId: "QB_AUTO_APPLIED", newEditSequence: null, totalAppliedCount: 1 },
      };
    }
    return { success: false, error: msg };
  }
}

/**
 * Unapplies a payment from a specific invoice in QuickBooks WITHOUT touching its
 * other applications.
 *
 * AppliedToTxnMod is REPLACE-ALL: the old implementation sent a Mod carrying only
 * the target invoice at 0.00, which unapplied the target AND — by omission —
 * every other invoice the payment was applied to (same family as the merge-apply
 * clobber bug, Aug 2026). This version mirrors mergeApplyPaymentInQb:
 *   1. Queries the live payment (fresh EditSequence + full applied list, with
 *      the trustworthiness guard so an empty list can't masquerade as "nothing
 *      applied").
 *   2. Rebuilds the full list with the target set to 0.00 and everything else
 *      kept verbatim.
 *   3. Sends ONE ReceivePaymentMod via /merge-apply.
 *
 * `editSequence` is accepted for caller compatibility but IGNORED — a fresh one
 * is fetched in the same breath as the applied list, so the pair can't be stale
 * relative to each other.
 *
 * If the payment is not currently applied to the target invoice, this is a
 * successful no-op (nothing to unapply) and no Mod is sent.
 */
export async function unapplyPaymentFromInvoiceInQb(payload: {
  creditTxnId: string;
  invoiceId: string;
  editSequence?: string;
  log?: (msg: string) => void;
}): Promise<QbBridgeResult<QbAsyncResult>> {
  const log = payload.log ?? console.log;

  if (DRY_RUN) {
    console.log(
      `[QB DRY RUN] Would unapply payment ${payload.creditTxnId} from invoice ${payload.invoiceId}`
    );
    return { success: true, dryRun: true, data: { operationId: "DRY_RUN" } };
  }

  try {
    const state = await fetchPaymentCurrentState(payload.creditTxnId, log, {
      requireTrustworthyAppliedList: true,
    });

    const targetIdx = state.appliedToInvoices.findIndex(
      (a) => a.invoiceId === payload.invoiceId
    );
    if (targetIdx < 0) {
      log(
        `[QB] ⏭️ Payment ${payload.creditTxnId} is not applied to invoice ${payload.invoiceId} — nothing to unapply (no-op).`
      );
      return { success: true, data: { operationId: "NOOP_NOT_APPLIED" } };
    }

    const applications = state.appliedToInvoices.map((a, idx) => ({
      invoiceId: a.invoiceId,
      amount: idx === targetIdx ? 0 : a.amount,
    }));

    if (!state.customerListId) {
      throw new Error(
        `QB payment ${payload.creditTxnId} came back without CustomerRef.ListID — cannot build the unapply Mod`
      );
    }

    const data = await bridgeFetch(
      "POST",
      `/api/payments/${payload.creditTxnId}/merge-apply`,
      {
        customerId: state.customerListId,
        editSequence: state.editSequence,
        applications,
      }
    );
    const operationId = data?.operationId;
    if (!operationId)
      throw new Error(
        "Bridge did not return an operationId for unapply-payment"
      );
    return { success: true, data: { operationId } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

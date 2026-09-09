import { MedusaService } from "@medusajs/utils";

import { BankAccount } from "./models/bank-account";
import { BankAccountingSetup } from "./models/bank-accounting-setup";
import { BankConnection } from "./models/bank-connection";
import { BankDayClose } from "./models/bank-day-close";
import { BankDeposit } from "./models/bank-deposit";
import { BankDepositLine } from "./models/bank-deposit-line";
import { BankDirectExpense } from "./models/bank-direct-expense";
import { BankEvidenceDocument } from "./models/bank-evidence-document";
import { BankJournalEntry } from "./models/bank-journal-entry";
import { BankJournalLine } from "./models/bank-journal-line";
import { BankMerchantSettlement } from "./models/bank-merchant-settlement";
import { BankMerchantSettlementLine } from "./models/bank-merchant-settlement-line";
import { BankMovement } from "./models/bank-movement";
import { BankMovementAllocation } from "./models/bank-movement-allocation";
import { BankOpeningBalance } from "./models/bank-opening-balance";
import { BankOpeningClear } from "./models/bank-opening-clear";
import { BankOpeningEvidence } from "./models/bank-opening-evidence";
import { BankOpeningItem } from "./models/bank-opening-item";
import { BankReceiptAccounting } from "./models/bank-receipt-accounting";
import { BankReceiptConsumption } from "./models/bank-receipt-consumption";
import { BankReviewAttachment } from "./models/bank-review-attachment";
import { BankReviewEvent } from "./models/bank-review-event";
import { BankReviewPermission } from "./models/bank-review-permission";
import { BankReviewRule } from "./models/bank-review-rule";
import { BankSourceClaim } from "./models/bank-source-claim";
import { BankStatement } from "./models/bank-statement";
import { BankStatementLine } from "./models/bank-statement-line";
import { BankStatementMatch } from "./models/bank-statement-match";
import { BankSyncRun } from "./models/bank-sync-run";
import { BankTransaction } from "./models/bank-transaction";
import { BankTransactionReview } from "./models/bank-transaction-review";
import { BankWebhookEvent } from "./models/bank-webhook-event";

export default class BankingModuleService extends MedusaService({
  BankStatement,
  BankStatementLine,
  BankStatementMatch,
  BankMerchantSettlement,
  BankMerchantSettlementLine,
  BankMovement,
  BankMovementAllocation,
  BankSourceClaim,
  BankEvidenceDocument,
  BankOpeningEvidence,
  BankOpeningBalance,
  BankOpeningItem,
  BankOpeningClear,
  BankConnection,
  BankAccount,
  BankTransaction,
  BankSyncRun,
  BankWebhookEvent,
  BankTransactionReview,
  BankReviewRule,
  BankReviewEvent,
  BankDayClose,
  BankReviewAttachment,
  BankReviewPermission,
  BankDeposit,
  BankDepositLine,
  BankDirectExpense,
  BankJournalEntry,
  BankJournalLine,
  BankReceiptConsumption,
  BankReceiptAccounting,
  BankAccountingSetup,
}) {}

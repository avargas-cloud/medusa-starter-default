import { BankStatement } from "./models/bank-statement";
import { BankStatementLine } from "./models/bank-statement-line";
import { BankStatementMatch } from "./models/bank-statement-match";
import { BankOpeningEvidence } from "./models/bank-opening-evidence";
import { BankMerchantSettlement } from "./models/bank-merchant-settlement";
import { BankMerchantSettlementLine } from "./models/bank-merchant-settlement-line";
import { BankMovement } from "./models/bank-movement";
import { BankMovementAllocation } from "./models/bank-movement-allocation";
import { BankSourceClaim } from "./models/bank-source-claim";
import { BankEvidenceDocument } from "./models/bank-evidence-document";
import { BankOpeningBalance } from "./models/bank-opening-balance";
import { BankOpeningItem } from "./models/bank-opening-item";
import { BankOpeningClear } from "./models/bank-opening-clear";
import { BankReceiptConsumption } from "./models/bank-receipt-consumption";
import { BankReceiptAccounting } from "./models/bank-receipt-accounting";
import { BankAccountingSetup } from "./models/bank-accounting-setup";
import { MedusaService } from "@medusajs/utils";

import { BankAccount } from "./models/bank-account";
import { BankConnection } from "./models/bank-connection";
import { BankSyncRun } from "./models/bank-sync-run";
import { BankTransaction } from "./models/bank-transaction";
import { BankWebhookEvent } from "./models/bank-webhook-event";
import { BankTransactionReview } from "./models/bank-transaction-review";
import { BankReviewRule } from "./models/bank-review-rule";
import { BankReviewEvent } from "./models/bank-review-event";
import { BankDayClose } from "./models/bank-day-close";
import { BankReviewAttachment } from "./models/bank-review-attachment";
import { BankReviewPermission } from "./models/bank-review-permission";
import { BankDeposit } from "./models/bank-deposit";
import { BankDepositLine } from "./models/bank-deposit-line";
import { BankDirectExpense } from "./models/bank-direct-expense";
import { BankJournalEntry } from "./models/bank-journal-entry";
import { BankJournalLine } from "./models/bank-journal-line";

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

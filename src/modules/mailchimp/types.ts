/**
 * Mailchimp merge field tags as configured in the "Ecopowertech Audience" (e95660ef51).
 * Verified live 2026-05-25 via GET /lists/{id}/merge-fields.
 */

export interface MailchimpAddress {
  addr1: string;
  addr2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
}

export interface MailchimpMergeFields {
  FNAME?: string;
  LNAME?: string;
  ADDRESS?: MailchimpAddress;
  PHONE?: string;
  MMERGE5?: string; // Company Name
  MMERGE7?: string; // Customer Status (e.g. "New Customer", "Active")
  CUSTYPE?: string; // dropdown — must match one of CUSTOMER_TYPE_OPTIONS
  ACQCHN?: string; // dropdown — must match one of ACQUISITION_CHANNEL_OPTIONS
  // Intentionally NOT synced (per product decision 2026-05-25):
  // MMERGE6 (New Journey), MMERGE8 (Expiration Date),
  // MMERGE9 (First Purchase), MMERGE10 (Last Purchase),
  // MMERGE11 (Number of Purchases), MMERGE12 (Total Purchase Amount)
}

export type MailchimpMemberStatus =
  | "subscribed"
  | "unsubscribed"
  | "cleaned"
  | "pending"
  | "transactional"
  | "archived";

/**
 * Subset of {@link MailchimpMemberStatus} accepted by the SDK's `status_if_new`
 * parameter (the SDK's typings reject "archived" for new members — which is correct,
 * since you can't create a member directly into the archived state).
 */
export type MailchimpInitialStatus = Exclude<MailchimpMemberStatus, "archived">;

export interface MailchimpMember {
  id: string;
  email_address: string;
  status: MailchimpMemberStatus;
  merge_fields: Record<string, unknown>;
  tags: { id: number; name: string }[];
}

export interface MailchimpUpsertPayload {
  email: string;
  mergeFields: MailchimpMergeFields;
  tags: string[];
  /** Status applied ONLY when the member is being created. Existing members keep their status. */
  statusIfNew: MailchimpInitialStatus;
}

export interface MailchimpSyncResult {
  email: string;
  subscriberHash: string;
  action: "created" | "updated" | "skipped_compliance" | "error";
  /** Status the member had AFTER our call. `null` when action === "error". */
  status: MailchimpMemberStatus | null;
  /** True when member is in an opt-out state and we did NOT touch their subscription. */
  isOptedOut: boolean;
  error?: string;
}

/** Persisted on customer.metadata.mailchimp so we can audit and avoid redundant syncs. */
export interface MailchimpSyncMetadata {
  synced_at: string; // ISO timestamp
  subscriber_hash: string;
  last_status: MailchimpMemberStatus | null;
  last_action: MailchimpSyncResult["action"];
  is_opted_out: boolean;
  last_error?: string | null;
}

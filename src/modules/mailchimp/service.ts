import crypto from "crypto";
import mailchimp from "@mailchimp/mailchimp_marketing";
import { MedusaService } from "@medusajs/utils";
import type {
  MailchimpMember,
  MailchimpMemberStatus,
  MailchimpSyncResult,
  MailchimpUpsertPayload,
} from "./types";

/**
 * Lazy singleton — Mailchimp SDK client.
 * Configured on first access from process.env so the service still loads
 * during build/type-check when env vars are absent.
 */
let configured = false;
function getClient() {
  if (!configured) {
    const apiKey = process.env.MAILCHIMP_API_KEY;
    if (!apiKey) {
      throw new Error(
        "[Mailchimp] MAILCHIMP_API_KEY env var is missing — cannot make API calls."
      );
    }
    const server = apiKey.split("-")[1];
    if (!server) {
      throw new Error(
        "[Mailchimp] MAILCHIMP_API_KEY is malformed — expected 'key-dc' format (e.g. abc...xyz-us16)."
      );
    }
    mailchimp.setConfig({ apiKey, server });
    configured = true;
  }
  return mailchimp;
}

function getAudienceId(): string {
  const id = process.env.MAILCHIMP_AUDIENCE_ID;
  if (!id) {
    throw new Error("[Mailchimp] MAILCHIMP_AUDIENCE_ID env var is missing.");
  }
  return id;
}

/** Mailchimp identifies members by md5(lowercase(email)). */
export function subscriberHash(email: string): string {
  return crypto.createHash("md5").update(email.trim().toLowerCase()).digest("hex");
}

const OPTED_OUT_STATUSES: ReadonlySet<MailchimpMemberStatus> = new Set([
  "unsubscribed",
  "cleaned",
  "archived",
]);

class MailchimpModuleService extends MedusaService({}) {
  /**
   * Read a member's current state. Returns null on 404 (member doesn't exist yet).
   * Any other error is re-thrown.
   */
  async getMember(email: string): Promise<MailchimpMember | null> {
    const hash = subscriberHash(email);
    try {
      const res = (await getClient().lists.getListMember(
        getAudienceId(),
        hash
      )) as unknown as MailchimpMember;
      return res;
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 404) return null;
      throw err;
    }
  }

  /**
   * Idempotent upsert with full opt-out compliance.
   *  - new member  → PUT with status_if_new (configured default for our org)
   *  - existing active member → PATCH merge fields + sync tags
   *  - existing opted-out member → PATCH merge fields ONLY; never touches status or tags
   */
  async upsertMember(payload: MailchimpUpsertPayload): Promise<MailchimpSyncResult> {
    const { email, mergeFields, tags, statusIfNew } = payload;
    const hash = subscriberHash(email);
    const audienceId = getAudienceId();
    const client = getClient();

    let existing: MailchimpMember | null;
    try {
      existing = await this.getMember(email);
    } catch (err: unknown) {
      return {
        email,
        subscriberHash: hash,
        action: "error",
        status: null,
        isOptedOut: false,
        error: `getMember failed: ${(err as Error).message}`,
      };
    }

    const isOptedOut = existing
      ? OPTED_OUT_STATUSES.has(existing.status)
      : false;

    try {
      if (!existing) {
        // PUT with status_if_new — Mailchimp only applies status_if_new on create.
        await client.lists.setListMember(audienceId, hash, {
          email_address: email,
          status_if_new: statusIfNew,
          merge_fields: mergeFields as Record<string, unknown>,
        });
        if (tags.length > 0) {
          await this.syncTags(email, tags);
        }
        return {
          email,
          subscriberHash: hash,
          action: "created",
          status: statusIfNew,
          isOptedOut: false,
        };
      }

      // Existing member: PATCH merge fields (never include `status`)
      await client.lists.updateListMember(audienceId, hash, {
        merge_fields: mergeFields as Record<string, unknown>,
      });

      // Tag sync skipped for opted-out members to fully respect their compliance state.
      if (!isOptedOut && tags.length > 0) {
        await this.syncTags(email, tags);
      }

      return {
        email,
        subscriberHash: hash,
        action: isOptedOut ? "skipped_compliance" : "updated",
        status: existing.status,
        isOptedOut,
      };
    } catch (err: unknown) {
      return {
        email,
        subscriberHash: hash,
        action: "error",
        status: existing?.status ?? null,
        isOptedOut,
        error: (err as Error).message,
      };
    }
  }

  /**
   * Set the active set of tags on a member. Tags absent from the input list
   * are NOT removed (additive sync) — Mailchimp tags are typically curated
   * across multiple touchpoints, so we don't want POS to wipe campaign tags.
   */
  async syncTags(email: string, tags: string[]): Promise<void> {
    if (tags.length === 0) return;
    const hash = subscriberHash(email);
    await getClient().lists.updateListMemberTags(getAudienceId(), hash, {
      tags: tags.map((name) => ({ name, status: "active" as const })),
    });
  }

  /**
   * Migrate an existing Mailchimp member to a new email address. PATCHes the
   * record identified by the OLD email's hash with `email_address: NEW`,
   * which Mailchimp treats as a single in-place email change (no duplicate
   * member created).
   *
   * Returns:
   *  - action="email_changed" on success
   *  - action="created"  if the old member didn't exist (we fall back to
   *    upsertMember so the new email at least gets a record)
   *  - action="skipped_compliance" if the old member is in an opt-out state
   *    (we still PATCH merge_fields, but Mailchimp may reject the email
   *    change on cleaned/archived records — log and continue)
   *  - action="error" on any other failure
   */
  async changeMemberEmail(
    oldEmail: string,
    payload: MailchimpUpsertPayload
  ): Promise<MailchimpSyncResult> {
    const oldHash = subscriberHash(oldEmail);
    const newHash = subscriberHash(payload.email);
    const audienceId = getAudienceId();
    const client = getClient();

    // Sanity: same address? Fall back to regular upsert (no-op rename).
    if (oldHash === newHash) {
      return this.upsertMember(payload);
    }

    let existing: MailchimpMember | null;
    try {
      existing = await this.getMember(oldEmail);
    } catch (err: unknown) {
      return {
        email: payload.email,
        subscriberHash: newHash,
        action: "error",
        status: null,
        isOptedOut: false,
        error: `getMember(old) failed: ${(err as Error).message}`,
      };
    }

    // Old member doesn't exist → fall back to creating the new one fresh.
    if (!existing) {
      return this.upsertMember(payload);
    }

    const isOptedOut = OPTED_OUT_STATUSES.has(existing.status);

    try {
      // PATCH with both new email AND merge_fields. Mailchimp updates the
      // record in-place — old hash now resolves to nothing, new hash to
      // the (now-renamed) member.
      await client.lists.updateListMember(audienceId, oldHash, {
        email_address: payload.email,
        merge_fields: payload.mergeFields as Record<string, unknown>,
      });

      if (!isOptedOut && payload.tags.length > 0) {
        // Tags now belong to the new-hash member.
        await this.syncTags(payload.email, payload.tags);
      }

      return {
        email: payload.email,
        subscriberHash: newHash,
        action: isOptedOut ? "skipped_compliance" : "email_changed",
        status: existing.status,
        isOptedOut,
      };
    } catch (err: unknown) {
      // Most common failure: Mailchimp rejects the email change because the
      // new address collides with an existing member, or the old member is
      // in a permanent compliance state. Surface clearly and don't fall
      // through to a create — that would just orphan another record.
      return {
        email: payload.email,
        subscriberHash: newHash,
        action: "error",
        status: existing.status,
        isOptedOut,
        error: `email change failed: ${(err as Error).message}`,
      };
    }
  }
}

export default MailchimpModuleService;

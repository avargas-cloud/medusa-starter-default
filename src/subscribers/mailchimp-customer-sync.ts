import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import { ContainerRegistrationKeys, Modules } from "@medusajs/utils";
import {
  customerToMailchimpPayload,
  MAILCHIMP_MODULE,
  MailchimpModuleService,
  type CustomerForMailchimp,
  type MailchimpInitialStatus,
  type MailchimpSyncMetadata,
} from "../modules/mailchimp";

const LOG_PREFIX = "[mailchimp-sync]";

/** Re-sync suppression window — prevents the metadata write below from
 *  re-firing customer.updated → re-sync → infinite loop. */
const RESYNC_SUPPRESSION_MS = 30_000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(email: unknown): email is string {
  return typeof email === "string" && EMAIL_RE.test(email.trim());
}

function defaultStatusFromEnv(): MailchimpInitialStatus {
  const raw = (process.env.MAILCHIMP_DEFAULT_STATUS ?? "transactional").toLowerCase();
  if (raw === "subscribed" || raw === "transactional" || raw === "pending") {
    return raw;
  }
  return "transactional";
}

export default async function mailchimpCustomerSync({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const customerId = data?.id;
  if (!customerId) {
    logger.warn(`${LOG_PREFIX} event fired without customer id — skipping`);
    return;
  }

  // Hard skip when integration is not configured. Keeps local dev / preview clean.
  if (!process.env.MAILCHIMP_API_KEY || !process.env.MAILCHIMP_AUDIENCE_ID) {
    return;
  }

  try {
    const query = container.resolve(ContainerRegistrationKeys.QUERY);
    const { data: results } = await query.graph({
      entity: "customer",
      fields: [
        "id",
        "email",
        "first_name",
        "last_name",
        "phone",
        "company_name",
        "created_at",
        "metadata",
        "addresses.*",
      ],
      filters: { id: customerId },
    });

    const customer = results?.[0];
    if (!customer) {
      logger.warn(`${LOG_PREFIX} customer ${customerId} not found — skipping`);
      return;
    }

    if (!isValidEmail(customer.email)) {
      logger.info(
        `${LOG_PREFIX} customer ${customerId} has missing/invalid email — skipping`
      );
      return;
    }

    // Loop guard — if we just wrote the tracker, the resulting customer.updated
    // would re-enter here. Skip if we synced within the suppression window.
    const meta = (customer.metadata ?? {}) as Record<string, unknown>;
    const existingTracker = meta.mailchimp as MailchimpSyncMetadata | undefined;
    if (existingTracker?.synced_at) {
      const age = Date.now() - new Date(existingTracker.synced_at).getTime();
      if (age >= 0 && age < RESYNC_SUPPRESSION_MS) {
        return;
      }
    }

    const rawAddresses = Array.isArray(customer.addresses) ? customer.addresses : [];
    const addresses = rawAddresses.filter((a): a is NonNullable<typeof a> => a != null);
    const defaultAddress =
      addresses.find((a) => a.is_default_billing === true) ??
      addresses.find((a) => a.is_default_shipping === true) ??
      addresses[0] ??
      null;

    const customerForSync: CustomerForMailchimp = {
      id: customer.id,
      email: customer.email,
      first_name: customer.first_name,
      last_name: customer.last_name,
      phone: customer.phone,
      company_name: customer.company_name,
      created_at: new Date(customer.created_at),
      metadata: customer.metadata as Record<string, unknown> | null,
      defaultAddress,
    };

    const payload = customerToMailchimpPayload(customerForSync, defaultStatusFromEnv());

    const mailchimpService = container.resolve<MailchimpModuleService>(
      MAILCHIMP_MODULE
    );

    // Email-change detection: if we have a tracker AND the email differs
    // from what we last synced, route to changeMemberEmail so the OLD
    // Mailchimp member is migrated in-place (no orphan record).
    const previousEmail = existingTracker?.last_email;
    const result =
      previousEmail && previousEmail !== payload.email
        ? await mailchimpService.changeMemberEmail(previousEmail, payload)
        : await mailchimpService.upsertMember(payload);

    const tracker: MailchimpSyncMetadata = {
      synced_at: new Date().toISOString(),
      subscriber_hash: result.subscriberHash,
      last_email: payload.email,
      last_status: result.status,
      last_action: result.action,
      is_opted_out: result.isOptedOut,
      last_error: result.error ?? null,
    };

    const customerModule = container.resolve(Modules.CUSTOMER);
    await customerModule.updateCustomers(customerId, {
      metadata: { ...meta, mailchimp: tracker },
    });

    if (result.action === "error") {
      logger.warn(
        `${LOG_PREFIX} ${customer.email} sync error: ${result.error}`
      );
    } else {
      logger.info(
        `${LOG_PREFIX} ${customer.email} → ${result.action}${
          result.isOptedOut ? " (opted-out, compliance respected)" : ""
        }`
      );
    }
  } catch (err: unknown) {
    // Never bubble up — POS flow must not be blocked by a Mailchimp failure.
    logger.error(
      `${LOG_PREFIX} unexpected error for customer ${customerId}: ${
        (err as Error).message
      }`
    );
  }
}

export const config: SubscriberConfig = {
  event: ["customer.created", "customer.updated"],
};

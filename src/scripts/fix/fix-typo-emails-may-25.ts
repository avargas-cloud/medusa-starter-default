/**
 * One-shot: correct two customer emails with obvious typos that Mailchimp
 * rejected during the 2026-05-25 backfill, then push a Mod to QuickBooks
 * and retry the Mailchimp upsert.
 *
 *   scg.meny@gamil.com    → scg.meny@gmail.com    (cus_01KG0S3GB6K0FG245M99F9GZGA)
 *   jorgito26@icluod.com  → jorgito26@icloud.com  (cus_01KPXPXKH7X8RSP6JA27R2WMSS)
 *
 * Run:
 *   yarn medusa exec ./src/scripts/fix/fix-typo-emails-may-25.ts
 */
import type { ExecArgs } from "@medusajs/framework/types";
import { Modules } from "@medusajs/utils";
import postgres from "postgres";
import { syncCustomerToQb } from "../../lib/quickbooks/order-flow-core";
import {
  customerToMailchimpPayload,
  MAILCHIMP_MODULE,
  MailchimpModuleService,
  type CustomerForMailchimp,
  type MailchimpInitialStatus,
  type MailchimpSyncMetadata,
} from "../../modules/mailchimp";

const FIXES: { id: string; oldEmail: string; newEmail: string }[] = [
  { id: "cus_01KG0S3GB6K0FG245M99F9GZGA", oldEmail: "scg.meny@gamil.com", newEmail: "scg.meny@gmail.com" },
  { id: "cus_01KPXPXKH7X8RSP6JA27R2WMSS", oldEmail: "jorgito26@icluod.com", newEmail: "jorgito26@icloud.com" },
];

function defaultStatusFromEnv(): MailchimpInitialStatus {
  const raw = (process.env.MAILCHIMP_DEFAULT_STATUS ?? "transactional").toLowerCase();
  if (raw === "subscribed" || raw === "transactional" || raw === "pending") return raw;
  return "transactional";
}

export default async function fixTypoEmailsMay25({ container }: ExecArgs): Promise<void> {
  const log = (m: string) => console.log(`[fix-typo-emails] ${m}`);
  const customerModule = container.resolve(Modules.CUSTOMER);
  const mailchimpService = container.resolve<MailchimpModuleService>(MAILCHIMP_MODULE);
  const sql = postgres(process.env.DATABASE_URL!, { max: 2 });

  try {
    for (const fix of FIXES) {
      log(`──────── ${fix.oldEmail} → ${fix.newEmail} ────────`);

      const current = await customerModule.retrieveCustomer(fix.id);
      if (current.email !== fix.oldEmail) {
        log(`⚠️  email already changed (${current.email}); skipping`);
        continue;
      }

      // 1. Update email in Medusa
      await customerModule.updateCustomers(fix.id, { email: fix.newEmail });
      log(`✅ Medusa email updated`);

      // 2. Load fresh customer + addresses for QB sync
      const updated = await customerModule.retrieveCustomer(fix.id, {
        relations: ["addresses"],
      });
      const customerForQb = {
        id: updated.id,
        email: updated.email,
        first_name: updated.first_name ?? null,
        last_name: updated.last_name ?? null,
        company_name: updated.company_name ?? null,
        phone: updated.phone ?? null,
        metadata: (updated.metadata ?? {}) as Record<string, unknown>,
        addresses: ((updated.addresses ?? []) as Array<Record<string, unknown>>).map(
          (a) => ({
            id: a.id as string,
            address_1: (a.address_1 as string | null) ?? null,
            address_2: (a.address_2 as string | null) ?? null,
            city: (a.city as string | null) ?? null,
            province: (a.province as string | null) ?? null,
            postal_code: (a.postal_code as string | null) ?? null,
            is_default_billing:
              (a.is_default_billing as boolean | undefined) ?? false,
            is_default_shipping:
              (a.is_default_shipping as boolean | undefined) ?? false,
            metadata: (a.metadata as Record<string, unknown> | null) ?? {},
          })
        ),
      };

      // 3. Push Mod to QB
      try {
        const qbResult = await syncCustomerToQb(
          customerForQb as unknown as Parameters<typeof syncCustomerToQb>[0],
          customerModule,
          (msg) => log(`  [qb] ${msg}`)
        );
        if (qbResult.success) {
          log(`✅ QB Mod sent (qbCustomerId=${qbResult.qbCustomerId ?? "n/a"})`);
        } else {
          log(`⚠️  QB sync returned non-success: ${qbResult.error ?? "no error msg"}`);
        }
      } catch (err: unknown) {
        log(`❌ QB sync threw: ${(err as Error).message}`);
      }

      // 4. Mailchimp upsert with corrected email
      const addressRow = await sql<
        {
          address_1: string | null;
          address_2: string | null;
          city: string | null;
          province: string | null;
          postal_code: string | null;
          country_code: string | null;
          phone: string | null;
        }[]
      >`
        SELECT address_1, address_2, city, province, postal_code, country_code, phone
        FROM customer_address
        WHERE customer_id = ${fix.id} AND deleted_at IS NULL
        ORDER BY (is_default_billing IS TRUE) DESC, (is_default_shipping IS TRUE) DESC, created_at ASC
        LIMIT 1
      `;

      const customerForMc: CustomerForMailchimp = {
        id: updated.id,
        email: updated.email!,
        first_name: updated.first_name,
        last_name: updated.last_name,
        phone: updated.phone,
        company_name: updated.company_name,
        created_at: new Date(updated.created_at as unknown as string),
        metadata: (updated.metadata ?? null) as Record<string, unknown> | null,
        defaultAddress: addressRow[0] ?? null,
      };

      const payload = customerToMailchimpPayload(customerForMc, defaultStatusFromEnv());
      const mcResult = await mailchimpService.upsertMember(payload);

      const tracker: MailchimpSyncMetadata = {
        synced_at: new Date().toISOString(),
        subscriber_hash: mcResult.subscriberHash,
        last_status: mcResult.status,
        last_action: mcResult.action,
        is_opted_out: mcResult.isOptedOut,
        last_error: mcResult.error ?? null,
      };
      const trackerJsonValue = JSON.parse(JSON.stringify(tracker));
      await sql`
        UPDATE customer
        SET metadata = COALESCE(metadata, '{}'::jsonb)
                     || jsonb_build_object('mailchimp', ${sql.json(trackerJsonValue)}),
            updated_at = NOW()
        WHERE id = ${fix.id}
      `;

      if (mcResult.action === "error") {
        log(`❌ Mailchimp ${mcResult.action}: ${mcResult.error}`);
      } else {
        log(`✅ Mailchimp ${mcResult.action}${mcResult.isOptedOut ? " (opted-out)" : ""}`);
      }
    }

    log(`Done.`);
  } finally {
    await sql.end();
  }
}

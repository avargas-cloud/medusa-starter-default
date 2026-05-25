import { Module } from "@medusajs/utils";
import MailchimpModuleService from "./service";

export const MAILCHIMP_MODULE = "mailchimp";

export default Module(MAILCHIMP_MODULE, {
  service: MailchimpModuleService,
});

export { MailchimpModuleService };
export * from "./types";
export {
  customerToMailchimpPayload,
  deriveCustomerStatus,
  buildTags,
  NEW_CUSTOMER_CUTOFF_UTC,
} from "./mappers";
export type { CustomerForMailchimp } from "./mappers";
export { subscriberHash } from "./service";

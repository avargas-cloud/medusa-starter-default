/**
 * Add-only reconciler: converts a customer's tier signal into group
 * membership. Never removes a customer from a group (project-wide rule —
 * "never remove anyone from a customer group"). If the customer ends up in
 * no group at all (no signal, no existing membership), it defaults to
 * Retail — everyone is in exactly one of {Retail, Wholesale} once
 * reconciled, but a customer already correctly in Wholesale is left alone
 * even if they also happen to sit in some other unrelated group.
 */
import { Modules } from "@medusajs/utils";

import {
  resolveCustomerTier,
  type CustomerTierInput,
} from "./customer-tier";
import { resolveGroupIdByName } from "./resolve-group-ids";
import { loadCustomerTierInput } from "./load-customer-tier-input";

export interface PlanCustomerGroupReconcileInput {
  tier: "wholesale" | "retail";
  memberGroupIds: ReadonlyArray<string>;
  wholesaleGroupId: string;
  retailGroupId: string;
}

export interface PlanCustomerGroupReconcileResult {
  add: string[];
}

/** Pure planning function — no I/O, easy to unit test and mutation test. */
export function planCustomerGroupReconcile(
  input: PlanCustomerGroupReconcileInput
): PlanCustomerGroupReconcileResult {
  const { tier, memberGroupIds, wholesaleGroupId, retailGroupId } = input;
  const add: string[] = [];
  const members = new Set(memberGroupIds);

  if (tier === "wholesale" && !members.has(wholesaleGroupId)) {
    add.push(wholesaleGroupId);
  }

  const afterAdds = new Set(members);
  for (const id of add) afterAdds.add(id);

  if (afterAdds.size === 0) {
    add.push(retailGroupId);
  }

  return { add };
}

interface CustomerModuleLike {
  addCustomerToGroup(input: {
    customer_id: string;
    customer_group_id: string;
  }): Promise<unknown>;
}

interface ContainerLike {
  resolve(key: string): unknown;
}

interface ReconcileLoggerLike {
  info: (msg: string) => void;
}

export interface ReconcileCustomerGroupsResult {
  added: string[];
}

/**
 * Loads the customer's LIVE tier input (metadata, groups — via
 * `loadCustomerTierInput`, NOT `query.graph`'s `groups.*`, which still
 * returns soft-deleted `customer_group_customer` rows), resolves the
 * Retail/Wholesale group ids BY NAME, plans the add-only diff against the
 * LIVE membership, and applies it — idempotent (skips ids already applied by
 * `planCustomerGroupReconcile`, and `addCustomerToGroup` itself is a no-op if
 * already a member).
 */
export async function reconcileCustomerGroups(
  container: ContainerLike,
  customerId: string
): Promise<ReconcileCustomerGroupsResult> {
  const customerModule = container.resolve(
    Modules.CUSTOMER
  ) as CustomerModuleLike;
  const logger = container.resolve("logger") as ReconcileLoggerLike;

  const tierInput = await loadCustomerTierInput(container, customerId);
  if (!tierInput) {
    throw new Error(
      `[reconcileCustomerGroups] Customer ${customerId} not found`
    );
  }

  const [wholesaleGroupId, retailGroupId] = await Promise.all([
    resolveGroupIdByName(container, "Wholesale"),
    resolveGroupIdByName(container, "Retail"),
  ]);

  const memberGroupIds = tierInput.groups.map((g) => g.id);
  const tierInputForResolve: CustomerTierInput = {
    groups: tierInput.groups,
    metadata: tierInput.metadata,
  };
  const tier = resolveCustomerTier(tierInputForResolve);

  const { add } = planCustomerGroupReconcile({
    tier,
    memberGroupIds,
    wholesaleGroupId,
    retailGroupId,
  });

  const added: string[] = [];
  for (const groupId of add) {
    if (memberGroupIds.includes(groupId)) continue; // already a member
    await customerModule.addCustomerToGroup({
      customer_id: customerId,
      customer_group_id: groupId,
    });
    added.push(groupId);
    logger.info(
      `[reconcileCustomerGroups] Added customer ${customerId} to group ${groupId}`
    );
  }

  return { added };
}

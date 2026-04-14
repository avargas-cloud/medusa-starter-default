/**
 * src/workflows/create-pos-user.ts
 * Creates a POS-only user and links it to Medusa's auth identity
 * via actor_type "pos_user".
 *
 * This workflow is triggered by POST /admin/pos-users.
 */

import {
  createWorkflow,
  WorkflowResponse,
  createStep,
  StepResponse,
  transform,
} from "@medusajs/framework/workflows-sdk";
import { setAuthAppMetadataStep } from "@medusajs/medusa/core-flows";

import { POS_USER_MODULE } from "../modules/pos-user";

// ─── Types ───────────────────────────────────────────────────────────────────
export type CreatePosUserInput = {
  email: string;
  first_name?: string;
  last_name?: string;
  authIdentityId: string;
};

// ─── Step: Create PosUser record ─────────────────────────────────────────────
const createPosUserStep = createStep(
  "create-pos-user-step",
  async (
    input: { email: string; first_name?: string; last_name?: string },
    { container }
  ) => {
    const posUserService = container.resolve(POS_USER_MODULE) as any;
    const posUser = await posUserService.createPosUsers(input);
    return new StepResponse(posUser, posUser.id);
  },
  async (posUserId: string | undefined, { container }) => {
    if (!posUserId) return;
    const posUserService = container.resolve(POS_USER_MODULE) as any;
    await posUserService.deletePosUsers(posUserId);
  }
);

// ─── Workflow ─────────────────────────────────────────────────────────────────
export const createPosUserWorkflow = createWorkflow(
  "create-pos-user",
  function (input: CreatePosUserInput) {
    const posUser = createPosUserStep({
      email: input.email,
      first_name: input.first_name,
      last_name: input.last_name,
    });

    // `posUser` is WorkflowData — extract the id via transform
    const posUserId = transform(posUser, (u) => u.id);

    setAuthAppMetadataStep({
      authIdentityId: input.authIdentityId,
      actorType: "pos_user",
      value: posUserId,
    });

    return new WorkflowResponse(posUser);
  }
);

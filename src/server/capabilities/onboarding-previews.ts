import "server-only";

import { ONBOARDING_ROLE_LABELS, isOnboardingRole } from "@/lib/self-onboarding";
import type {
  approveOnboardingSchema,
  onboardingInviteIdSchema,
  onboardingInviteSchema,
} from "@/server/people/self-onboarding-schemas";

import type { CapabilityPreview, PreviewFn } from "./types";

/**
 * What approving a self-onboarding submission (slice U.4) will do, read with the caller's own
 * client. Masked values only: the role, whether an employee record and a pay rate are added, and
 * whether bank details will wait for a second approver.
 */
export const previewApproveOnboarding: PreviewFn<typeof approveOnboardingSchema> = async (ctx) => {
  const { data: invite, error } = await ctx.supabase
    .from("onboarding_invites")
    .select("role, on_payroll, status, first_name, last_name, bank_account_last4")
    .eq("organisation_id", ctx.organisationId)
    .eq("id", ctx.data.inviteId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the invite (${error.code})`);
  if (!invite || !isOnboardingRole(invite.role) || invite.status !== "submitted") {
    return { summary: "Nothing to approve: the invite isn't waiting for review.", changes: [] };
  }
  const role = ONBOARDING_ROLE_LABELS[invite.role];
  const name = [invite.first_name, invite.last_name].filter(Boolean).join(" ") || "This person";
  const changes: CapabilityPreview["changes"] = [{ label: "Role", after: role }];
  if (invite.on_payroll) {
    changes.push({ label: "Employee record", after: `Added as ${role}` });
    if (ctx.data.payType) changes.push({ label: "Pay rate", after: ctx.data.payType });
  }
  if (invite.bank_account_last4) {
    changes.push({
      label: "Bank details",
      after: `Account ending ${invite.bank_account_last4}, waiting for a second approver`,
    });
  }
  return { summary: `Approves ${name} as ${role}.`, changes };
};

/** Inviting (security review L9): who gets the link, with which fixed role. */
export const previewInviteOnboarding: PreviewFn<typeof onboardingInviteSchema> = ({ data }) => {
  const role = ONBOARDING_ROLE_LABELS[data.role];
  return {
    summary: `Emails ${data.email} a link to fill in their details as ${role}. It works for 7 days.`,
    changes: [{ label: "Role (fixed)", after: role }],
  };
};

async function readInvite(
  ctx: Parameters<PreviewFn<typeof onboardingInviteIdSchema>>[0],
): Promise<{ email: string; role: string; status: string } | null> {
  const { data, error } = await ctx.supabase
    .from("onboarding_invites")
    .select("email, role, status")
    .eq("organisation_id", ctx.organisationId)
    .eq("id", ctx.data.inviteId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the invite (${error.code})`);
  return data;
}

export const previewResendOnboarding: PreviewFn<typeof onboardingInviteIdSchema> = async (ctx) => {
  const invite = await readInvite(ctx);
  if (!invite) return { summary: "That invite wasn't found.", changes: [] };
  return {
    summary: `Sends ${invite.email} a new link for 7 days. The old link stops working.`,
    changes: [{ label: "Link", before: "Current link", after: "New link" }],
  };
};

export const previewCancelOnboarding: PreviewFn<typeof onboardingInviteIdSchema> = async (ctx) => {
  const invite = await readInvite(ctx);
  if (!invite) return { summary: "That invite wasn't found.", changes: [] };
  return {
    summary: `Cancels the invite for ${invite.email}. Its link stops working and any details sent are cleared.`,
    changes: [{ label: "Status", before: invite.status, after: "cancelled" }],
  };
};

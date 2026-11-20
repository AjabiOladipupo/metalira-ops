import "server-only";

import { planEndContract } from "@/lib/activation";
import { formatDate } from "@/lib/dates";
import type { activateContractSchema, endContractSchema } from "@/server/business/activation";
import {
  loadActivationContext,
  loadActivationPlan,
  loadPosts,
} from "@/server/business/activation-data";
import { organisationToday } from "@/server/business/contracts-data";

import type { PreviewFn } from "./types";

/**
 * Previews for activating and ending a contract (slice 2.7), kept beside ./previews.ts. The
 * activation preview is the same checklist and post list the "Activate contract" page shows
 * (`planActivation`); the database checks everything again when it runs.
 */

export const previewActivateContract: PreviewFn<typeof activateContractSchema> = async ({
  supabase,
  organisationId,
  data,
}) => {
  const loaded = await loadActivationPlan(supabase, organisationId, data.contractId, {
    goLiveDate: data.goLiveDate,
  });
  if (!loaded) return { summary: "That contract wasn't found.", changes: [] };
  const { context, plan } = loaded;
  if (context.contract.status !== "draft") {
    return {
      summary:
        context.contract.status === "active"
          ? "This contract is already live. Nothing changes."
          : "This contract has ended and can't be activated.",
      changes: [],
    };
  }
  if (!plan.ready) {
    return {
      summary: `Can't go live yet: ${plan.issues.length} ${plan.issues.length === 1 ? "thing" : "things"} to fix.`,
      changes: plan.issues.map((i) => ({ label: i.code, after: i.message })),
    };
  }
  return {
    summary: plan.summary,
    changes: [
      { label: "Status", before: "Draft", after: `Active from ${formatDate(plan.goLiveDate)}` },
      ...plan.posts.map((p) => ({
        label: `${p.name} at ${p.siteName}`,
        after: `${p.days} · ${p.hours} · ${p.requiredCount} required`,
      })),
      {
        label: "Welcome email",
        after: data.sendWelcome ? "Sent to the client's ops and billing contacts" : "Not sent",
      },
    ],
  };
};

export const previewEndContract: PreviewFn<typeof endContractSchema> = async ({
  supabase,
  organisationId,
  data,
}) => {
  const [context, today] = await Promise.all([
    loadActivationContext(supabase, organisationId, data.contractId),
    organisationToday(supabase, organisationId),
  ]);
  if (!context) return { summary: "That contract wasn't found.", changes: [] };
  const posts = await loadPosts(supabase, organisationId, data.contractId, today);
  const open = posts.filter((p) => p.status === "open");
  const plan = planEndContract({
    status: context.contract.status,
    goLiveDate: context.contract.goLiveDate,
    endDate: context.contract.endDate,
    endReason: context.contract.endReason,
    today,
    endOn: data.endDate,
    openPosts: open.length,
  });
  if (!plan.ok) return { summary: plan.reason, changes: [] };
  return {
    summary: plan.summary,
    changes: [
      {
        label: "Last day of service",
        before: context.contract.endDate ? formatDate(context.contract.endDate) : "Rolling",
        after: formatDate(data.endDate),
      },
      ...open.map((p) => ({
        label: `${p.name} at ${p.siteName}`,
        before: "Open",
        after: "Closed",
      })),
    ],
  };
};

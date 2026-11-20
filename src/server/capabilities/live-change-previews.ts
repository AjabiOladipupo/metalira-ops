import "server-only";

import { formatDate } from "@/lib/dates";
import {
  describeValues,
  formatWeek,
  planAddPost,
  planCancelRequirementChange,
  planClosePost,
  planRequirementChange,
} from "@/lib/live-changes";
import { organisationToday } from "@/server/business/contracts-data";
import type {
  addPostSchema,
  cancelRequirementChangeSchema,
  changeRequirementSchema,
  closePostSchema,
} from "@/server/business/live-changes";
import { loadAddPostContext, loadPostDetail } from "@/server/business/live-changes-data";

import type { CapabilityPreview, PreviewFn } from "./types";

/**
 * Previews for changes to a live contract (slice 2.8): the same plans the confirm steps on the
 * Posts tab show (`planRequirementChange`, `planAddPost`, `planClosePost`). The database checks
 * everything again when the change runs.
 */

const NOT_FOUND: CapabilityPreview = { summary: "That post wasn't found.", changes: [] };

function range(from: string, to: string | null): string {
  return to ? `${formatDate(from)} to ${formatDate(to)}` : `From ${formatDate(from)}`;
}

export const previewChangeRequirement: PreviewFn<typeof changeRequirementSchema> = async ({
  supabase,
  organisationId,
  data,
}) => {
  const [detail, today] = await Promise.all([
    loadPostDetail(supabase, organisationId, data.postId),
    organisationToday(supabase, organisationId),
  ]);
  if (!detail) return NOT_FOUND;
  const plan = planRequirementChange({
    contract: detail.contract,
    post: detail.post,
    versions: detail.versions,
    today,
    from: data.from,
    next: data,
  });
  if (!plan.ok) return { summary: plan.reason, changes: [] };
  return {
    summary: plan.summary,
    changes: [
      plan.closes
        ? {
            label: `Requirement from ${formatDate(plan.closes.effectiveFrom)}`,
            before: describeValues(plan.before),
            after: `Ends ${formatDate(plan.closes.effectiveToAfter)}`,
          }
        : {
            label: `Scheduled requirement from ${formatDate(data.from)}`,
            before: describeValues(plan.before),
            after: "Replaced",
          },
      {
        label: `New requirement ${range(plan.starts.effectiveFrom, plan.starts.effectiveTo).toLowerCase()}`,
        after: describeValues(plan.after),
      },
      {
        label: "A week of this post",
        before: formatWeek(plan.week.before),
        after: formatWeek(plan.week.after),
      },
    ],
  };
};

export const previewAddPost: PreviewFn<typeof addPostSchema> = async ({
  supabase,
  organisationId,
  data,
}) => {
  const [context, today] = await Promise.all([
    loadAddPostContext(supabase, organisationId, data.contractId),
    organisationToday(supabase, organisationId),
  ]);
  if (!context) return { summary: "That contract wasn't found.", changes: [] };
  const plan = planAddPost({
    contract: context.contract,
    today,
    input: { ...data, postName: data.postName ?? "" },
    site: context.sites.find((s) => s.id === data.siteId) ?? null,
    addSite: data.addSite,
    clientArchived: context.contract.clientArchived,
    sitePosts: context.sitePosts[data.siteId] ?? [],
    rates: context.rates,
  });
  if (!plan.ok) return { summary: plan.reason, changes: [] };
  return {
    summary: plan.summary,
    changes: [
      ...(plan.siteAdded ? [{ label: "Contract sites", after: `Adds ${plan.siteName}` }] : []),
      { label: `${plan.name} at ${plan.siteName}`, after: `Opens ${formatDate(data.from)}` },
      { label: "Requirement", after: describeValues(data) },
      { label: "A week of this post", after: formatWeek(plan.week) },
    ],
  };
};

export const previewClosePost: PreviewFn<typeof closePostSchema> = async ({
  supabase,
  organisationId,
  data,
}) => {
  const [detail, today] = await Promise.all([
    loadPostDetail(supabase, organisationId, data.postId),
    organisationToday(supabase, organisationId),
  ]);
  if (!detail) return NOT_FOUND;
  const plan = planClosePost({
    contract: detail.contract,
    post: detail.post,
    versions: detail.versions,
    today,
    lastDay: data.lastDay,
    reason: data.reason,
  });
  if (!plan.ok) return { summary: plan.reason, changes: [] };
  return {
    summary: plan.summary,
    changes: [
      {
        label: detail.post.name,
        before: "Open",
        after: `Closed after ${formatDate(data.lastDay)}`,
      },
      ...detail.versions
        .filter((v) => plan.cancels.includes(v.id))
        .map((v) => ({
          label: `Scheduled change from ${formatDate(v.effectiveFrom)}`,
          before: describeValues(v),
          after: "Removed",
        })),
      { label: "A week of this post", before: formatWeek(plan.week.before), after: "None" },
    ],
  };
};

export const previewCancelRequirementChange: PreviewFn<
  typeof cancelRequirementChangeSchema
> = async ({ supabase, organisationId, data }) => {
  const [detail, today] = await Promise.all([
    loadPostDetail(supabase, organisationId, data.postId),
    organisationToday(supabase, organisationId),
  ]);
  if (!detail) return NOT_FOUND;
  const plan = planCancelRequirementChange({
    contract: detail.contract,
    post: detail.post,
    versions: detail.versions,
    today,
    requirementId: data.requirementId,
  });
  if (!plan.ok) return { summary: plan.reason, changes: [] };
  return {
    summary: plan.summary,
    changes: [
      {
        label: `Change from ${formatDate(plan.cancels.effectiveFrom)}`,
        before: describeValues(plan.cancels),
        after: "Cancelled",
      },
      {
        label: `Requirement from ${formatDate(plan.restores.version.effectiveFrom)}`,
        before: `Ends ${plan.restores.version.effectiveTo ? formatDate(plan.restores.version.effectiveTo) : "open"}`,
        after: plan.restores.effectiveToAfter
          ? `Runs to ${formatDate(plan.restores.effectiveToAfter)}`
          : "Runs on",
      },
    ],
  };
};

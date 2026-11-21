import type { z } from "zod";

import { isManagerRole, type ManagerRole } from "@/lib/roles";
import type { MutationContext, MutationSpec } from "@/server/identity/mutate";

/**
 * The capability registry's types (slice 2.1, Lira groundwork; docs/LIRA.md).
 *
 * A capability is one thing the product can do for a signed-in person, described so that a
 * screen, a test or, later, the ops agent can find it by a stable name. Registering one changes
 * nothing about how it runs: the Server Action still authorises, validates and writes through
 * `mutate()`, with the user's own client, under RLS.
 *
 * Rules every entry follows:
 * - `name` is stable once shipped (`clients.create`): the agent's tools and the audit trail of
 *   its suggestions refer to it. Rename only with a migration note in docs/LIRA.md.
 * - `input` is the action's existing Zod schema (the one `mutate()` parses), never a copy.
 * - `roles` are the roles `mutate()` checks, taken from the spec where there is one.
 * - **Preview, then confirm.** A write that changes more than one row (`changes: "many"`) or
 *   touches money (`kind: "money"`) must provide `preview`: a function that says what will change,
 *   without changing it, for the screen's confirm step and the agent's confirmation card. Phase 1
 *   entries that predate this rule have no preview yet; they are marked `agent: false` and say why
 *   in `agentNote`, and the registry test holds that line.
 * - `read` and `preview` do no role check of their own: `roles` is the contract a caller must
 *   enforce. Call them only with the signed-in user's own client (`createServerSupabase()`), after
 *   checking the session's role is in `roles` and parsing the input with `input`; never with the
 *   secret key. The ops agent's dispatcher (docs/LIRA.md stage 1) will be the one place that does
 *   this; the registry test fails if this folder imports the admin client.
 * - `agent: true` only when the ops agent may one day offer it: never sign-in or password flows,
 *   never revealing personal data, never the second approver of a two-person rule, never
 *   releasing payroll or moving money (docs/LIRA.md "Safety rules").
 */

export type CapabilityKind = "read" | "write" | "money";

/** Who calls it: a manager in the active company, a worker in the worker app, or anyone. */
export type CapabilityAudience = "manager" | "worker" | "public";

/** How many rows a write changes. `none` for reads and for actions with no database write. */
export type CapabilityChanges = "none" | "one" | "many";

/** What a write will do, in plain English, before it runs. */
export interface CapabilityPreview {
  /** One sentence, numbers first: "Adds Coastline Logistics with 1 contact and 1 site." */
  summary: string;
  /** The rows that will change. Masked values only; never personal data in clear. */
  changes: { label: string; before?: string; after: string }[];
}

export type PreviewFn<S extends z.ZodType> = (
  ctx: MutationContext & { data: z.output<S> },
) => Promise<CapabilityPreview> | CapabilityPreview;

/** Points at the exported Server Action this capability backs (`src/server/x/actions.ts#name`). */
export interface ActionRef {
  module: string;
  export: string;
}

export interface Capability<S extends z.ZodType = z.ZodType> {
  name: string;
  /** One line of plain English: what it does, for whom. */
  description: string;
  kind: CapabilityKind;
  audience: CapabilityAudience;
  /** Manager roles that may use it. Empty for worker and public capabilities. */
  roles: readonly ManagerRole[];
  /** The Zod schema the action parses, or null when it takes no input or keeps it private. */
  input: S | null;
  changes: CapabilityChanges;
  /** The Server Action behind it, or null for a read with no action (see `read`). */
  action: ActionRef | null;
  /** Required for `changes: "many"` and `kind: "money"` unless `agent` is false. */
  preview?: PreviewFn<S>;
  /** For reads: the function that answers it, with the user's own client. */
  read?: (ctx: Omit<MutationContext, "role" | "userId">, input: z.output<S>) => Promise<unknown>;
  /** Whether the ops agent may ever offer this (see the rules above). */
  agent: boolean;
  /** Why `agent` is false, when it is. */
  agentNote?: string;
}

type SpecLike<S extends z.ZodType> = Pick<MutationSpec<S, unknown>, "schema" | "roles">;

/** The input schema and roles of a `mutate()` spec, so the registry never drifts from it. */
export function fromSpec<S extends z.ZodType>(
  spec: SpecLike<S>,
): { input: S; roles: readonly ManagerRole[] } {
  // Manager specs list manager roles only; anything else is never a manager capability's role.
  return { input: spec.schema, roles: spec.roles.filter(isManagerRole) };
}

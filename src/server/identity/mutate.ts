import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";

import type { SendableAuditChannel } from "@/lib/audit-channel";
import { moduleName, type ModuleId } from "@/lib/modules";
import { createServerSupabase } from "@/lib/supabase/server";
import type { Role } from "@/lib/roles";
import type { Database } from "@/types/db";

import { logAuditEvent, type AuditEvent } from "./audit";
import { getSession } from "./session";

/**
 * The one way server code changes data. Every Server Action that writes goes through
 * `mutate()`:
 *
 * 1. Authorise: a signed-in manager whose role in the active organisation is in `roles`.
 * 2. Validate: parse the raw input with the Zod `schema`.
 * 3. Run: `run()` writes with the user's own Supabase client, so row-level security applies.
 * 4. Audit: every row change is logged by the database's AFTER triggers
 *    (private.audit_row_change) in the same transaction as the write, so a change can never
 *    land without its audit row. `event` adds an app-level entry (for example a reason, or an
 *    action that changes no row) through public.log_audit after `run()` succeeds.
 *
 * A write that touches several rows, or money, belongs in one SQL function called from `run()`
 * (private definer behind a public invoker wrapper), because supabase-js has no transactions.
 */

export type MutationErrorCode = "unauthenticated" | "forbidden" | "invalid" | "failed";

export class MutationError extends Error {
  override name = "MutationError";
  constructor(
    readonly code: MutationErrorCode,
    message: string,
    readonly fieldErrors: Partial<Record<string, string>> = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface MutationContext {
  supabase: SupabaseClient<Database>;
  userId: string;
  organisationId: string;
  /**
   * The caller's role in the organisation. A manager's for `mutate()`; the worker app's crew
   * clock-in (slice 3.6) passes `worker` for a worker-supervisor.
   */
  role: Role;
}

export interface MutationSpec<S extends z.ZodType, R> {
  /** Validates the raw input (usually form fields). */
  schema: S;
  /** Roles in the active organisation that may make this change. */
  roles: readonly Role[];
  /**
   * Audit channel for the rows this change writes (src/lib/audit-channel.ts). Leave out for
   * the manager app (`web`); the people import commit sets `import`.
   */
  channel?: SendableAuditChannel;
  /**
   * The module switch this change belongs to (slice 3.0). `mutate()` refuses it with "This part
   * is switched off" when the company has that module off. A product switch, not a permission:
   * row-level security still governs the Data API whatever the switches say.
   */
  module?: ModuleId;
  /** Makes the change. Scope every query to `organisationId`. */
  run: (args: MutationContext & { data: z.output<S> }) => Promise<R>;
  /** Optional app-level audit entry, written after `run()` succeeds. Not for row changes. */
  event?: (args: {
    result: R;
    data: z.output<S>;
  }) => Omit<AuditEvent, "organisationId"> | null | undefined;
}

/** `mutate()` with the caller's context supplied. Used directly by tests. */
export async function runMutation<S extends z.ZodType, R>(
  ctx: MutationContext,
  spec: MutationSpec<S, R>,
  input: unknown,
): Promise<R> {
  if (!spec.roles.includes(ctx.role)) {
    throw new MutationError("forbidden", "Your role can't make this change.");
  }

  const parsed = spec.schema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "");
      if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
    }
    throw new MutationError("invalid", "Check the highlighted fields.", fieldErrors);
  }
  const data = parsed.data as z.output<S>;

  let result: R;
  try {
    result = await spec.run({ ...ctx, data });
  } catch (error) {
    if (error instanceof MutationError) throw error;
    throw new MutationError("failed", "The change was not saved.", {}, { cause: error });
  }

  const event = spec.event?.({ result, data });
  if (event) {
    await logAuditEvent(ctx.supabase, { ...event, organisationId: ctx.organisationId });
  }
  return result;
}

const MODULE_COLUMNS = {
  shifts: "shifts_enabled",
  people: "people_enabled",
  payroll: "payroll_enabled",
} as const satisfies Record<ModuleId, string>;

/**
 * Refuses a change in a module the organisation has switched off (slice 3.0), read under RLS as
 * the caller. A company row the caller can't read is left to the change itself to refuse.
 */
export async function assertModuleOn(
  supabase: SupabaseClient<Database>,
  organisationId: string,
  module: ModuleId,
): Promise<void> {
  const { data, error } = await supabase
    .from("organisations")
    .select("shifts_enabled, people_enabled, payroll_enabled")
    .eq("id", organisationId)
    .maybeSingle();
  if (error) {
    throw new MutationError("failed", "The change was not saved.", {}, { cause: error });
  }
  if (data && data[MODULE_COLUMNS[module]] === false) {
    throw new MutationError(
      "forbidden",
      `This part is switched off. ${moduleName(module)} is off for your company.`,
    );
  }
}

/** Authorises, validates, runs and audits one change for the signed-in manager. */
export async function mutate<S extends z.ZodType, R>(
  spec: MutationSpec<S, R>,
  input: unknown,
): Promise<R> {
  const session = await getSession();
  if (!session) throw new MutationError("unauthenticated", "Sign in to make changes.");
  if (!session.active) throw new MutationError("forbidden", "Your role can't make this change.");

  const supabase = await createServerSupabase({ channel: spec.channel });
  if (spec.module) {
    await assertModuleOn(supabase, session.active.organisationId, spec.module);
  }
  return runMutation(
    {
      supabase,
      userId: session.user.id,
      organisationId: session.active.organisationId,
      role: session.active.role,
    },
    spec,
    input,
  );
}

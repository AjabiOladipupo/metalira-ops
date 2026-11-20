import "server-only";

import { z } from "zod";

import { modulesProblem, modulesTurnedOff, type Modules } from "@/lib/modules";
import type { ManagerRole } from "@/lib/roles";
import type { Database } from "@/types/db";

import {
  ORG_ASSETS_BUCKET,
  advanceStepSchema,
  businessStepFields,
  checkLogo,
  invoicesStepSchema,
  logoObjectPath,
  modulesSchema,
  planStepSchema,
  requirePayDays,
} from "./company";
import { MutationError, type MutationContext, type MutationSpec } from "./mutate";

/**
 * The company setup and settings changes, as `mutate()` specs. Owner and admin only, here and in
 * the database (organisations_update policy, the plan and setup RPCs, the org-assets bucket
 * policies). Each organisations write is logged by the organisations_audit trigger in the same
 * transaction; the logo upload also writes a `company.logo_uploaded` event, because replacing a
 * logo with one of the same type leaves logo_path unchanged.
 */

export const COMPANY_ROLES = ["owner", "admin"] as const satisfies readonly ManagerRole[];

type OrganisationPatch = Database["public"]["Tables"]["organisations"]["Update"];

/** Updates the active organisation and fails loudly when row-level security lets nothing through. */
async function updateOrganisation(ctx: MutationContext, patch: OrganisationPatch): Promise<void> {
  const { data, error } = await ctx.supabase
    .from("organisations")
    .update(patch)
    .eq("id", ctx.organisationId)
    .select("id");
  if (error) throw new Error(`Could not save the company: ${error.message}`);
  if (!data || data.length === 0) {
    throw new MutationError("forbidden", "Your role can't make this change.");
  }
}

/** Moves the wizard's furthest step forward, never back. */
async function reachStep(ctx: MutationContext, step: number): Promise<void> {
  const { error } = await ctx.supabase
    .from("organisations")
    .update({ setup_step: step })
    .eq("id", ctx.organisationId)
    .lt("setup_step", step);
  if (error) throw new Error(`Could not save setup progress: ${error.message}`);
}

/** `advance=yes` comes from the wizard's Continue button; settings saves leave progress alone. */
const advance = { advance: z.enum(["yes", "no"]).optional() };

const planSchema = planStepSchema.extend(advance);
const businessSchema = businessStepFields.extend(advance).superRefine(requirePayDays);
const invoicesSchema = invoicesStepSchema.extend(advance);

export const savePlanSpec = {
  schema: planSchema,
  roles: COMPANY_ROLES,
  run: async (ctx) => {
    const { error } = await ctx.supabase.rpc("choose_company_plan", {
      p_organisation_id: ctx.organisationId,
      p_plan: ctx.data.plan,
      p_expected_workers: ctx.data.expectedWorkers,
    });
    if (error) throw new Error(`Could not save the plan: ${error.message}`);
    if (ctx.data.advance === "yes") await reachStep(ctx, 2);
  },
} satisfies MutationSpec<typeof planSchema, void>;

export const saveBusinessSpec = {
  schema: businessSchema,
  roles: COMPANY_ROLES,
  run: async (ctx) => {
    const { data } = ctx;
    await updateOrganisation(ctx, {
      // The trading name is the name the app shows (company switcher, emails).
      ...(data.tradingName ? { name: data.tradingName } : {}),
      legal_name: data.legalName,
      trading_name: data.tradingName,
      rc_number: data.rcNumber,
      tin: data.tin,
      industry: data.industry,
      head_office_state: data.headOfficeState,
      address: data.address,
      phone: data.phone,
      // Left out by a services business (no pay fields on its form): the saved days stay.
      ...(data.payCycleStartDay !== undefined
        ? { pay_cycle_start_day: data.payCycleStartDay }
        : {}),
      ...(data.payDay !== undefined ? { pay_day: data.payDay } : {}),
    });
    // What the business does (slice 3.0) goes through its own function: while setup is
    // unfinished, a change of type also sets the module switches to the type's defaults. It runs
    // last, so a save refused above never changes the type or the switches.
    const { error } = await ctx.supabase.rpc("set_company_business_type", {
      p_organisation_id: ctx.organisationId,
      p_business_type: data.businessType,
    });
    if (error) {
      if (error.code === "42501") {
        throw new MutationError("forbidden", "Your role can't make this change.");
      }
      throw new Error(`Could not save the business type: ${error.message}`);
    }
    if (data.advance === "yes") await reachStep(ctx, 3);
  },
} satisfies MutationSpec<typeof businessSchema, void>;

export const saveInvoicesSpec = {
  schema: invoicesSchema,
  roles: COMPANY_ROLES,
  run: async (ctx) => {
    const { data } = ctx;
    await updateOrganisation(ctx, {
      invoice_email: data.invoiceEmail,
      invoice_number_start: data.invoiceNumberStart,
      payment_terms_days: data.paymentTermsDays,
      vat_registered: data.vatRegistered === "yes",
      auto_email_receipts: data.autoEmailReceipts,
    });
    if (data.advance === "yes") await reachStep(ctx, 4);
  },
} satisfies MutationSpec<typeof invoicesSchema, void>;

/** What the company has set up, read as the caller (RLS: members only). */
async function loadSetupState(
  ctx: MutationContext,
): Promise<{ businessType: string; modules: Modules }> {
  const { data, error } = await ctx.supabase
    .from("organisations")
    .select("business_type, shifts_enabled, people_enabled, payroll_enabled")
    .eq("id", ctx.organisationId)
    .maybeSingle();
  if (error) throw new Error(`Could not load the company: ${error.message}`);
  if (!data) throw new MutationError("forbidden", "Your role can't make this change.");
  return {
    businessType: data.business_type,
    modules: {
      shifts: data.shifts_enabled,
      people: data.people_enabled,
      payroll: data.payroll_enabled,
    },
  };
}

/**
 * Clients and contracts (step 4) Continue: clients are saved by their own action; this records
 * progress. A services business has no Employees step (slice 3.0), so for it this finishes setup
 * and returns "ready"; a workforce business moves on to Employees.
 */
export const advanceSetupSpec = {
  schema: advanceStepSchema,
  roles: COMPANY_ROLES,
  run: async (ctx): Promise<"employees" | "ready"> => {
    if (ctx.data.step === "employees") {
      await reachStep(ctx, 6);
      return "ready";
    }
    const { businessType } = await loadSetupState(ctx);
    if (businessType === "services") {
      const { error } = await ctx.supabase.rpc("complete_company_setup", {
        p_organisation_id: ctx.organisationId,
      });
      if (error) throw new Error(`Could not finish setup: ${error.message}`);
      return "ready";
    }
    await reachStep(ctx, 5);
    return "employees";
  },
} satisfies MutationSpec<typeof advanceStepSchema, "employees" | "ready">;

const noInput = z.object({});

/** Employees (step 5) Continue: setup is done and the owner is no longer sent to the wizard. */
export const completeSetupSpec = {
  schema: noInput,
  roles: COMPANY_ROLES,
  run: async (ctx) => {
    const { error } = await ctx.supabase.rpc("complete_company_setup", {
      p_organisation_id: ctx.organisationId,
    });
    if (error) throw new Error(`Could not finish setup: ${error.message}`);
  },
} satisfies MutationSpec<typeof noInput, void>;

export interface ModulesResult {
  organisationId: string;
  changed: boolean;
}

/**
 * Settings > Company > Modules (slice 3.0): the three switches, through set_company_modules
 * (owner or admin, audited as company.modules_changed; the database repeats every check).
 * Turning a part off needs the confirm step (`confirmed=yes`); nothing is deleted either way.
 */
export const setModulesSpec = {
  schema: modulesSchema,
  roles: COMPANY_ROLES,
  run: async (ctx): Promise<ModulesResult> => {
    const next: Modules = {
      shifts: ctx.data.shifts,
      people: ctx.data.people,
      payroll: ctx.data.payroll,
    };
    const problem = modulesProblem(next);
    if (problem) throw new MutationError("invalid", problem);
    const { modules: before } = await loadSetupState(ctx);
    if (modulesTurnedOff(before, next).length > 0 && ctx.data.confirmed !== "yes") {
      throw new MutationError("invalid", "Confirm before turning a part off.");
    }
    const { data, error } = await ctx.supabase.rpc("set_company_modules", {
      p_organisation_id: ctx.organisationId,
      p_shifts_enabled: next.shifts,
      p_people_enabled: next.people,
      p_payroll_enabled: next.payroll,
    });
    if (error) {
      if (error.code === "42501") {
        throw new MutationError("forbidden", "Your role can't make this change.");
      }
      // MLMO1-MLMO3 carry plain-English messages written for the person.
      if (error.code?.startsWith("MLMO")) throw new MutationError("invalid", error.message);
      throw new Error(`Could not save the modules: ${error.message}`);
    }
    const changed =
      typeof data === "object" && data !== null && !Array.isArray(data) && data.changed === true;
    return { organisationId: ctx.organisationId, changed };
  },
} satisfies MutationSpec<typeof modulesSchema, ModulesResult>;

const logoSchema = z.object({
  file: z.instanceof(Uint8Array, { message: "Choose a PNG or SVG file." }),
});

export interface LogoUploadResult {
  organisationId: string;
  path: string;
  contentType: string;
  bytes: number;
}

/**
 * Stores the logo at org-assets/{organisation_id}/logo.{png,svg} with the signed-in user's own
 * client (the bucket policies allow owners and admins of that organisation only), removes a logo
 * of the other type, and points organisations.logo_path at it.
 */
export const uploadLogoSpec = {
  schema: logoSchema,
  roles: COMPANY_ROLES,
  run: async (ctx): Promise<LogoUploadResult> => {
    const check = checkLogo(ctx.data.file);
    if (!check.ok) throw new MutationError("invalid", check.message, { logo: check.message });

    const path = logoObjectPath(ctx.organisationId, check.ext);
    const bucket = ctx.supabase.storage.from(ORG_ASSETS_BUCKET);
    const upload = await bucket.upload(path, ctx.data.file, {
      contentType: check.contentType,
      upsert: true,
      cacheControl: "300",
    });
    if (upload.error) throw new Error(`Could not store the logo: ${upload.error.message}`);

    // Best effort: a stale logo of the other type is unreachable once logo_path moves on.
    await bucket.remove([logoObjectPath(ctx.organisationId, check.ext === "png" ? "svg" : "png")]);

    await updateOrganisation(ctx, { logo_path: path });
    return {
      organisationId: ctx.organisationId,
      path,
      contentType: check.contentType,
      bytes: ctx.data.file.byteLength,
    };
  },
  event: ({ result }) => ({
    action: "company.logo_uploaded",
    entity: "organisations",
    entityId: result.organisationId,
    after: { logo_path: result.path, content_type: result.contentType, bytes: result.bytes },
  }),
} satisfies MutationSpec<typeof logoSchema, LogoUploadResult>;

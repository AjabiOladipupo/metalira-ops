import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { ManagerRole } from "@/lib/roles";
import {
  advanceSetupSpec,
  completeSetupSpec,
  saveBusinessSpec,
  saveInvoicesSpec,
  savePlanSpec,
  setModulesSpec,
  uploadLogoSpec,
} from "@/server/identity/company-mutations";
import { MutationError, runMutation, type MutationContext } from "@/server/identity/mutate";
import type { Database } from "@/types/db";

vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));

const ORG = "a0000000-0000-4000-8000-000000000001";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

/** A Supabase client double that records every call and resolves with `rows`. */
function fakeClient({ rows = [{ id: ORG }] }: { rows?: unknown[] } = {}) {
  const calls: { op: string; args: unknown[] }[] = [];
  const builder: Record<string, unknown> = {};
  for (const op of ["update", "eq", "lt", "select"]) {
    builder[op] = (...args: unknown[]) => {
      calls.push({ op, args });
      return builder;
    };
  }
  builder.then = (resolve: (value: unknown) => void) => resolve({ data: rows, error: null });
  builder.maybeSingle = () => {
    calls.push({ op: "maybeSingle", args: [] });
    return Promise.resolve({ data: rows[0] ?? null, error: null });
  };

  const bucket = {
    upload: vi.fn().mockResolvedValue({ data: { path: "x" }, error: null }),
    remove: vi.fn().mockResolvedValue({ data: [], error: null }),
  };
  const rpc = vi.fn().mockResolvedValue({ data: "ok", error: null });
  const from = vi.fn((table: string) => {
    calls.push({ op: "from", args: [table] });
    return builder;
  });
  const client = { rpc, from, storage: { from: vi.fn(() => bucket) } };
  return { client: client as unknown as SupabaseClient<Database>, calls, rpc, from, bucket };
}

function ctx(role: ManagerRole, client: SupabaseClient<Database>): MutationContext {
  return { supabase: client, userId: "user-1", organisationId: ORG, role };
}

const PLAN = { plan: "workforce", expectedWorkers: "162", advance: "yes" };
const BUSINESS = {
  businessType: "workforce",
  legalName: "Adebayo Facility Services Ltd",
  tradingName: "Adebayo Facility Services",
  rcNumber: "RC 1234567",
  tin: "12345678-0001",
  industry: "security_facility",
  headOfficeState: "Lagos",
  address: "12 Admiralty Way",
  phone: "0800 000 0000",
  payCycleStartDay: "20",
  payDay: "25",
};
const INVOICES = {
  invoiceEmail: "billing@adebayofs.example",
  invoiceNumberStart: "100",
  paymentTermsDays: "14",
  vatRegistered: "no",
};

const SPECS = [
  { name: "plan", spec: savePlanSpec, input: PLAN },
  { name: "business details", spec: saveBusinessSpec, input: BUSINESS },
  { name: "invoices", spec: saveInvoicesSpec, input: INVOICES },
  { name: "clients step", spec: advanceSetupSpec, input: { step: "clients" } },
  { name: "finish setup", spec: completeSetupSpec, input: {} },
  { name: "logo upload", spec: uploadLogoSpec, input: { file: PNG } },
  { name: "modules", spec: setModulesSpec, input: { people: "on", confirmed: "yes" } },
] as const;

const NON_ADMINS: ManagerRole[] = ["hr", "finance", "ops_manager", "line_manager"];

describe("company setup actions refuse every role but owner and admin", () => {
  for (const { name, spec, input } of SPECS) {
    it.each(NON_ADMINS)(`${name}: %s gets forbidden and nothing is written`, async (role) => {
      const fake = fakeClient();
      const error = await runMutation(
        ctx(role, fake.client),
        spec as Parameters<typeof runMutation>[1],
        input,
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MutationError);
      expect(error).toMatchObject({ code: "forbidden" });
      expect(fake.rpc).not.toHaveBeenCalled();
      expect(fake.from).not.toHaveBeenCalled();
      expect(fake.bucket.upload).not.toHaveBeenCalled();
    });
  }
});

describe("company setup actions for an owner", () => {
  it("records the plan through the RPC and moves the wizard on", async () => {
    const fake = fakeClient();
    await runMutation(ctx("owner", fake.client), savePlanSpec, PLAN);
    expect(fake.rpc).toHaveBeenCalledWith("choose_company_plan", {
      p_organisation_id: ORG,
      p_plan: "workforce",
      p_expected_workers: 162,
    });
    expect(fake.calls).toContainEqual({ op: "update", args: [{ setup_step: 2 }] });
    expect(fake.calls).toContainEqual({ op: "lt", args: ["setup_step", 2] });
  });

  it("leaves wizard progress alone when saved from settings", async () => {
    const fake = fakeClient();
    await runMutation(ctx("admin", fake.client), savePlanSpec, { ...PLAN, advance: undefined });
    expect(fake.from).not.toHaveBeenCalled();
  });

  it("saves business details scoped to the active organisation, trading name as the app name", async () => {
    const fake = fakeClient();
    await runMutation(ctx("owner", fake.client), saveBusinessSpec, BUSINESS);
    expect(fake.rpc).toHaveBeenCalledWith("set_company_business_type", {
      p_organisation_id: ORG,
      p_business_type: "workforce",
    });
    expect(fake.calls[0]).toEqual({ op: "from", args: ["organisations"] });
    expect(fake.calls[1]).toEqual({
      op: "update",
      args: [
        {
          name: "Adebayo Facility Services",
          legal_name: "Adebayo Facility Services Ltd",
          trading_name: "Adebayo Facility Services",
          rc_number: "RC 1234567",
          tin: "12345678-0001",
          industry: "security_facility",
          head_office_state: "Lagos",
          address: "12 Admiralty Way",
          phone: "08000000000",
          pay_cycle_start_day: 20,
          pay_day: 25,
        },
      ],
    });
    expect(fake.calls[2]).toEqual({ op: "eq", args: ["id", ORG] });
  });

  it("lets a services business leave out the pay days, keeping the saved ones (slice 3.0)", async () => {
    const fake = fakeClient();
    const rest: Partial<typeof BUSINESS> = { ...BUSINESS };
    delete rest.payCycleStartDay;
    delete rest.payDay;
    await runMutation(ctx("owner", fake.client), saveBusinessSpec, {
      ...rest,
      businessType: "services",
      industry: "digital_services",
    });
    expect(fake.rpc).toHaveBeenCalledWith("set_company_business_type", {
      p_organisation_id: ORG,
      p_business_type: "services",
    });
    const update = fake.calls.find((c) => c.op === "update")?.args[0] as Record<string, unknown>;
    expect(update.industry).toBe("digital_services");
    expect(update).not.toHaveProperty("pay_cycle_start_day");
    expect(update).not.toHaveProperty("pay_day");
  });

  it("requires the pay days from a workforce business", async () => {
    const fake = fakeClient();
    const rest: Partial<typeof BUSINESS> = { ...BUSINESS };
    delete rest.payDay;
    await expect(
      runMutation(ctx("owner", fake.client), saveBusinessSpec, rest),
    ).rejects.toMatchObject({ code: "invalid", fieldErrors: { payDay: expect.any(String) } });
    expect(fake.rpc).not.toHaveBeenCalled();
  });

  it("moves a workforce business from Clients to Employees", async () => {
    const fake = fakeClient({ rows: [{ id: ORG, business_type: "workforce" }] });
    const next = await runMutation(ctx("owner", fake.client), advanceSetupSpec, {
      step: "clients",
    });
    expect(next).toBe("employees");
    expect(fake.calls).toContainEqual({ op: "update", args: [{ setup_step: 5 }] });
    expect(fake.rpc).not.toHaveBeenCalled();
  });

  it("finishes setup from Clients for a services business: no Employees step (slice 3.0)", async () => {
    const fake = fakeClient({ rows: [{ id: ORG, business_type: "services" }] });
    const next = await runMutation(ctx("owner", fake.client), advanceSetupSpec, {
      step: "clients",
    });
    expect(next).toBe("ready");
    expect(fake.rpc).toHaveBeenCalledWith("complete_company_setup", { p_organisation_id: ORG });
    expect(fake.calls).not.toContainEqual({ op: "update", args: [{ setup_step: 5 }] });
  });

  describe("modules (slice 3.0)", () => {
    const ALL_ON = {
      id: ORG,
      business_type: "workforce",
      shifts_enabled: true,
      people_enabled: true,
      payroll_enabled: true,
    };

    it("needs the confirm step to turn a part off, and writes nothing without it", async () => {
      const fake = fakeClient({ rows: [ALL_ON] });
      await expect(
        runMutation(ctx("owner", fake.client), setModulesSpec, { people: "on", payroll: "on" }),
      ).rejects.toMatchObject({ code: "invalid", message: "Confirm before turning a part off." });
      expect(fake.rpc).not.toHaveBeenCalled();
    });

    it("turns Shifts off through set_company_modules once confirmed", async () => {
      const fake = fakeClient({ rows: [ALL_ON] });
      fake.rpc.mockResolvedValueOnce({ data: { changed: true }, error: null });
      const result = await runMutation(ctx("admin", fake.client), setModulesSpec, {
        people: "on",
        payroll: "on",
        confirmed: "yes",
      });
      expect(fake.rpc).toHaveBeenCalledWith("set_company_modules", {
        p_organisation_id: ORG,
        p_shifts_enabled: false,
        p_people_enabled: true,
        p_payroll_enabled: true,
      });
      expect(result).toEqual({ organisationId: ORG, changed: true });
    });

    it("refuses Payroll or Shifts without People before calling the database", async () => {
      for (const input of [
        { payroll: "on", confirmed: "yes" },
        { shifts: "on", confirmed: "yes" },
      ]) {
        const fake = fakeClient({ rows: [ALL_ON] });
        await expect(
          runMutation(ctx("owner", fake.client), setModulesSpec, input),
        ).rejects.toMatchObject({
          code: "invalid",
          message: expect.stringMatching(/needs? People/),
        });
        expect(fake.rpc).not.toHaveBeenCalled();
      }
    });

    it("turns parts on without a confirm step", async () => {
      const fake = fakeClient({
        rows: [{ ...ALL_ON, shifts_enabled: false, people_enabled: false, payroll_enabled: false }],
      });
      await runMutation(ctx("owner", fake.client), setModulesSpec, { people: "on" });
      expect(fake.rpc).toHaveBeenCalledWith("set_company_modules", {
        p_organisation_id: ORG,
        p_shifts_enabled: false,
        p_people_enabled: true,
        p_payroll_enabled: false,
      });
    });
  });

  it("fails as forbidden when row-level security updates no row", async () => {
    const fake = fakeClient({ rows: [] });
    await expect(
      runMutation(ctx("owner", fake.client), saveInvoicesSpec, INVOICES),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("saves invoice settings with a missing checkbox as off", async () => {
    const fake = fakeClient();
    await runMutation(ctx("owner", fake.client), saveInvoicesSpec, INVOICES);
    expect(fake.calls[1]).toEqual({
      op: "update",
      args: [
        {
          invoice_email: "billing@adebayofs.example",
          invoice_number_start: 100,
          payment_terms_days: 14,
          vat_registered: false,
          auto_email_receipts: false,
        },
      ],
    });
  });

  it("finishes setup through the RPC", async () => {
    const fake = fakeClient();
    await runMutation(ctx("owner", fake.client), completeSetupSpec, {});
    expect(fake.rpc).toHaveBeenCalledWith("complete_company_setup", { p_organisation_id: ORG });
  });

  it("uploads a PNG logo to the organisation's folder and logs an audit event", async () => {
    const fake = fakeClient();
    const result = await runMutation(ctx("owner", fake.client), uploadLogoSpec, { file: PNG });
    expect(fake.bucket.upload).toHaveBeenCalledWith(
      `${ORG}/logo.png`,
      PNG,
      expect.objectContaining({ contentType: "image/png", upsert: true }),
    );
    expect(fake.bucket.remove).toHaveBeenCalledWith([`${ORG}/logo.svg`]);
    expect(fake.calls).toContainEqual({ op: "update", args: [{ logo_path: `${ORG}/logo.png` }] });
    expect(result).toEqual({
      organisationId: ORG,
      path: `${ORG}/logo.png`,
      contentType: "image/png",
      bytes: PNG.byteLength,
    });
    expect(fake.rpc).toHaveBeenCalledWith(
      "log_audit",
      expect.objectContaining({
        p_organisation_id: ORG,
        p_action: "company.logo_uploaded",
        p_entity: "organisations",
        p_entity_id: ORG,
      }),
    );
  });

  it("refuses a hostile SVG before anything reaches Storage", async () => {
    const fake = fakeClient();
    const file = new TextEncoder().encode('<svg onload="alert(1)"></svg>');
    await expect(
      runMutation(ctx("owner", fake.client), uploadLogoSpec, { file }),
    ).rejects.toMatchObject({ code: "invalid", fieldErrors: { logo: expect.any(String) } });
    expect(fake.bucket.upload).not.toHaveBeenCalled();
    expect(fake.rpc).not.toHaveBeenCalled();
  });
});

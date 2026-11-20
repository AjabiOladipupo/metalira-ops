import "server-only";

import { cache } from "react";

import { resumeSetupSlug, setupStepHref } from "@/lib/company";
import { isBusinessType, type BusinessType, type Modules } from "@/lib/modules";
import { createServerSupabase } from "@/lib/supabase/server";

import { LOGO_SIGNED_URL_OPTIONS, ORG_ASSETS_BUCKET } from "./company";
import { getPageSession } from "./session";

/** What the setup wizard, company settings and the shell read about the active company. */
export interface Company {
  id: string;
  name: string;
  legalName: string | null;
  tradingName: string | null;
  rcNumber: string | null;
  tin: string | null;
  industry: string | null;
  headOfficeState: string | null;
  address: string | null;
  phone: string | null;
  logoPath: string | null;
  invoiceEmail: string | null;
  invoiceNumberStart: number;
  paymentTermsDays: number;
  vatRegistered: boolean;
  autoEmailReceipts: boolean;
  plan: string;
  expectedWorkers: number | null;
  payCycleStartDay: number;
  payDay: number;
  companyCode: string;
  setupStep: number;
  setupCompletedAt: string | null;
  /** Slice 3.0: what the business does, and which parts of the app it has on. */
  businessType: BusinessType;
  modules: Modules;
}

const COLUMNS =
  "id, name, legal_name, trading_name, rc_number, tin, industry, head_office_state, address, phone, logo_path, invoice_email, invoice_number_start, payment_terms_days, vat_registered, auto_email_receipts, plan, expected_workers, pay_cycle_start_day, pay_day, company_code, setup_step, setup_completed_at, business_type, shifts_enabled, people_enabled, payroll_enabled";

/**
 * An organisation's company details, read under RLS as the signed-in user (so only a member gets
 * a row), or null. Cached per request and organisation. The caller has already resolved the
 * organisation from its own session: a Server Action from getSession, a page from
 * getActiveCompany below.
 */
export const getCompany = cache(async (organisationId: string): Promise<Company | null> => {
  const supabase = await createServerSupabase();
  const { data, error } = await supabase
    .from("organisations")
    .select(COLUMNS)
    .eq("id", organisationId)
    .maybeSingle();
  if (error) throw new Error(`Could not load the company: ${error.message}`);
  if (!data) return null;

  return {
    id: data.id,
    name: data.name,
    legalName: data.legal_name,
    tradingName: data.trading_name,
    rcNumber: data.rc_number,
    tin: data.tin,
    industry: data.industry,
    headOfficeState: data.head_office_state,
    address: data.address,
    phone: data.phone,
    logoPath: data.logo_path,
    invoiceEmail: data.invoice_email,
    invoiceNumberStart: data.invoice_number_start,
    paymentTermsDays: data.payment_terms_days,
    vatRegistered: data.vat_registered,
    autoEmailReceipts: data.auto_email_receipts,
    plan: data.plan,
    expectedWorkers: data.expected_workers,
    payCycleStartDay: data.pay_cycle_start_day,
    payDay: data.pay_day,
    companyCode: data.company_code,
    setupStep: data.setup_step,
    setupCompletedAt: data.setup_completed_at,
    businessType: isBusinessType(data.business_type) ? data.business_type : "workforce",
    modules: {
      shifts: data.shifts_enabled,
      people: data.people_enabled,
      payroll: data.payroll_enabled,
    },
  };
});

/**
 * The active organisation's company details for rendering a page or the shell, or null when
 * signed out or managing no organisation. Cached per request. Reads cookies: call it inside a
 * <Suspense> boundary. Server Actions call getCompany with their verified session instead.
 */
export const getActiveCompany = cache(async (): Promise<Company | null> => {
  const session = await getPageSession();
  if (!session?.active) return null;
  return getCompany(session.active.organisationId);
});

/** Signed URLs for the logo last an hour; the shell asks for a fresh one on each request. */
const LOGO_URL_SECONDS = 60 * 60;

/**
 * A short-lived signed URL for the active company's logo, or null when it has none. Signed as
 * the signed-in user, so the bucket's policies decide: only members of the organisation get one.
 * A failure (for example Storage being down) shows no logo rather than breaking the page.
 * Signed as a download (see LOGO_SIGNED_URL_OPTIONS), so the URL opened directly never renders.
 */
export const getActiveCompanyLogoUrl = cache(async (): Promise<string | null> => {
  const company = await getActiveCompany();
  if (!company?.logoPath) return null;

  const supabase = await createServerSupabase();
  const { data, error } = await supabase.storage
    .from(ORG_ASSETS_BUCKET)
    .createSignedUrl(company.logoPath, LOGO_URL_SECONDS, LOGO_SIGNED_URL_OPTIONS);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
});

/**
 * Where to send the active manager instead of the dashboard: the setup step to resume, for an
 * owner or admin whose company has not finished setup; otherwise null. Points straight at the
 * step, so landing on /app takes one redirect, not two.
 */
export async function pendingSetupHref(): Promise<string | null> {
  const session = await getPageSession();
  const role = session?.active?.role;
  if (role !== "owner" && role !== "admin") return null;
  const company = await getActiveCompany();
  if (!company || company.setupCompletedAt !== null) return null;
  return setupStepHref(resumeSetupSlug(company.setupStep, false, company.businessType));
}

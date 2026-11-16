import "server-only";

import { cache } from "react";

import { resumeSetupSlug, setupStepHref } from "@/lib/company";
import { createServerSupabase } from "@/lib/supabase/server";

import { ORG_ASSETS_BUCKET } from "./company";
import { getSession } from "./session";

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
}

const COLUMNS =
  "id, name, legal_name, trading_name, rc_number, tin, industry, head_office_state, address, phone, logo_path, invoice_email, invoice_number_start, payment_terms_days, vat_registered, auto_email_receipts, plan, expected_workers, pay_cycle_start_day, pay_day, company_code, setup_step, setup_completed_at";

/**
 * The active organisation's company details, read under RLS as the signed-in user, or null when
 * signed out or managing no organisation. Cached per request. Reads cookies: call it inside a
 * <Suspense> boundary, a Server Function or a Route Handler.
 */
export const getActiveCompany = cache(async (): Promise<Company | null> => {
  const session = await getSession();
  if (!session?.active) return null;

  const supabase = await createServerSupabase();
  const { data, error } = await supabase
    .from("organisations")
    .select(COLUMNS)
    .eq("id", session.active.organisationId)
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
  };
});

/** Signed URLs for the logo last an hour; the shell asks for a fresh one on each request. */
const LOGO_URL_SECONDS = 60 * 60;

/**
 * A short-lived signed URL for the active company's logo, or null when it has none. Signed as
 * the signed-in user, so the bucket's policies decide: only members of the organisation get one.
 * A failure (for example Storage being down) shows no logo rather than breaking the page.
 */
export const getActiveCompanyLogoUrl = cache(async (): Promise<string | null> => {
  const company = await getActiveCompany();
  if (!company?.logoPath) return null;

  const supabase = await createServerSupabase();
  const { data, error } = await supabase.storage
    .from(ORG_ASSETS_BUCKET)
    .createSignedUrl(company.logoPath, LOGO_URL_SECONDS);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
});

/**
 * Where to send the active manager instead of the dashboard: the setup step to resume, for an
 * owner or admin whose company has not finished setup; otherwise null. Points straight at the
 * step, so landing on /app takes one redirect, not two.
 */
export async function pendingSetupHref(): Promise<string | null> {
  const session = await getSession();
  const role = session?.active?.role;
  if (role !== "owner" && role !== "admin") return null;
  const company = await getActiveCompany();
  if (!company || company.setupCompletedAt !== null) return null;
  return setupStepHref(resumeSetupSlug(company.setupStep, false));
}

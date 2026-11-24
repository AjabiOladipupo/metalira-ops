import "server-only";

import { createHash } from "node:crypto";

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { formatDate, lagosToday } from "@/lib/dates";
import type { InboxMessage } from "@/lib/inbox";
import { PAYROLL_READERS } from "@/lib/pay-access";
import { parsePayslipViews, payslipFileName, type PayslipView } from "@/lib/payroll/payslip-view";
import { runMonth } from "@/lib/payroll/run-format";
import type { ManagerRole } from "@/lib/roles";
import { ORG_ASSETS_BUCKET } from "@/server/identity/company";
import { createAdminSupabase } from "@/server/supabase/admin";
import { AlreadyNotifiedError, notifyWorker } from "@/server/workforce/notify";
import type { Database } from "@/types/db";

import { renderPayslipPdf } from "./payslip-pdf";

/**
 * Payslip PDFs and release notices (slice 5.5; docs/PHASE_5.md decisions 9 and 14, open
 * question 7).
 *
 * - `publishPayslips(org, run)`: after a run is released (5.4's `release_payroll_run`, through
 *   its server hook), make every payslip's PDF that isn't made yet, in chunks, and record each
 *   (`record_payslip_document`, the secret key); then give each worker whose PDF is made one
 *   inbox item, with the short email that notifyWorker sends inside the caps. The notice and
 *   email say the payslip is ready: no amounts, no attachment. Idempotent: run it again and it
 *   makes only what is missing (the database keeps one notice per payslip).
 * - `payslipDownloadLink`: a 60-second signed URL for a payslip's PDF, signed with the secret
 *   key only after `open_payslip_document`, called as the signed-in user, said yes (the worker
 *   their own released payslip; owner, hr and finance any) and audited the download. Nobody
 *   reads the private bucket directly: it has no Storage policy at all.
 *
 * Never logged: PDF bytes, object paths, signed URLs, names or amounts. Logs carry error names
 * and codes only.
 */

type Client = SupabaseClient<Database>;

export const PAYSLIPS_BUCKET = "payslips";
export const PAYSLIP_URL_SECONDS = 60;
/** How many PDFs are made at once. */
const CHUNK = 8;
const PAGE = 1000;

/** Who opens any payslip's PDF on the manager side. */
export const PAYSLIP_READERS = PAYROLL_READERS;
/** Who may finish publishing a released run's payslips (those who release: owner, finance). */
export const PAYSLIP_PUBLISHERS = ["owner", "finance"] as const satisfies readonly ManagerRole[];

export class PublishPayslipsError extends Error {
  override name = "PublishPayslipsError";
  constructor(
    readonly reason: "not_found" | "not_released",
    message: string,
  ) {
    super(message);
  }
}

export interface PublishResult {
  payslips: number;
  /** PDFs made this time. */
  made: number;
  /** PDFs made before. */
  kept: number;
  /** PDFs that failed this time (made on the next try). */
  failed: number;
  /** Inbox items added this time. */
  notified: number;
  /** Of those, how many got the email (the rest were past the caps or have no address). */
  emailed: number;
  /** Notices that failed this time. */
  noticeFailed: number;
}

/** The release notice: no amounts (open question 7), plain text inside the inbox rules. */
export function payslipNotice(month: string, payDate: string): InboxMessage {
  return {
    kind: "payslip",
    title: `Your ${month} payslip is ready`,
    body: `Your payslip for ${month} (pay date ${formatDate(payDate)}) is in the app. Open Payslips to see it and download the PDF.`,
    link: "/m/payslips",
  };
}

/** Object path in the bucket: the database fixes the same one from the row's ids. */
export function payslipObjectPath(
  organisationId: string,
  runId: string,
  payslipId: string,
): string {
  return `${organisationId}/${runId}/${payslipId}.pdf`;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const errorName = (error: unknown) =>
  error instanceof Error
    ? error.name
    : typeof error === "object" && error && "code" in error
      ? `code ${String((error as { code: unknown }).code)}`
      : "unknown error";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The company's logo as PNG bytes, or null (no logo, an SVG logo, or Storage failing). */
async function loadLogoPng(admin: Client, logoPath: string | null): Promise<Uint8Array | null> {
  if (!logoPath || !logoPath.endsWith(".png")) return null;
  try {
    const { data, error } = await admin.storage.from(ORG_ASSETS_BUCKET).download(logoPath);
    if (error || !data) return null;
    const bytes = new Uint8Array(await data.arrayBuffer());
    return PNG.every((b, i) => bytes[i] === b) ? bytes : null;
  } catch {
    return null;
  }
}

async function allRows<T>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: PostgrestError | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(`Could not read payslips (${error.code})`);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return rows;
  }
}

/** Storage's answer when an object is already at the path. */
function isAlreadyThere(error: Error): boolean {
  const fields = error as Error & { statusCode?: unknown; status?: unknown };
  const status = String(fields.statusCode ?? fields.status ?? "");
  return status === "409" || /already exists|duplicate/i.test(error.message);
}

/** Makes, uploads and records one payslip's PDF. Throws on failure (the caller counts it). */
async function makeOne(
  admin: Client,
  organisationId: string,
  view: PayslipView,
  logoPng: Uint8Array | null,
  actorId: string | null,
): Promise<void> {
  const path = payslipObjectPath(organisationId, view.runId, view.payslipId);
  let bytes = await renderPayslipPdf(view, { logoPng, madeOn: lagosToday() });
  // Never overwrite (rule 5): a file already at the path (an upload whose record failed, or a
  // publish running at the same time) is the payslip's PDF, so record that file as it is.
  const upload = await admin.storage.from(PAYSLIPS_BUCKET).upload(path, bytes, {
    contentType: "application/pdf",
    upsert: false,
  });
  if (upload.error) {
    if (!isAlreadyThere(upload.error)) throw new Error(`Upload refused (${upload.error.name})`);
    const existing = await admin.storage.from(PAYSLIPS_BUCKET).download(path);
    if (existing.error || !existing.data) throw new Error("Existing PDF unreadable");
    bytes = new Uint8Array(await existing.data.arrayBuffer());
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const { error } = await admin.rpc("record_payslip_document", {
    p_organisation_id: organisationId,
    p_payslip_id: view.payslipId,
    p_actor: actorId as string,
    p_sha256: sha256,
    p_size_bytes: bytes.length,
  });
  if (error) throw new Error(`Record refused (${error.code})`);
}

/**
 * Publishes a released run's payslips: every PDF not made yet (chunked), then one notice per
 * worker whose PDF is made and who hasn't had one. `actorId` is the person whose release this
 * follows (5.4's released_by), or null for a retry from a job. Call it only with ids from a
 * verified session or the release itself, never from request input.
 */
export async function publishPayslips(
  organisationId: string,
  runId: string,
  options: { actorId?: string | null } = {},
): Promise<PublishResult> {
  const ids = z
    .object({ organisationId: z.uuid(), runId: z.uuid() })
    .parse({ organisationId, runId });
  const actorId = options.actorId ? z.uuid().parse(options.actorId) : null;
  const admin = createAdminSupabase({ channel: "system" });

  const { data: run, error: runError } = await admin
    .from("payroll_runs")
    .select("id, status, period_end, pay_date")
    .eq("organisation_id", ids.organisationId)
    .eq("id", ids.runId)
    .maybeSingle();
  if (runError) throw new Error(`Could not read the run (${runError.code})`);
  if (!run) throw new PublishPayslipsError("not_found", "That payroll run wasn't found.");
  if (run.status !== "released") {
    throw new PublishPayslipsError(
      "not_released",
      "Payslips are published once the run is released.",
    );
  }

  const slips = await allRows<{ id: string; worker_id: string }>((from, to) =>
    admin
      .from("payslips")
      .select("id, worker_id")
      .eq("organisation_id", ids.organisationId)
      .eq("run_id", ids.runId)
      .order("id")
      .range(from, to),
  );
  const documented = new Set(
    (
      await allRows<{ payslip_id: string }>((from, to) =>
        admin
          .from("payslip_documents")
          .select("payslip_id")
          .eq("organisation_id", ids.organisationId)
          .eq("run_id", ids.runId)
          .order("id")
          .range(from, to),
      )
    ).map((d) => d.payslip_id),
  );

  const result: PublishResult = {
    payslips: slips.length,
    made: 0,
    kept: 0,
    failed: 0,
    notified: 0,
    emailed: 0,
    noticeFailed: 0,
  };

  // 1. The PDFs, a chunk at a time.
  const missing = slips.filter((s) => !documented.has(s.id)).map((s) => s.id);
  result.kept = slips.length - missing.length;
  if (missing.length > 0) {
    const { data: org } = await admin
      .from("organisations")
      .select("logo_path")
      .eq("id", ids.organisationId)
      .maybeSingle();
    const logoPng = await loadLogoPng(admin, org?.logo_path ?? null);
    for (const part of chunks(missing, CHUNK)) {
      const { data, error } = await admin.rpc("payslip_pdf_views", {
        p_organisation_id: ids.organisationId,
        p_run_id: ids.runId,
        p_payslip_ids: part,
      });
      if (error) {
        console.error("payroll.payslip_views_failed:", `code ${error.code}`);
        result.failed += part.length;
        continue;
      }
      const views = parsePayslipViews(data);
      const settled = await Promise.allSettled(
        views.map((view) => makeOne(admin, ids.organisationId, view, logoPng, actorId)),
      );
      for (const outcome of settled) {
        if (outcome.status === "fulfilled") {
          result.made += 1;
          continue;
        }
        result.failed += 1;
        console.error("payroll.payslip_pdf_failed:", errorName(outcome.reason));
      }
      result.failed += part.length - views.length;
    }
    // Only PDFs that were recorded count as made.
    const recorded = new Set(
      (
        await allRows<{ payslip_id: string }>((from, to) =>
          admin
            .from("payslip_documents")
            .select("payslip_id")
            .eq("organisation_id", ids.organisationId)
            .eq("run_id", ids.runId)
            .order("id")
            .range(from, to),
        )
      ).map((d) => d.payslip_id),
    );
    documented.clear();
    for (const id of recorded) documented.add(id);
  }

  // 2. The notices: one per payslip whose PDF is made, once (the database refuses a second).
  const notified = new Set<string>();
  for (const part of chunks(
    slips.map((s) => s.id),
    100,
  )) {
    const { data, error } = await admin
      .from("inbox_items")
      .select("payslip_id")
      .eq("organisation_id", ids.organisationId)
      .in("payslip_id", part);
    if (error) throw new Error(`Could not read notices (${error.code})`);
    for (const row of data ?? []) if (row.payslip_id) notified.add(row.payslip_id);
  }
  const message = payslipNotice(runMonth(run.period_end), run.pay_date);
  for (const slip of slips) {
    if (!documented.has(slip.id) || notified.has(slip.id)) continue;
    try {
      const sent = await notifyWorker(ids.organisationId, slip.worker_id, message, {
        payslipId: slip.id,
      });
      result.notified += 1;
      if (sent.email === "sent") result.emailed += 1;
    } catch (error) {
      if (error instanceof AlreadyNotifiedError) continue;
      result.noticeFailed += 1;
      console.error("payroll.payslip_notice_failed:", errorName(error));
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Opening a PDF
// ---------------------------------------------------------------------------

export type PayslipLink =
  { ok: true; url: string } | { ok: false; reason: "not_found" | "not_ready" | "forbidden" };

const openSchema = z.object({
  document_id: z.uuid(),
  storage_path: z.string().regex(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.pdf$/),
  period_end: z.iso.date(),
  pay_date: z.iso.date(),
});

/**
 * A 60-second signed URL for one payslip's PDF. `supabase` is the signed-in user's own client
 * (the worker's, with channel worker_app, or a manager's): `open_payslip_document` decides and
 * audits as them; only then does the secret key sign the URL, as a download named
 * "payslip-october-2026.pdf". Never log the URL.
 */
export async function payslipDownloadLink(
  supabase: Client,
  organisationId: string,
  payslipId: string,
): Promise<PayslipLink> {
  if (!z.uuid().safeParse(payslipId).success) return { ok: false, reason: "not_found" };
  const { data, error } = await supabase.rpc("open_payslip_document", {
    p_organisation_id: organisationId,
    p_payslip_id: payslipId,
  });
  if (error) {
    if (error.code === "MLPD3" || error.code === "MLPD2") return { ok: false, reason: "not_ready" };
    if (error.code === "42501") return { ok: false, reason: "forbidden" };
    if (error.code === "P0002") return { ok: false, reason: "not_found" };
    throw new Error(`Could not open the payslip (${error.code})`);
  }
  const doc = openSchema.parse(data);
  const { data: signed, error: signError } = await createAdminSupabase()
    .storage.from(PAYSLIPS_BUCKET)
    .createSignedUrl(doc.storage_path, PAYSLIP_URL_SECONDS, {
      download: payslipFileName({ month: runMonth(doc.period_end) }),
    });
  if (signError || !signed?.signedUrl) {
    console.error("payroll.payslip_sign_failed:", signError?.name ?? "no url");
    return { ok: false, reason: "not_ready" };
  }
  return { ok: true, url: signed.signedUrl };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The signed-in worker's released payslips, newest first (my_payslips, their own client). */
export async function loadMyPayslips(
  supabase: Client,
  organisationId: string,
): Promise<PayslipView[]> {
  const { data, error } = await supabase.rpc("my_payslips", { p_organisation_id: organisationId });
  if (error) throw new Error(`Could not read payslips (${error.code})`);
  return parsePayslipViews(data);
}

export interface RunPayslipDocument {
  payslipId: string;
  /** The newest PDF's id and when it was made, or null when none is made yet. */
  documentId: string | null;
  madeAt: string | null;
  /** Whether the worker has the release notice; null when the reader can't see inboxes. */
  notified: boolean | null;
}

/**
 * Each payslip of a run with its PDF and notice, for owner, hr and finance (RLS): finance reads
 * no inboxes, so `notified` is null for them.
 */
export async function loadRunPayslipDocuments(
  supabase: Client,
  organisationId: string,
  runId: string,
  payslipIds: readonly string[],
  options: { canSeeNotices: boolean },
): Promise<Map<string, RunPayslipDocument>> {
  const docs = await allRows<{ id: string; payslip_id: string; made_at: string }>((from, to) =>
    supabase
      .from("payslip_documents")
      .select("id, payslip_id, made_at")
      .eq("organisation_id", organisationId)
      .eq("run_id", runId)
      .order("made_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to),
  );
  const notified = new Set<string>();
  if (options.canSeeNotices) {
    for (const part of chunks(payslipIds, 100)) {
      const { data, error } = await supabase
        .from("inbox_items")
        .select("payslip_id")
        .eq("organisation_id", organisationId)
        .in("payslip_id", part);
      if (error) throw new Error(`Could not read notices (${error.code})`);
      for (const row of data ?? []) if (row.payslip_id) notified.add(row.payslip_id);
    }
  }
  const out = new Map<string, RunPayslipDocument>();
  for (const id of payslipIds) {
    const doc = docs.find((d) => d.payslip_id === id) ?? null;
    out.set(id, {
      payslipId: id,
      documentId: doc?.id ?? null,
      madeAt: doc?.made_at ?? null,
      notified: options.canSeeNotices ? notified.has(id) : null,
    });
  }
  return out;
}

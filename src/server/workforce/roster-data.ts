import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { addDays } from "@/lib/dates";
import type { LeaveSpan } from "@/lib/leave/roster";
import {
  buildRosterWeek,
  mondayOf,
  weekEnd,
  type RequiredShift,
  type RosterAssignment,
  type RosterWeek,
} from "@/lib/roster";
import {
  topSuggestion,
  type BookedShift,
  type CandidateWorker,
  type Suggestion,
} from "@/lib/roster-suggestions";
import { loadRequiredShifts } from "@/server/business/activation-data";
import type { Database } from "@/types/db";

import { fromRosterDbError, toCopyWeekResult, type CopyWeekResult } from "./roster";

/**
 * Roster reads (slice 3.2). Every query runs with the signed-in user's own client and is scoped
 * to the active organisation, so RLS decides who sees what: shifts and assignments for owner,
 * admin and ops_manager (line managers and workers see only their part). Personal data stays out:
 * names and staff IDs only.
 */

type Client = SupabaseClient<Database>;

const UUID = /^[0-9a-f-]{36}$/i;
const PAGE = 1000;

/** Reads every page of a query (PostgREST returns at most 1000 rows at a time). */
async function allPages<T>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  what: string,
  cap = 10_000,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < cap; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(`Could not read ${what}: ${error.message}`);
    out.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
  }
  return out;
}

export interface RosterSettings {
  timeZone: string;
  /** standard_shift_minutes × work_days_per_week. */
  weeklyStandardMinutes: number;
}

export async function loadRosterSettings(
  supabase: Client,
  organisationId: string,
): Promise<RosterSettings> {
  const { data, error } = await supabase
    .from("organisations")
    .select("timezone, standard_shift_minutes, work_days_per_week")
    .eq("id", organisationId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the company: ${error.message}`);
  return {
    timeZone: data?.timezone ?? "Africa/Lagos",
    weeklyStandardMinutes: (data?.standard_shift_minutes ?? 480) * (data?.work_days_per_week ?? 5),
  };
}

export interface RosterSite {
  id: string;
  name: string;
  clientName: string;
  archived: boolean;
}

/**
 * Sites with posts to roster: a post open now or closed in the last 60 days (so last weeks stay
 * reachable). By client, then site name.
 */
export async function loadRosterSites(
  supabase: Client,
  organisationId: string,
  today: string,
): Promise<RosterSite[]> {
  const posts = await allPages(
    (from, to) =>
      supabase
        .from("posts")
        .select("site_id, closed_on")
        .eq("organisation_id", organisationId)
        .or(`closed_on.is.null,closed_on.gte.${addDays(today, -60)}`)
        .order("id")
        .range(from, to),
    "posts",
  );
  const siteIds = [...new Set(posts.map((p) => p.site_id))];
  if (siteIds.length === 0) return [];
  const { data: sites, error } = await supabase
    .from("sites")
    .select("id, name, status, client_id")
    .eq("organisation_id", organisationId)
    .in("id", siteIds);
  if (error) throw new Error(`Could not read sites: ${error.message}`);
  // Sites with posts are clients' sites: an office never has posts (slice 6.11, MLHO4).
  const clientIds = [...new Set((sites ?? []).flatMap((s) => (s.client_id ? [s.client_id] : [])))];
  const { data: clients, error: clientError } = clientIds.length
    ? await supabase
        .from("clients")
        .select("id, name")
        .eq("organisation_id", organisationId)
        .in("id", clientIds)
    : { data: [], error: null };
  if (clientError) throw new Error(`Could not read clients: ${clientError.message}`);
  const clientName = new Map((clients ?? []).map((c) => [c.id, c.name] as const));
  return (sites ?? [])
    .map((s) => ({
      id: s.id,
      name: s.name,
      clientName: (s.client_id && clientName.get(s.client_id)) || "",
      archived: s.status === "archived",
    }))
    .sort((a, b) => a.clientName.localeCompare(b.clientName) || a.name.localeCompare(b.name));
}

interface AssignmentRow {
  id: string;
  shift_id: string;
  worker_id: string;
  site_id: string;
  shift_date: string;
  starts_at: string;
  ends_at: string;
}

async function loadAssignments(
  supabase: Client,
  organisationId: string,
  from: string,
  to: string,
  siteId?: string,
): Promise<AssignmentRow[]> {
  return allPages((start, end) => {
    let query = supabase
      .from("shift_assignments")
      .select("id, shift_id, worker_id, site_id, shift_date, starts_at, ends_at")
      .eq("organisation_id", organisationId)
      .eq("status", "assigned")
      .gte("shift_date", from)
      .lte("shift_date", to);
    if (siteId) query = query.eq("site_id", siteId);
    return query.order("id").range(start, end);
  }, "assignments");
}

/** shift id -> post id, for the shifts the assignments point at. */
async function loadShiftPosts(
  supabase: Client,
  organisationId: string,
  shiftIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < shiftIds.length; i += 300) {
    const chunk = shiftIds.slice(i, i + 300);
    const { data, error } = await supabase
      .from("shifts")
      .select("id, post_id")
      .eq("organisation_id", organisationId)
      .in("id", chunk);
    if (error) throw new Error(`Could not read shifts: ${error.message}`);
    for (const row of data ?? []) out.set(row.id, row.post_id);
  }
  return out;
}

async function loadPostNames(
  supabase: Client,
  organisationId: string,
  postIds: readonly string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (let i = 0; i < postIds.length; i += 300) {
    const { data, error } = await supabase
      .from("posts")
      .select("id, name")
      .eq("organisation_id", organisationId)
      .in("id", postIds.slice(i, i + 300));
    if (error) throw new Error(`Could not read posts: ${error.message}`);
    for (const row of data ?? []) out[row.id] = row.name;
  }
  return out;
}

/** A worker approved leave took off a post-day (slice 4.5), for the grid's "On leave" chip. */
export interface OnLeaveChip {
  assignmentId: string;
  workerId: string;
  workerName: string;
  staffId: string;
}

export interface RosterWeekData {
  week: RosterWeek;
  required: RequiredShift[];
  /** `${postId}|${date}` -> the workers approved leave took off that post-day. */
  onLeave: Record<string, OnLeaveChip[]>;
}

/**
 * The assignments at a site that approved leave opened, while the leave stands
 * (public.roster_leave_removals: owner, admin, ops_manager). Other roles get none.
 */
async function loadLeaveRemovals(
  supabase: Client,
  organisationId: string,
  siteId: string,
  from: string,
  to: string,
): Promise<{ assignmentId: string; postId: string; date: string; workerId: string }[]> {
  const { data, error } = await supabase.rpc("roster_leave_removals", {
    p_organisation_id: organisationId,
    p_site_id: siteId,
    p_from: from,
    p_to: to,
  });
  if (error) {
    if (error.code === "42501") return [];
    throw new Error(`Could not read leave on the roster: ${error.message}`);
  }
  return (data ?? []).map((r) => ({
    assignmentId: r.assignment_id,
    postId: r.post_id,
    date: r.shift_date,
    workerId: r.worker_id,
  }));
}

/**
 * Approved and pending leave overlapping two days (public.roster_leave: owner, admin,
 * ops_manager; worker ids and dates only). Other roles get none: their suggestions don't skip
 * leave, and the database refuses an assignment onto approved leave anyway.
 */
export async function loadRosterLeave(
  supabase: Client,
  organisationId: string,
  from: string,
  to: string,
): Promise<LeaveSpan[]> {
  const { data, error } = await supabase.rpc("roster_leave", {
    p_organisation_id: organisationId,
    p_from: from,
    p_to: to,
  });
  if (error) {
    if (error.code === "42501") return [];
    throw new Error(`Could not read leave: ${error.message}`);
  }
  return (data ?? []).map((r) => ({
    workerId: r.worker_id,
    startDate: r.start_date,
    endDate: r.end_date,
    status: r.status === "approved" ? "approved" : "pending",
  }));
}

/** The grid for one site and week: `required_shifts` plus who is assigned. */
export async function loadRosterWeek(
  supabase: Client,
  organisationId: string,
  siteId: string,
  weekStart: string,
  timeZone: string,
): Promise<RosterWeekData> {
  const start = mondayOf(weekStart);
  const end = weekEnd(start);
  if (!UUID.test(siteId)) {
    return {
      week: buildRosterWeek({ weekStart: start, required: [], assignments: [], timeZone }),
      required: [],
      onLeave: {},
    };
  }
  const [requiredAll, rows, removals] = await Promise.all([
    loadRequiredShifts(supabase, organisationId, start, end),
    loadAssignments(supabase, organisationId, start, end, siteId),
    loadLeaveRemovals(supabase, organisationId, siteId, start, end),
  ]);
  const required: RequiredShift[] = requiredAll
    .filter((r) => r.siteId === siteId)
    .map((r) => ({
      postId: r.postId,
      postName: r.postName,
      siteId: r.siteId,
      date: r.date,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      requiredCount: r.requiredCount,
    }));

  const shiftPosts = await loadShiftPosts(supabase, organisationId, [
    ...new Set(rows.map((r) => r.shift_id)),
  ]);
  const workerIds = [...new Set(rows.map((r) => r.worker_id))];
  const nameIds = [...new Set([...workerIds, ...removals.map((r) => r.workerId)])];
  const [workers, mappings] = await Promise.all([
    nameIds.length
      ? supabase
          .from("workers")
          .select("id, staff_id, first_name, last_name")
          .eq("organisation_id", organisationId)
          .in("id", nameIds)
      : Promise.resolve({ data: [], error: null }),
    workerIds.length
      ? supabase
          .from("worker_assignments")
          .select("worker_id, effective_from, effective_to")
          .eq("organisation_id", organisationId)
          .eq("site_id", siteId)
          .in("worker_id", workerIds)
          .lte("effective_from", end)
          .or(`effective_to.is.null,effective_to.gte.${start}`)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (workers.error) throw new Error(`Could not read employees: ${workers.error.message}`);
  if (mappings.error) throw new Error(`Could not read mappings: ${mappings.error.message}`);
  const workerById = new Map((workers.data ?? []).map((w) => [w.id, w] as const));

  const requiredPosts = new Set(required.map((r) => r.postId));
  const missingPosts = [...new Set(shiftPosts.values())].filter((id) => !requiredPosts.has(id));
  const postNames = missingPosts.length
    ? await loadPostNames(supabase, organisationId, missingPosts)
    : {};

  const assignments: RosterAssignment[] = rows.map((r) => {
    const w = workerById.get(r.worker_id);
    const mapped = (mappings.data ?? []).some(
      (m) =>
        m.worker_id === r.worker_id &&
        m.effective_from <= r.shift_date &&
        (m.effective_to === null || m.effective_to >= r.shift_date),
    );
    return {
      id: r.id,
      shiftId: r.shift_id,
      postId: shiftPosts.get(r.shift_id) ?? "",
      date: r.shift_date,
      workerId: r.worker_id,
      workerName: w ? `${w.first_name} ${w.last_name}` : "Employee",
      staffId: w?.staff_id ?? "",
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      mapped,
    };
  });

  const onLeave: Record<string, OnLeaveChip[]> = {};
  for (const r of removals) {
    const key = `${r.postId}|${r.date}`;
    const w = workerById.get(r.workerId);
    const list = onLeave[key] ?? [];
    if (list.some((c) => c.workerId === r.workerId)) continue;
    list.push({
      assignmentId: r.assignmentId,
      workerId: r.workerId,
      workerName: w ? `${w.first_name} ${w.last_name}` : "Employee",
      staffId: w?.staff_id ?? "",
    });
    onLeave[key] = list;
  }

  return {
    week: buildRosterWeek({ weekStart: start, required, assignments, postNames, timeZone }),
    required,
    onLeave,
  };
}

export interface RosterCandidates {
  workers: CandidateWorker[];
  booked: BookedShift[];
  /** Approved and pending leave in the week (slice 4.5), for skipping and marking. */
  leave: LeaveSpan[];
}

/**
 * Everyone who could be rostered in the week (employed on some day of it), with their site
 * mappings, and every assignment they have from the day before the week to the day after (any
 * site), for overlaps and the week's hours, and the leave in the week (slice 4.5). Names and
 * staff IDs only.
 */
export async function loadRosterCandidates(
  supabase: Client,
  organisationId: string,
  weekStart: string,
): Promise<RosterCandidates> {
  const start = mondayOf(weekStart);
  const end = weekEnd(start);
  const [workers, mappings, rows, leave, offices] = await Promise.all([
    allPages(
      (from, to) =>
        supabase
          .from("workers")
          .select("id, staff_id, first_name, last_name, start_date, end_date, status")
          .eq("organisation_id", organisationId)
          .lte("start_date", end)
          .or(`end_date.is.null,end_date.gte.${start}`)
          .order("id")
          .range(from, to),
      "employees",
    ),
    allPages(
      (from, to) =>
        supabase
          .from("worker_assignments")
          .select("worker_id, site_id, effective_from, effective_to")
          .eq("organisation_id", organisationId)
          .not("site_id", "is", null)
          .lte("effective_from", end)
          .or(`effective_to.is.null,effective_to.gte.${start}`)
          .order("id")
          .range(from, to),
      "mappings",
    ),
    loadAssignments(supabase, organisationId, addDays(start, -1), addDays(end, 1)),
    loadRosterLeave(supabase, organisationId, start, end),
    // Slice 6.11: the company's offices. Someone mapped only to an office this week isn't offered
    // for a client's shift (the database refuses it, MLHO6).
    supabase
      .from("sites")
      .select("id")
      .eq("organisation_id", organisationId)
      .eq("kind", "office")
      .limit(200)
      .then(({ data, error }) => {
        if (error) throw new Error(`Could not read offices: ${error.message}`);
        return new Set((data ?? []).map((s) => s.id));
      }),
  ]);

  const shiftPosts = await loadShiftPosts(supabase, organisationId, [
    ...new Set(rows.map((r) => r.shift_id)),
  ]);
  const postNames = await loadPostNames(supabase, organisationId, [
    ...new Set(shiftPosts.values()),
  ]);

  const mappingsByWorker = new Map<string, CandidateWorker["mappings"][number][]>();
  for (const m of mappings) {
    if (!m.site_id) continue;
    const list = mappingsByWorker.get(m.worker_id) ?? [];
    list.push({ siteId: m.site_id, from: m.effective_from, to: m.effective_to });
    mappingsByWorker.set(m.worker_id, list);
  }

  const officeOnly = (workerId: string) => {
    const list = mappingsByWorker.get(workerId) ?? [];
    return list.length > 0 && list.every((m) => offices.has(m.siteId));
  };

  return {
    workers: workers
      .filter((w) => !officeOnly(w.id))
      .map((w) => ({
        id: w.id,
        staffId: w.staff_id,
        firstName: w.first_name,
        lastName: w.last_name,
        startDate: w.start_date,
        endDate: w.end_date,
        ended: w.status === "ended",
        mappings: mappingsByWorker.get(w.id) ?? [],
      }))
      .sort(
        (a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName),
      ),
    booked: rows.map((r) => ({
      workerId: r.worker_id,
      shiftId: r.shift_id,
      postName: postNames[shiftPosts.get(r.shift_id) ?? ""] ?? "another post",
      date: r.shift_date,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
    })),
    leave,
  };
}

export interface TrayCard {
  postId: string;
  postName: string;
  date: string;
  startsAt: string;
  endsAt: string;
  open: number;
  suggestion: Suggestion | null;
}

/** The Uncovered tray: each uncovered post-day with its best suggestion (at most `limit`). */
export function trayCards(
  week: RosterWeek,
  siteId: string,
  candidates: RosterCandidates,
  settings: RosterSettings,
  today: string,
  limit = 40,
): TrayCard[] {
  return week.uncovered
    .filter((u) => u.date >= today)
    .slice(0, limit)
    .map((u) => ({
      ...u,
      suggestion: topSuggestion(
        {
          postId: u.postId,
          siteId,
          date: u.date,
          startsAt: u.startsAt,
          endsAt: u.endsAt,
          weekStart: week.weekStart,
        },
        candidates.workers,
        candidates.booked,
        {
          weeklyStandardMinutes: settings.weeklyStandardMinutes,
          timeZone: settings.timeZone,
          leave: candidates.leave,
        },
      ),
    }));
}

/** "Copy last week" without copying: the same function as the copy, rolled back. */
export async function previewCopyLastWeek(
  supabase: Client,
  organisationId: string,
  siteId: string,
  weekStart: string,
): Promise<CopyWeekResult> {
  const { data, error } = await supabase.rpc("copy_last_week", {
    p_organisation_id: organisationId,
    p_site_id: siteId,
    p_week_start: weekStart,
    p_dry_run: true,
  });
  if (error) fromRosterDbError(error);
  return toCopyWeekResult(data, weekStart);
}

/**
 * The compact roster summary for one week across sites (dashboards and later the ops agent):
 * person-shifts required, covered and open per site. Counts only.
 */
export interface RosterSummary {
  weekStart: string;
  required: number;
  covered: number;
  open: number;
  sites: { siteId: string; siteName: string; required: number; covered: number; open: number }[];
}

export async function loadRosterSummary(
  supabase: Client,
  organisationId: string,
  today: string,
  weekStart?: string,
): Promise<RosterSummary> {
  const start = mondayOf(weekStart ?? today);
  const end = weekEnd(start);
  const [requiredAll, rows, sites] = await Promise.all([
    loadRequiredShifts(supabase, organisationId, start, end),
    loadAssignments(supabase, organisationId, start, end),
    loadRosterSites(supabase, organisationId, today),
  ]);
  const shiftPosts = await loadShiftPosts(supabase, organisationId, [
    ...new Set(rows.map((r) => r.shift_id)),
  ]);
  const siteIds = [...new Set(requiredAll.map((r) => r.siteId))];
  const siteName = new Map(sites.map((s) => [s.id, s.name] as const));
  const perSite = siteIds.map((siteId) => {
    const week = buildRosterWeek({
      weekStart: start,
      timeZone: "Africa/Lagos",
      required: requiredAll
        .filter((r) => r.siteId === siteId)
        .map((r) => ({
          postId: r.postId,
          postName: r.postName,
          siteId: r.siteId,
          date: r.date,
          startsAt: r.startsAt,
          endsAt: r.endsAt,
          requiredCount: r.requiredCount,
        })),
      assignments: rows
        .filter((r) => r.site_id === siteId)
        .map((r) => ({
          id: r.id,
          shiftId: r.shift_id,
          postId: shiftPosts.get(r.shift_id) ?? "",
          date: r.shift_date,
          workerId: r.worker_id,
          workerName: "",
          staffId: "",
          startsAt: r.starts_at,
          endsAt: r.ends_at,
          mapped: true,
        })),
    });
    return { siteId, siteName: siteName.get(siteId) ?? "", ...week.totals };
  });
  perSite.sort((a, b) => b.open - a.open || a.siteName.localeCompare(b.siteName));
  return {
    weekStart: start,
    required: perSite.reduce((s, x) => s + x.required, 0),
    covered: perSite.reduce((s, x) => s + x.covered, 0),
    open: perSite.reduce((s, x) => s + x.open, 0),
    sites: perSite,
  };
}

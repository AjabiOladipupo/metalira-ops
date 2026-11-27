import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/types/db";

import type { ImportContextInput } from "../import/types";
import { loadRetiredStaffIds } from "../staff-id-corrections";

type Client = SupabaseClient<Database>;

const PAGE = 1000;

/** Every row of a query, a page at a time (PostgREST caps one read at 1000 rows). */
async function readAll<T>(
  label: string,
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(`Could not read ${label}: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return rows;
  }
}

/**
 * What the import validator needs to know about the organisation, read with the signed-in
 * user's own client (owner or hr see all of it under RLS): existing workers with their department and current site (ended ones
 * too, so their staff IDs are never reused; their phones no longer count as taken), the
 * manager-app users who are not workers (by sign-in email), departments, clients, projects and
 * sites.
 */
export async function loadImportContext(
  supabase: Client,
  organisationId: string,
): Promise<ImportContextInput> {
  const [workers, managers, departments, clients, projects, sites, assignments, retired] =
    await Promise.all([
      readAll("workers", (from, to) =>
        supabase
          .from("workers")
          .select(
            "id, staff_id, first_name, last_name, phone, status, department_id, line_manager_worker_id",
          )
          .eq("organisation_id", organisationId)
          .order("id")
          .range(from, to),
      ),
      supabase.rpc("list_import_managers", { p_organisation_id: organisationId }),
      readAll("departments", (from, to) =>
        supabase
          .from("departments")
          .select("id, name")
          .eq("organisation_id", organisationId)
          .order("id")
          .range(from, to),
      ),
      readAll("clients", (from, to) =>
        supabase
          .from("clients")
          .select("id, name, status")
          .eq("organisation_id", organisationId)
          .order("id")
          .range(from, to),
      ),
      readAll("projects", (from, to) =>
        supabase
          .from("projects")
          .select("id, client_id, name")
          .eq("organisation_id", organisationId)
          .order("id")
          .range(from, to),
      ),
      readAll("sites", (from, to) =>
        supabase
          .from("sites")
          .select("id, client_id, name, status")
          .eq("organisation_id", organisationId)
          .order("id")
          .range(from, to),
      ),
      // Current placements: open assignments with a site.
      readAll("assignments", (from, to) =>
        supabase
          .from("worker_assignments")
          .select("worker_id, client_id, site_id, effective_from")
          .eq("organisation_id", organisationId)
          .is("effective_to", null)
          .not("site_id", "is", null)
          .order("id")
          .range(from, to),
      ),
      loadRetiredStaffIds(supabase, organisationId),
    ]);
  if (managers.error) throw new Error(`Could not read managers: ${managers.error.message}`);

  const staffIdOf = new Map(workers.map((w) => [w.id, w.staff_id]));
  const placement = new Map<
    string,
    { siteId: string | null; clientId: string | null; from: string }
  >();
  for (const a of assignments) {
    const known = placement.get(a.worker_id);
    if (!known || a.effective_from > known.from) {
      placement.set(a.worker_id, {
        siteId: a.site_id,
        clientId: a.client_id,
        from: a.effective_from,
      });
    }
  }
  return {
    existingWorkers: workers.map((w) => ({
      id: w.id,
      staffId: w.staff_id,
      firstName: w.first_name,
      lastName: w.last_name,
      phone: w.status === "active" ? w.phone : null,
      lineManagerStaffId: w.line_manager_worker_id
        ? (staffIdOf.get(w.line_manager_worker_id) ?? null)
        : null,
      departmentId: w.department_id,
      siteId: placement.get(w.id)?.siteId ?? null,
      clientId: placement.get(w.id)?.clientId ?? null,
    })),
    managers: (managers.data ?? []).map((m) => ({
      membershipId: m.membership_id,
      email: m.email,
      name: m.full_name || m.email,
    })),
    departments,
    clients: clients.map((c) => ({ id: c.id, name: c.name, archived: c.status === "archived" })),
    projects: projects.map((p) => ({ id: p.id, clientId: p.client_id, name: p.name })),
    // A row names a client and its site, so only clients' sites match: an office (slice 6.11) is
    // mapped from the People list, never by the import.
    sites: sites.flatMap((s) =>
      s.client_id
        ? [{ id: s.id, clientId: s.client_id, name: s.name, archived: s.status === "archived" }]
        : [],
    ),
    retiredStaffIds: retired,
  };
}

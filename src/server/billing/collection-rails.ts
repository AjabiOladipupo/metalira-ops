import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { canRequestCompanyBank, holdCountdown } from "@/lib/company-bank";
import { formatDateTime } from "@/lib/dates";
import type { ManagerRole } from "@/lib/roles";
import type { Database } from "@/types/db";

import { loadCompanyBankSummary } from "./company-bank";

/**
 * "Where clients pay" on the setup wizard's Invoices step and in company settings. The UI renders
 * whatever this list says (CLAUDE.md: no provider names outside src/lib/payments/ and
 * src/server/billing/).
 *
 * Owner decision, 16 Nov 2026: companies connect only their own bank account. Clients pay by
 * transfer into it and payments are matched from uploaded bank statements. Metalira never holds
 * or moves the money (rule 6). Slice 2.3 connects it: the account in force, masked
 * ("GTBank ••••4410 · ADEBAYO FACILITY SERVICES LTD"), and any request waiting.
 */
export interface CollectionRail {
  id: "bank";
  name: string;
  body: string;
  /** The account in use, masked, or "No account yet". */
  status: string;
  /** True when an account is in use. */
  connected: boolean;
  /** A request waiting for approval or on hold, in words; null when none. */
  waiting: string | null;
  /** Where to add, change or review it; null for roles that can't. */
  action: { href: string; label: string } | null;
}

const BODY =
  "Clients pay by transfer into your business account. Upload statements to match payments.";

export async function loadCollectionRails(
  supabase: SupabaseClient<Database>,
  organisationId: string,
  role: ManagerRole,
  options: { fromSetup?: boolean } = {},
): Promise<CollectionRail[]> {
  const now = new Date();
  const summary = await loadCompanyBankSummary(supabase, organisationId, role, now);
  const open = summary.open;
  let waiting: string | null = null;
  if (open?.status === "pending") {
    waiting = `${open.label} is waiting for approval.`;
  } else if (open?.status === "approved" && open.appliesAfter) {
    const left = holdCountdown(open.appliesAfter, now);
    waiting = `${open.label} takes effect on ${formatDateTime(open.appliesAfter)}${left ? ` (${left.toLowerCase()})` : ""}.`;
  }
  const href = `/app/settings/bank-account${options.fromSetup ? "?from=setup" : ""}`;
  return [
    {
      id: "bank",
      name: "Bank account",
      body: BODY,
      status: summary.current?.label ?? "No account yet",
      connected: summary.current !== null,
      waiting,
      action: canRequestCompanyBank(role)
        ? {
            href,
            label: summary.current || open ? "Manage bank account" : "Add bank account",
          }
        : null,
    },
  ];
}

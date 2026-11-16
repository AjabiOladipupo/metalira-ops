import "server-only";

/**
 * "Where clients pay" on the setup wizard's Invoices step and in company settings. The UI renders
 * whatever this list says (CLAUDE.md: no provider names outside src/lib/payments/ and
 * src/server/billing/).
 *
 * Owner decision, 16 Nov 2026: companies connect only their own bank account. Clients pay by
 * transfer into it and payments are matched from uploaded bank statements. Metalira never holds
 * or moves the money (rule 6). Connecting the account arrives in Phase 2.
 */
export interface CollectionRail {
  id: "bank";
  name: string;
  body: string;
  status: string;
}

export const COLLECTION_RAILS: readonly CollectionRail[] = [
  {
    id: "bank",
    name: "Bank account",
    body: "Clients pay by transfer into your business account. Upload statements to match payments.",
    status: "Connect in Phase 2",
  },
];

import "server-only";

/**
 * "Where clients pay" on the setup wizard's Invoices step and in company settings. Provider names
 * live here (CLAUDE.md: no provider names outside src/lib/payments/ and src/server/billing/); the
 * UI renders whatever this list says. Connecting either one arrives in Phase 2, so both are
 * placeholders for now. Clients always pay into accounts the company owns.
 */
export interface CollectionRail {
  id: "online" | "bank";
  name: string;
  body: string;
  status: string;
}

export const COLLECTION_RAILS: readonly CollectionRail[] = [
  {
    id: "online",
    name: "Flutterwave",
    body: "Add a pay-online link to every invoice for cards, transfers and USSD.",
    status: "Connect in Phase 2",
  },
  {
    id: "bank",
    name: "Bank account",
    body: "For clients who pay by plain transfer. Upload statements to match payments.",
    status: "Connect in Phase 2",
  },
];

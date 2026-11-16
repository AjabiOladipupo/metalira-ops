/** What the invite Server Actions return to `useActionState`. Types only, safe for the client. */

export interface InviteSheetCard {
  workerId: string;
  name: string;
  staffId: string;
  siteName: string | null;
  url: string;
  qr: string;
}

export type InviteActionState =
  | null
  | { ok: false; status: 400 | 403 | 500; message: string }
  | { ok: true; kind: "email"; message: string }
  | {
      ok: true;
      kind: "print";
      message: string;
      companyName: string;
      companyCode: string;
      /** "21 Nov 2026" */
      expiresOn: string;
      cards: InviteSheetCard[];
    };

/**
 * Copy for the worker app (/m). English only for now (owner decision 16): every worker-facing
 * sentence lives here so other languages can be added later without touching the screens.
 * Sentence case, plain words a site worker reads easily, no emoji or exclamation marks.
 */
export const workerMessages = {
  signIn: {
    title: "Sign in",
    intro: "Use the company code and staff ID on your invite, and your PIN.",
    companyCode: "Company code",
    companyCodePlaceholder: "For example K7PQ2M",
    staffId: "Staff ID",
    staffIdPlaceholder: "For example MO-0114",
    pin: "PIN",
    pinHint: "6 digits.",
    submit: "Sign in",
    pending: "Signing in…",
    forgot: "Forgot your PIN? Ask HR or your supervisor for a new invite.",
    pinSet: "Your PIN is set. Sign in with it now.",
    /** Wrong PIN, or an unknown company code or staff ID: never say which. */
    invalid: "Those details don't match. Check the company code, staff ID and PIN.",
    locked:
      "Too many wrong tries. Sign-in is locked for 15 minutes. Ask HR for a new invite if you've forgotten your PIN.",
    ipBlocked: "Too many tries from this network. Wait 15 minutes and try again.",
    unavailable: "Sign-in isn't working right now. Try again in a minute.",
    notConfigured: "Phone sign-in is not set up on this deployment yet.",
  },
  invite: {
    eyebrow: "Invite",
    title: "Set your PIN",
    confirmName: (name: string, staffId: string) => `Is this you? ${name} · staff ID ${staffId}`,
    company: (company: string) => `${company} uses Metalira Ops for clock-in, leave and payslips.`,
    notYou: "Not you? Don't continue. Tell HR the invite went to the wrong person.",
    pin: "New PIN",
    pinHint: "6 digits you will remember. Not 111111 or 123456.",
    pinConfirm: "Type the PIN again",
    pinMismatch: "The two PINs don't match.",
    noticeTitle: "Before you start",
    notice:
      "Your company uses this app for your shifts, leave and payslips. Your location is used only while you are clocked in, and only after you agree on the clock-in screen. Your bank, NIN and pension details are stored encrypted and shown only to people your company allows.",
    noticeAgree: "I have read this and I am the person named above.",
    noticeRequired: "Tick the box to continue.",
    submit: "Set PIN and sign in",
    pending: "Saving…",
    keep: (companyCode: string, staffId: string) =>
      `Keep these for signing in: company code ${companyCode}, staff ID ${staffId}.`,
    invalid: "This invite link is not valid. Ask HR for a new one.",
    used: "This invite has already been used. Sign in with your PIN, or ask HR for a new invite.",
    revoked: "This invite was replaced by a newer one. Use the latest invite from HR.",
    expired: "This invite has expired. Invites last 7 days. Ask HR for a new one.",
    ended: "This invite is no longer valid.",
    failed: "Your PIN was not saved. Try again in a minute.",
  },
  home: {
    hello: (firstName: string) => `Hello, ${firstName}`,
    soon: "Your shifts, leave and payslips will show here.",
    location: "Your location is used only while you are clocked in.",
    signOut: "Sign out",
    unlinkedTitle: "Almost there",
    unlinked:
      "Your login isn't linked to your staff record yet. Ask HR to send you an invite, then open it on this phone.",
  },
} as const;

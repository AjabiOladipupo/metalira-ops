/**
 * Copy for the worker app (/m). English only for now (owner decision 16): every worker-facing
 * sentence lives here so other languages can be added later without touching the screens.
 * Sentence case, plain words a site worker reads easily, no emoji or exclamation marks.
 */
export const workerMessages = {
  /** Between two facts on one line: "Security guard · MO-0114". */
  separator: " · ",
  /** Parent page names for back arrows, read as "Back to <name>". */
  back: {
    home: "home",
    me: "Me",
    workersPage: "Metalira Ops for workers",
  },
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
      "Too many wrong tries. Sign-in is locked for 15 minutes. Your manager or HR can unlock it sooner, or send a new invite if you've forgotten your PIN.",
    /** The 3rd lockout in 24 hours (owner decision 18). */
    held: "Sign-in is locked after too many wrong tries today. Ask HR for a new invite to set a new PIN.",
    ipBlocked: "Too many tries from this network. Wait 15 minutes and try again.",
    /** The company cap on wrong PINs (owner decision 18). */
    companyThrottled:
      "Too many wrong PINs at your company in the last few minutes. Wait 15 minutes and try again.",
    unavailable: "Sign-in isn't working right now. Try again in a minute.",
    notConfigured: "Phone sign-in is not set up on this deployment yet.",
  },
  invite: {
    eyebrow: "Invite",
    title: "Set your PIN",
    /** Shown as "Is this you? Musa Ibrahim · staff ID MO-0114"; the staff ID never wraps. */
    confirmName: (name: string) => `Is this you? ${name}`,
    confirmStaffId: (staffId: string) => `staff ID ${staffId}`,
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
    goToSignIn: "Go to sign in",
  },
  nav: {
    label: "Worker menu",
    home: "Home",
    clock: "Clock",
    leave: "Leave",
    payslips: "Payslips",
    me: "Me",
  },
  home: {
    hello: (firstName: string) => `Hello, ${firstName}`,
    myProfile: "My profile",
    shiftLabel: "Your shift today",
    noShift: "No shift today",
    noShiftHint: "Your shifts show here once your company publishes a roster.",
    shortcuts: "Shortcuts",
    tiles: {
      shifts: "My shifts",
      leave: "Leave",
      payslips: "Payslips",
      help: "Help",
    },
    location: "Your location is used only while you are clocked in.",
    signOut: "Sign out",
    unlinkedTitle: "Almost there",
    unlinked:
      "Your login isn't linked to your staff record yet. Ask HR to send you an invite, then open it on this phone.",
  },
  /** Clock and My shifts when the company has Shifts switched off (slice 3.0). */
  shiftsOff:
    "Your company doesn't use clock-in or shifts in this app. Ask your supervisor or HR how your hours are recorded.",
  /** Screens whose feature arrives in a later phase. */
  soon: {
    clock: {
      title: "Clock",
      body: "Clock-in opens once your company publishes rosters. Your location is used only while you are clocked in.",
    },
    shifts: {
      title: "My shifts",
      body: "Your shifts show here once your company publishes a roster.",
    },
    leave: {
      title: "Leave",
      body: "Leave requests open soon. Until then, ask your supervisor or HR.",
    },
    payslips: {
      title: "Payslips",
      body: "Your payslips show here after your company runs payroll in Metalira Ops.",
    },
    help: {
      title: "Help",
      body: "For help with this app, your shifts or your pay, ask your supervisor or HR. If you forget your PIN, HR can send you a new invite.",
    },
  },
  me: {
    title: "Me",
    tabs: "Me sections",
    profileTab: "Profile",
    queriesTab: "Queries",
    queriesEmpty: "No queries. When your line manager sends you a query, it shows here.",
    /** "Security guard · MO-0114", or "Staff ID MO-0114" with no job title; the ID never wraps. */
    staffIdOnly: (staffId: string) => `Staff ID ${staffId}`,
    notSet: "Not set",
    work: "Work",
    department: "Department",
    lineManager: "Line manager",
    lineManagerUnnamed: "Set by HR",
    site: "Site",
    project: "Project",
    started: "Started",
    startedValue: (date: string, type: string) => `${date} · ${type}`,
    employmentTypes: {
      permanent: "permanent",
      contract: "contract",
      casual: "casual",
      daily: "daily",
    },
    pay: "Pay and pension",
    bank: "Bank",
    pension: "Pension",
    taxState: "Tax state",
    rent: "Rent declared",
    rentValue: (amount: string) => `${amount} a year`,
    identity: "Identity and contact",
    nin: "NIN",
    /** Owner decision 8: a NIN is on file or missing, never "verified". */
    ninOnFile: "On file",
    ninMissing: "Missing",
    phone: "Phone",
    nextOfKin: "Next of kin",
    requests: "Your requests",
    noRequests:
      "No requests yet. If something here is wrong, request a change and HR will check it.",
    requestChange: "Request a change",
    bankNote:
      "Bank changes need HR approval and wait 72 hours before your pay goes to the new account.",
    signOut: "Sign out",
    bankRequest: (bank: string, masked: string) => `Bank change to ${bank} ${masked}`,
    bankStatus: {
      pending: "Waiting for approval",
      approved: (when: string) => `Approved. Your pay goes there from ${when}`,
      applied: "Done",
      rejected: "Not approved. Ask HR why",
      cancelled: "Withdrawn",
    },
    requestStatus: {
      open: "Waiting for HR",
      done: "Done",
      declined: "Declined",
    },
    hrNote: (note: string) => `HR: ${note}`,
    sentOn: (date: string) => `Sent ${date}`,
  },
  change: {
    title: "Request a change",
    intro: "Tell HR what is wrong or out of date. HR checks it and updates your record.",
    topic: "What do you want to change?",
    topicRequired: "Choose what you want to change.",
    topics: {
      bank: "Bank details",
      name: "My name",
      phone: "Phone number",
      email: "Email address",
      next_of_kin: "Next of kin",
      nin: "NIN",
      tax_pension: "Tax or pension",
      work: "Work details (department, site, line manager)",
      other: "Something else",
    },
    details: "What should change?",
    detailsHint:
      "Write it in your own words. Don't type your NIN, account, pension or phone numbers here. HR will ask you for them.",
    detailsRequired: "Tell HR what should change.",
    detailsShort: "Write a few more words so HR knows what to change.",
    detailsLong: "Keep it to 500 characters or fewer.",
    detailsNumbers:
      "Leave out long numbers such as your NIN, account, pension or phone number. HR will ask you for them.",
    plainText: "Use plain text, without < or >.",
    submit: "Send to HR",
    pending: "Sending…",
    sent: "Sent to HR. You can follow it under Your requests on your profile.",
    tooMany:
      "You already have 5 requests waiting for HR. Wait for HR to deal with them, then try again.",
    bankName: "Bank name",
    bankNameHint: "For example GTBank.",
    bankNameRequired: "Enter the bank name.",
    accountName: "Account name",
    accountNameHint: "The name on the account.",
    accountNameRequired: "Enter the name on the account.",
    accountNameNoLinks: "Enter the name only, without a web address.",
    accountNumber: "Account number",
    accountNumberHint: "10 digits.",
    accountNumberInvalid: "Bank account numbers are 10 digits.",
    bankRequired: "Choose your bank from the list.",
    checkFirst: "Wait for the bank to show the name on the account.",
    checkAgain: "Check the account again: the bank check has expired or the details changed.",
    testLookup: "Test lookups can't be used for real bank details.",
    reason: "Reason (optional)",
    reasonHint: "For example: I moved to a new bank.",
    tooLong: (max: number) => `Keep it to ${max} characters or fewer.`,
    bankSubmit: "Send for approval",
    bankSent:
      "Sent for approval. Once HR approves it, your pay goes to the new account 72 hours later.",
    bankWaiting:
      "You already have a bank change waiting. HR must approve or reject it before you send another.",
    bankTooOften: (max: number) =>
      `You have sent ${max} bank changes in the last 24 hours. Try again tomorrow, or ask HR.`,
    left: "You have left this company, so you can't request changes.",
    failed: "That was not sent. Try again in a minute.",
    back: "Back to my profile",
  },
} as const;

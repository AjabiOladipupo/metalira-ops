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
    inbox: "Inbox",
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
  /** Offline banner, offline page, install card and update prompt (slice 3.4). */
  offline: {
    /** The black banner, per the WkHome and WkClock boards. */
    banner: "No network. Saved on phone, will send when network returns.",
    saved: (count: number) =>
      count === 1 ? "1 punch saved on phone" : `${count} punches saved on phone`,
    sending: (count: number) =>
      count === 1 ? "Sending 1 punch saved on phone." : `Sending ${count} punches saved on phone.`,
    storageLow:
      "Phone storage is nearly full. Free up some space so new punches can be saved on the phone.",
    pageTitle: "No network",
    pageBody:
      "This screen needs the internet. Anything you saved on the phone stays here and sends when the network returns.",
    retry: "Try again",
    home: "Go to home",
    updateReady: "New version ready.",
    updateReload: "Tap to reload",
    installTitle: "Add to home screen",
    installBody: "Open Metalira Ops like any other app, even with weak network.",
    installButton: "Add to home screen",
    installIos: "In Safari, tap Share, then Add to Home Screen.",
    installDismiss: "Not now",
    signOutTitle: (count: number) =>
      count === 1 ? "1 punch is not sent yet" : `${count} punches are not sent yet`,
    signOutBody:
      "They are saved only on this phone. If you sign out now they will be deleted and your company will not get them. Stay signed in until you have network, then try again.",
    signOutStay: "Stay signed in",
    signOutAnyway: "Sign out and delete them",
    signOutOffline:
      "You have no network, so you can't sign out right now. Try again when you have network.",
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
  /** My shifts and the home card (slice 3.3): published shifts only. */
  shifts: {
    title: "My shifts",
    upcoming: "Next 14 days",
    earlier: "Last 7 days",
    today: "Today",
    tomorrow: "Tomorrow",
    empty:
      "No shifts in the next 14 days. Your shifts show here once your company publishes a roster.",
    earlierEmpty: "No shifts in the last 7 days.",
    /** "Gate A · Day at Apapa Warehouse 3". */
    where: (post: string, site: string) => `${post} at ${site}`,
    /** The home card's second line. */
    homeWhere: (post: string, site: string) => `${post} · ${site}`,
    alsoToday: (n: number) => `And ${n} more today`,
    allShifts: "All my shifts",
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
  /** Location and selfie consent (slice 3.1). The notices themselves are in ./consent.ts. */
  consent: {
    title: "Location and selfie",
    meLink: "Location and selfie",
    meLinkHint: "What the app collects when you clock in, and your choices.",
    intro:
      "Clocking in on your phone uses your location and a selfie. You choose whether to agree to each. You can change your mind here at any time.",
    declineNote:
      "If you don't agree, your supervisor clocks you in and out instead. Nothing else changes.",
    agree: "I agree",
    agreePending: "Saving…",
    withdraw: "Withdraw",
    withdrawPending: "Withdrawing…",
    agreedOn: (date: string) => `You agreed on ${date}`,
    notAgreed: "You have not agreed",
    withdrawnOn: (date: string) => `You withdrew on ${date}`,
    agreed: "Saved. You agreed.",
    withdrawnDone: "Withdrawn. Your supervisor clocks you in from now on.",
    left: "You have left this company, so you can't agree to this.",
    failed: "That was not saved. Try again in a minute.",
  },
  /** The worker inbox (slice 3.1). */
  inbox: {
    title: "Inbox",
    open: "Inbox",
    openUnread: (count: number) => `Inbox, ${count} unread`,
    empty: "No messages yet. When your company sends you something, it shows here.",
    unread: "New",
    markRead: "Mark as read",
    markAllRead: "Mark all as read",
    marking: "Saving…",
    marked: "Marked as read.",
    openLink: "Open",
    failed: "That didn't work. Try again in a minute.",
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
  /** Clock in and out (slice 3.5), per the WkClock and WkHome boards. */
  clock: {
    titleIn: "Clock in",
    titleOut: "Clock out",
    steps: "Steps",
    stepLocation: "Location",
    stepSelfie: "Selfie",
    stepDone: "Done",
    locating: "Finding your location",
    locatingHint: "This takes up to 20 seconds. Stay outside if you can.",
    distance: (distance: string) => `You are ${distance} from the site`,
    insideLine: (site: string, next: string) => `Inside ${site}. ${next}`,
    nextSelfie: "Next, take a selfie.",
    nextIn: "Tap to clock in.",
    nextOut: "Tap to clock out.",
    insideMapLabel: "You are inside the site area",
    outsideLine: "You can still clock in. Your supervisor will check it. Why are you outside?",
    outsideLineOut: "You can still clock out. Your supervisor will check it. Why are you outside?",
    reasonGroup: "Reason",
    noteLabel: "Tell your supervisor more (optional)",
    sendAnyway: "Send anyway",
    checkAgain: "Check location again",
    takeSelfie: "Take selfie",
    clockInNow: "Clock in",
    clockOutNow: "Clock out",
    noSiteTitle: "No site to check",
    noSiteLine:
      "You have no shift or site right now. You can still clock in. Your supervisor will check it.",
    noGeofenceLine: (site: string) =>
      `${site} has no site area set yet. You can still clock in. Your supervisor will check it.`,
    locationFailedTitle: "We couldn't find your location",
    locationDenied:
      "Location is blocked for this app. Allow location in your phone's settings, then try again.",
    locationTimeout: "Your phone didn't find a location in 20 seconds. Go outside and try again.",
    tryAgain: "Try again",
    sendWithoutLocation: "Send without location",
    selfieHint: "Put your face in the oval. The photo is small and used only to confirm it is you.",
    cameraLabel: "Camera preview",
    capture: "Capture and clock in",
    usePhoto: "Use a photo instead",
    cameraFailed: "The camera didn't open. Use a photo instead.",
    photoFailed: "That photo couldn't be used. Try again.",
    skipSelfie: "Clock in without a selfie",
    saving: "Saving…",
    clockedInAt: (time: string) => `Clocked in at ${time}`,
    clockedOutAt: (time: string) => `Clocked out at ${time}`,
    savedOffline: "Saved on phone. Will send when network returns.",
    sending: "Sending…",
    sent: "Sent to your company.",
    noteOutside: (reason: string | null) =>
      reason
        ? `Sent for review because you were outside the site. Reason: ${reason}.`
        : "Sent for review because you were outside the site.",
    noteInsideSelfie: "Inside the site, selfie taken. Have a good shift.",
    noteInside: "Inside the site. Have a good shift.",
    noteNoSelfie: "Sent without a selfie. Your supervisor will check it.",
    noteOut: "Clocked out. See you next shift.",
    noteNoSite: "Sent for review because there was no site to check.",
    noteNoLocation: "Sent for review because there was no location.",
    backHome: "Back to home",
    consentTitle: "Before you clock in",
    consentLine:
      "Clocking in uses your location. Agree below to clock in on your phone. If you don't agree, your supervisor clocks you in and out.",
    consentDeclined:
      "You haven't agreed to share your location, so your supervisor clocks you in and out. You can agree at any time.",
    shiftsOff: "Clock-in is switched off for your company. Ask your supervisor.",
    left: "You have left this company, so you can't clock in.",
    noQueue:
      "This phone can't save punches (private browsing or storage blocked). Use a normal browser window.",
    failed: "That punch wasn't saved. Try again.",
    refused: "Your company's system didn't accept this punch. Ask your supervisor to clock you in.",
    homeButtonIn: "Clock in",
    homeButtonOut: "Clock out",
    homeClockedInAt: (time: string) => `Clocked in at ${time}`,
    homeShiftHours: (start: string, end: string) => `${start} – ${end}`,
    homeShiftWhere: (post: string, site: string) => `${post} · ${site}`,
  },
  /** Crew clock-in by a supervisor (slice 3.6, SupCrew board). */
  crew: {
    homeCard: "Clock in crew",
    homeCardLine: (count: number) =>
      count === 1 ? "1 person in your crew" : `${count} people in your crew`,
    titleIn: "Clock in crew",
    titleOut: "Clock out crew",
    modes: "Clock in or out",
    modeIn: "Clock in",
    modeOut: "Clock out",
    /** "Floor crew · 07:00–19:00 · Apapa Warehouse 3". */
    subtitle: (post: string, hours: string, site: string) => `${post} · ${hours} · ${site}`,
    sitePicker: "Site",
    presentCount: (count: number, total: number) => `${count} of ${total} present`,
    outCount: (count: number, total: number) => `${count} of ${total} to clock out`,
    selectAll: "Select all",
    clearAll: "Clear all",
    markPresent: (name: string) => `Mark ${name} present`,
    markOut: (name: string) => `Mark ${name} clocked out`,
    noPhone: "No phone",
    clockedInAt: (time: string) => `Clocked in ${time}`,
    clockedOutAt: (time: string) => `Clocked out ${time}`,
    notIn: "Not clocked in",
    shiftHours: (hours: string) => `Shift ${hours}`,
    takePhoto: "Take group photo",
    photoHint: "Take the photo of the ticked crew only.",
    retakePhoto: "Group photo taken",
    photoNoConsent: (count: number) =>
      count === 1
        ? "No group photo: 1 person here hasn't agreed to photos."
        : `No group photo: ${count} people here haven't agreed to photos.`,
    photoFailed: "That photo couldn't be used. Try again, or send without one.",
    submitIn: (count: number) => (count === 1 ? "Mark 1 present" : `Mark ${count} present`),
    submitOut: (count: number) =>
      count === 1 ? "Mark 1 clocked out" : `Mark ${count} clocked out`,
    doneIn: (count: number, time: string) =>
      count === 1 ? `1 clocked in at ${time}` : `${count} clocked in at ${time}`,
    doneOut: (count: number, time: string) =>
      count === 1 ? `1 clocked out at ${time}` : `${count} clocked out at ${time}`,
    bySupervisor: "Each punch is marked by supervisor",
    yourLocation: (distance: string) => `Your location: ${distance} from site`,
    noLocation: "Your location was not shared",
    photoAttached: "Group photo attached",
    noPhoto: "No group photo, so these punches are flagged for review",
    notMarked: (names: string) => `Not marked: ${names}`,
    wholeCrew: "Whole crew marked",
    back: "Back to crew",
    empty: "No one in your crew is on shift at this site now.",
    notOnShift:
      "You aren't on shift at a site now. Crew clock-in opens during your shift, from 2 hours before it starts.",
    notSupervisor:
      "You don't have a crew. Crew clock-in is for supervisors and line managers. Ask HR if this is wrong.",
    shiftsOff: "Clock-in is switched off for your company.",
    left: "You have left this company, so you can't clock in a crew.",
  },
  /** Patrol checkpoint scans (slice 3.8): the page a checkpoint's QR code opens. */
  checkpoint: {
    title: "Checkpoint scan",
    checking: "Checking your sign-in",
    locating: "Finding your location",
    locatingHint: "This takes up to 20 seconds.",
    noCode: "This link has no checkpoint code. Scan the code on the checkpoint again.",
    signedOut: "Sign in to the worker app, then scan the checkpoint code again.",
    signIn: "Sign in",
    notWorker: "Only workers scan checkpoints. Sign in to the worker app on your own phone.",
    failed: "We couldn't check your sign-in. Try scanning again.",
    shiftsOff: "Patrol scans are switched off for your company. Ask your supervisor.",
    left: "You have left this company, so you can't scan checkpoints.",
    consentTitle: "Agree to share your location first",
    consentLine:
      "A scan records where you were. Agree on the Clock screen, then scan the checkpoint again.",
    openClock: "Open Clock",
    offlineNoOwner:
      "No network, and no one has signed in on this phone yet. Scan again when you have network.",
    noQueue:
      "This phone can't save scans (private browsing or storage blocked). Use a normal browser window.",
    locationFailedTitle: "We couldn't find your location",
    locationDenied:
      "Location is blocked for this app. Allow location in your phone's settings, then try again.",
    locationTimeout:
      "Your phone didn't find a location in 20 seconds. Try again, or send it without.",
    tryAgain: "Try again",
    sendWithoutLocation: "Send without location",
    scannedAt: (time: string) => `Scanned at ${time}`,
    where: (checkpoint: string, site: string | null) =>
      site ? `${checkpoint} · ${site}` : checkpoint,
    savedOffline: "Saved on phone. Will send when network returns.",
    savedForLater: "Saved on phone. It sends the next time you open the app with network.",
    sending: "Sending…",
    sent: "Sent to your company.",
    refused: {
      unknown_checkpoint: "This code isn't a checkpoint you can scan. Tell your supervisor.",
      not_on_shift: "You aren't on a shift at this site now, so the scan wasn't recorded.",
      no_consent: "Agree to share your location on the Clock screen, then scan again.",
      shifts_off: "Patrol scans are switched off for your company.",
      left: "You have left this company, so the scan wasn't recorded.",
      invalid: "This scan is more than 24 hours old or wasn't complete, so it wasn't recorded.",
      other: "Your company's system didn't accept this scan. Tell your supervisor.",
    },
    outsideNote: "You were outside the site area. Your supervisor will check it.",
    noLocationNote: "Sent without a location. Your supervisor will check it.",
    nextScan: "Scan the next checkpoint with your phone's camera.",
    backHome: "Back to home",
  },
  /** Queries from the line manager or HR (slice 4.6), per the WkProfile and WkHome boards. */
  queries: {
    title: "Queries",
    empty: "No queries. When your line manager sends you a query, it shows here.",
    /** The card's first line: the date to reply by, before anything else. */
    replyBy: (date: string) => `Reply by ${date}`,
    overdue: (date: string) => `Reply was due ${date}`,
    from: (name: string, date: string) => `From ${name} · ${date}`,
    replied: "Replied",
    closed: (date: string) => `Closed on ${date}`,
    withdrawn: (date: string) => `Withdrawn on ${date}`,
    outcome: "Outcome",
    you: "You",
    replies: "Replies",
    yourReply: "Your reply",
    replyHint: "Stick to facts: dates, times and what happened. No phone or account numbers.",
    addReply: "Add to your reply",
    send: "Send reply",
    sending: "Sending…",
    note: "Your reply goes to your line manager and on your HR file.",
    /** The home banner: "1 query from Kola Adebayo · reply by 2 Nov". */
    homeBanner: (count: number, from: string, date: string) =>
      count === 1
        ? `1 query from ${from} · reply by ${date}`
        : `${count} queries to reply to · first by ${date}`,
    meLink: (count: number) => (count === 1 ? "1 query open" : `${count} queries open`),
    meLinkHint: "Read and reply in Queries.",
  },
  /** Payslips (slice 5.5), per the WkPayslip board: released payslips only. */
  payslips: {
    title: "Payslip",
    empty:
      "No payslips yet. Your payslip shows here on pay day, once your company releases payroll.",
    month: "Month",
    youReceived: (month: string) => `You received · ${month}`,
    earned: "What you earned",
    grossPay: "Gross pay",
    takenOut: "Taken out",
    totalTakenOut: "Total taken out",
    employer: "Your employer also paid",
    yearToDate: "This year so far",
    incomeTax: "Income tax",
    yourPension: "Your pension",
    nhf: "Housing fund (NHF)",
    netPay: "Net pay",
    carried: (amount: string) =>
      `${amount} of deductions didn't fit this month and comes off your next pay.`,
    ruleSet: (name: string) => `Worked out with the payroll rules ${name}.`,
    download: "Download PDF",
    downloading: "Opening…",
    pdfNotReady: "The PDF is being made. Try again in a minute.",
    askHr: "Ask HR",
    askTitle: (month: string) => `Ask HR about your ${month} payslip`,
    askNote: "HR sees your question on your record and gets back to you.",
    question: "Your question",
    questionHint: "Say what looks wrong or what you want to know. No phone or account numbers.",
    send: "Send to HR",
    sending: "Sending…",
    cancel: "Cancel",
  },
} as const;

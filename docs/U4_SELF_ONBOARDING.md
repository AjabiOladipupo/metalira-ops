# Slice U.4: self-onboarding invites

Owner request (25 Nov 2026, for the 20-person pilot from Mon 30 Nov): "Once I input their email and
choose the role they will play, it sends an invite to their email to onboard them. They fill in
their own (mock) details for their role. They can't change their role."

## What exists and what this slice reuses

| Flow | Where | Reused for |
| --- | --- | --- |
| Team invites (managers by email, role fixed) | `identity/team*.ts`, `/join/[token]`, `membership_invites` | Token pattern (256-bit, SHA-256 stored, 7 days, resend = new token), account creation through an email link (`signInWithOtp` to the invited address only), `chooseOwnPassword` / `invitePasswordStepFor`, `emailLinkAllowed` caps, the join page layout |
| Worker invites (link or QR + PIN) | `identity/worker-invites.ts`, `/m/invite/[token]` | After approval a worker gets the normal worker invite by email (`createInvitesSpec` + `emailInvites`) and sets their PIN there. No second PIN flow. |
| Worker creation | `people/workers.ts`, `public.create_worker` | The approval calls `create_worker` (same insert, same triggers, same pay-rate path) and the same field schemas (`nigerianMobileSchema`, `ninSchema`, `rsaPinSchema`, `nubanSchema`, `nairaSchema`, pay amounts) |
| Bank-detail change (rule 10) | `bank_detail_changes` | Self-entered bank details become a pending `not_checked` bank-detail change raised by the approver, exactly as the people import does (`private.import_bank_change`). The approver of the onboarding is its requester, so the existing rule stops them approving it; a second person (owner, HR or finance) approves it in People > Approvals, giving the note the database asks for on an unchecked account (MLBLC). `people.bank_details_single_approver` is only the owner's import during setup; it is not used here. |
| Consent | `worker_consents` | The invitee ticks the location and selfie notices (same words and versions, `src/lib/messages/consent.ts`); approval records them with channel `onboarding` and the time they ticked. |
| PII encryption | `server/crypto/pii.ts` | NIN, RSA PIN, NHF number and account number are encrypted on the invite row for that row; approval decrypts and re-encrypts them for the worker (`workers.nin_enc`, `rsa_pin_enc`, the bank change, `payroll_nhf_numbers`). The invite row's personal data is cleared on approval and on cancel. |
| NHF number | `payroll_nhf_numbers` / `private.set_payroll_nhf_number` | Approval saves it through the same function (owner, HR). |
| Email caps | `claim_manager_email` (30 a company, 80 overall a day) | Each invite email claims one (kind `self_onboarding`); past a cap nothing is sent and the screen says so. The form shows "N of 30 emails left today". |
| Personal-number helper | `hasPersonalNumber` / `private.has_personal_number` | Every free-text field (names, address, next of kin, account name) in Zod and in table checks. |

BVN: the app stores no BVN anywhere, so the form doesn't ask for it.

## Roles

| Picked | Becomes | Model |
| --- | --- | --- |
| HR, Finance, Ops manager, Line manager | `memberships.role` hr / finance / ops_manager / line_manager | A manager is a membership (manager app, email + password). If the inviter ticks "Also paid through payroll", the invitee can add employee details and approval also creates a worker record with job title = the role (no worker login: a sign-in can't be both, MLTM2). |
| Supervisor, Guard, Cleaner | a worker with job title Supervisor / Guard / Cleaner | Worker (phone app, company code + staff ID + PIN). A supervisor leads a crew through the existing line-manager mapping. |

Who invites and approves: owner, or HR (none of these roles is owner or admin). Pay rates on
approval: owner and HR only (as today; both approver roles qualify).

## Table

`public.onboarding_invites` (one row per invite; RLS: owner and HR of the company read; no table
writes for signed-in users, only the functions below)

- id, organisation_id, email (lower case), role (check: hr, finance, ops_manager, line_manager,
  supervisor, guard, cleaner), on_payroll, department_id, line_manager_worker_id /
  line_manager_membership_id (the inviter's choice)
- token_hash (SHA-256 hex, unique), expires_at (7 days), status (sent, opened, submitted, approved,
  cancelled), sent_at, opened_at, submitted_at, decided_at, decided_by, created_by, created_at
- submission: user_id (manager), first_name, last_name, phone, date_of_birth, home_address,
  next_of_kin_name / phone, nin_enc / last4, rsa_pin_enc / last4, pfa_name, tax_state, nhf_opt_in,
  nhf_number_enc / last4, annual_rent_declared_kobo, bank_code, bank_name, account_name,
  bank_account_enc / last4, location_consent_at, selfie_consent_at
- result: worker_id, membership_id
- guard trigger (ENABLE ALWAYS): never deleted, never truncated; role, email, company, choices
  fixed after insert. No row audit trigger (it would copy personal data): the functions write
  `onboarding.*` audit rows with ids only, and `public.log_audit` refuses those names from anyone else.

`private.onboarding_attempts` (rate limit keys, hashed, no RLS exposure).
`workers.date_of_birth` and `workers.home_address` are added (nullable) so the self-entered details
survive approval.

## Functions (definer, `search_path ''`, behind public wrappers)

| Function | Who | What |
| --- | --- | --- |
| `create_self_onboarding_invite` | owner/HR, trusted session | Refuses an address that is already a member, a worker login, or has an open invite (MLSO1). Caps: 50 a company a day (MLSO9). Returns the raw token once. |
| `resend_self_onboarding_invite` | owner/HR | New token and 7 more days for a sent/opened invite; the old link stops working. |
| `cancel_self_onboarding_invite` | owner/HR | Cancels a sent/opened/submitted invite and clears its personal data. |
| `self_onboarding_lookup` | secret key | Company name, role, state; marks opened. |
| `submit_self_onboarding` | secret key | Token valid, not expired, status sent/opened; for managers the user's confirmed address equals the invite's and is no worker login. Writes the submission; the role is never read from it. |
| `approve_self_onboarding` | owner/HR, trusted session | Creates the worker (locked job title, inviter's department/line manager, the invitee's own details from the row) and/or membership (locked role); raises the bank change; NHF; consents; clears PII on the invite. |
| `self_onboarding_emails_sent` | owner/HR | Emails sent in 24 hours (company, overall), for "N of 30 left". |
| `onboarding_attempt_allowed` | secret key | Public endpoint limits: 10 submits an hour per token, 30 per address, 120 page views per address. |

Refusal codes MLSO1-MLSO9 (no collisions: `grep MLSO` was empty).

## Routes and screens

- `/app/people/onboarding` (owner, HR): invite form (email, role, department, line manager,
  "also paid through payroll"), "N of 30 emails left today", the list with status sent / opened /
  submitted / approved / cancelled / expired, Resend and Cancel.
- `/app/people/onboarding/[id]`: review. Details masked (NIN, bank, RSA PIN and NHF last 4 only),
  pay rate (owner/HR), start date, employment type, Approve. People gets an "Onboard" button.
- `/onboard/[token]` (public, phone first): company name and role only.
  - Worker roles: one form (confirm your email, name, phone, date of birth, address, next of kin,
    NIN, bank, PFA and RSA PIN, tax state, NHF, rent, consents) then "Sent. HR will review it".
  - Manager roles: "Email me a link" (to the invited address only), back signed in, then name,
    password (when needed), phone and, if on payroll, the optional employee details.

## Security model

- Token: 256 random bits, only its hash stored, single use (submitted ends it), 7 days, resend
  replaces it. Another company's token is just an unknown token.
- Bound to the address: manager accounts come only from an email link to the invited address and the
  database compares the confirmed address; worker forms ask the invitee to type the address and the
  server compares it.
- The role, company, department and line manager come from the invite row inside the database. The
  submission has no role field and any extra field is dropped.
- Nothing is active until owner or HR approves. Bank details wait for a second person.
- Public endpoints are rate-limited by token and by `x-real-ip`. Logs carry error codes only.
- Registry: invite, resend, cancel, approve are `agent: false`.

## Tests

- Unit: per-role form schemas, the role in a submission is ignored, the personal-number check.
- RLS (`tests/rls/self-onboarding.test.ts`): single use and expiry, another company's token, role
  can't change, not active until approved, bank two-person rule, PII encrypted and absent from
  audit_log, HR can't invite admin, isolation registry entry.
- Playwright (`tests/e2e/self-onboarding.spec.ts`): owner invites a guard; the guard opens the link at
  390px and submits; HR approves; the guard shows in People as Guard; a Finance invite creates a
  Finance member. Tokens come from the resend function through the owner's session (CI has no
  Resend key), as the team invite spec does.

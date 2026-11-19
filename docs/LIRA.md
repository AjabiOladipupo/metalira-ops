# Lira: the ops agent

Lira is the in-product ops agent Metalira Ops plans to ship: a manager types "add Coastline Logistics with billing email accounts@coastline.ng" or "which sites have no geofence?" and Lira answers, or prepares the change for them to confirm. The landing page already shows it as "Coming soon". Nothing in the product calls an AI model yet, needs an API key or adds a paid dependency. What every slice builds now is the groundwork that makes Lira safe and cheap to add later (docs/PHASE_2.md "Lira groundwork").

## Goal

A manager at a 50 to 500-person service company gets an answer or a ready-to-confirm change in one message, instead of finding the right screen. Lira never knows more, and never does more, than the person asking could do on the screens themselves.

## Stages

0. **Groundwork (now, every slice).** A capability registry (`src/server/capabilities/registry.ts`) names every action with its schema, roles, kind and whether the agent may ever offer it. Summary reads give compact, masked answers. Multi-row and money writes have preview functions. `audit_log.channel` records where each change came from. Each area has test questions in `fixtures/lira/<area>.md`.
1. **Read-only answers.** Lira answers questions from the registry's `read` capabilities and summary reads ("how many clients need details?"), with links to the screen that shows the full answer. No writes.
2. **Confirmed writes.** Lira proposes a write as a confirmation card (from the capability's preview); nothing changes until the person presses Confirm, which calls the same Server Action the screen uses. Only capabilities marked `agent: true`.
3. **Routines.** Lira suggests recurring checks ("every Monday, list sites with open posts") and drafts end-of-week summaries. Still one confirmation per write.

## Safety rules

- **Runs as the signed-in user.** Every tool call uses the user's own Supabase client, so RLS, column grants and the role checks in `mutate()` apply exactly as on the screens. Lira never uses the secret key.
- **Reads are instant;** they change nothing.
- **Every write is a confirmation card** showing the preview. No write runs without the person's click, and each card confirms one capability.
- **Never the second approver.** Lira never decides a two-person request (bank details, staff ID corrections, owner changes, the company bank account). Those capabilities are `agent: false` in the registry.
- **Never releases payroll or moves money.** Payroll release, payment files and anything of kind `money` stay with people.
- **Money maths only in tested code.** Lira never adds up kobo itself; totals come from the same tested functions the screens use.
- **Masked personal data only.** NIN, BVN, bank account numbers and RSA PINs are shown masked; Lira cannot reveal them (reveal capabilities are `agent: false`) and never takes them as input.
- **Opt-in per company.** An owner turns Lira on in Settings; it is off by default.
- **Audited as `lira`.** Every change Lira confirms writes its audit rows with `channel = 'lira'` (the value is reserved in the database now; the database does not accept it from a request header, so the agent's write path will set it in a way a browser can't).
- **No sign-in, password or access changes.** Inviting, removing or re-roling managers stays with people.

## Audit channel

`audit_log.channel` says which door a change came through: `web` (the manager app, the default), `worker_app`, `import` (committing a people import), `system` (scheduled jobs, the secret key, the database itself) and later `lira`. A `BEFORE INSERT` trigger on `audit_log` (`private.audit_log_set_channel`) sets it on every row, whatever the insert supplied: from a transaction-local setting `metalira.audit_channel` that SQL functions may set, else from the `x-metalira-channel` header the app's server clients send (`src/lib/audit-channel.ts`; only `web`, `worker_app` and `import` are accepted from a header), else `system` when there is no request or the caller is the secret key, else `web`. A signed-in user calling the Data API directly can label their own change `worker_app` or `import`, but never `system` or `lira`, and the actor on the row is always theirs: the channel is a label for reading the log, not a permission.

## Provider-neutral plan

- One interface for "a model that can call tools", behind `src/server/lira/` when stage 1 starts, so the provider can change without touching tools or screens.
- Start with an open-weight model through a pay-as-you-go host. Avoid free tiers that train on the data sent to them: customer data never trains anyone's model.
- Move to a stronger model when the test questions in `fixtures/lira/` show the open model getting them wrong.
- The test questions are the acceptance suite: each stage ships when its model answers them as expected, run in CI against recorded tool results (no live model calls in CI).

## Cost notes (rough, November 2026)

- A premium model for a 500-staff company with a few managers using it daily: roughly $50–150 a month. Open models through a pay-as-you-go host: a small fraction of that.
- Keep prompts short: summary reads and masked fields keep each call small.
- Vercel Pro is needed before any paid pilot (Hobby is non-commercial), as for the product itself (BUILD_PLAN "Running costs").
- The owner has no API budget yet: nothing is built that needs one until that changes.

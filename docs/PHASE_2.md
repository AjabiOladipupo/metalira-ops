# Phase 2: clients and contracts (about 2 weeks)

Goal: a company records who it works for and on what terms. Client, then contacts, then sites with a geofence and QR checkpoints, then a contract, then a dated rate card, then headcount, then documents, then activation. Activation turns the contract's headcount into **posts** and dated **roster requirements**, which Phase 3 rosters against, Phase 4 turns into Work Units and Phase 6 prices from the rate card.

Started 19 Nov 2026, from a `main` with all of Phase 1 merged (signed off 18 Nov). There is no prototype board for clients, sites or contracts. Screens follow the design system and the parts of the boards that show this data:
- `Setup.dc.html` step 4 "Clients and contracts" (client, billing email, site, project, rate such as "₦12,500 day · ₦15,000 night shift · overtime 1.5×"; "Add client").
- `Roster.dc.html`, whose post rows ("Gate A · Day 06:00–18:00", bill ₦12,500, "Required 4 · Scheduled 3") set the shape of posts and roster requirements.
- `Unbilled.dc.html` and `Simulate.dc.html` (client, site and contract lines such as "Lekki Estate Gate B · guarding contract · monthly in arrears", invoices priced "at each contract's rate card").
- `Revenue.dc.html` (site belongs to a client; "the client rate card has not changed since January").
- `Attendance.dc.html` and `People.dc.html` (site pickers, "Apapa Warehouse 3").

Ignore the pay-online and dedicated-account parts of those boards (BUILD_PLAN "Payments model").

Rules that apply to every slice here (as in Phase 1):
- Every new table has `organisation_id uuid not null`, RLS through `private.user_org_ids()` / `private.has_role()` (both use `private.session_uid()`, so an untrusted password session reads and writes nothing; slice 1.13), composite `(organisation_id, id)` foreign keys like 1.3, and an entry in `tests/rls/tables/business.ts` for the isolation registry.
- Every mutation goes through `mutate()` (role check, then Zod, then a write with the user's own client). Multi-row writes are SQL functions running as the caller with `p_organisation_id`. Audit triggers on every table, plus app events through `log_audit` (`contract.activated`, `contract.ended`, `rate_card.version_added`, `checkpoint.qr_rotated`).
- Money is `bigint` kobo plus `currency` (`'NGN'` check). It comes in from forms as a string through `parseNairaToKobo`, and is read back as `::text` and converted with `koboFromText`. Rates are stored without VAT.
- Rate cards and roster requirements are dated versions (`effective_from`, `effective_to`). No overlaps (GiST exclusion on `daterange`, `btree_gist` exists). A version in force or in the past is never updated, except to close `effective_to`. A change is a new version.
- Nothing in this phase is deleted. Clients and sites are archived, contacts are marked removed, checkpoints and posts are retired or closed, and documents are marked removed. The `clients_delete`, `sites_delete` and `projects_delete` policies and grants are dropped in 2.1.
- Files go in a private bucket under `{organisation_id}/...`, are read by signed URL (60 s), and their storage policies are scoped by organisation and role.
- Email only, through `src/server/email/send.ts`. No SMS. Plain-text names that look like web addresses are left out of emails, as in 1.12.
- Code lives in `src/server/business/` (clients, contracts, rate cards, activation) and `src/server/sites/` (sites, geofence, checkpoints). The company bank account lives in `src/server/billing/`, because it replaces `collection-rails.ts`. Each slice has its own timestamped migration. Merge `main` in and regenerate `src/types/db.ts` before the PR.
- Parallel agents: branch dependent slices off the dependency's open PR branch, then merge `main` back in once it lands. Merge main INTO branches; never rebase or force-push.
- Corners are 12px everywhere a person sees an edge (buttons, inputs, selects, form fields, cards); see DESIGN_SYSTEM.md "Shape and spacing". Done in 2.1.

## Lira groundwork (every slice)

Lira is the future in-product ops agent (docs/LIRA.md). Nothing here calls an AI model or needs an API key. Owner approved 19 Nov 2026.

1. **Capability registry.** Every new Server Action is registered in `src/server/capabilities/registry.ts` with a stable name (`clients.create`), a one-line plain-English description, its existing Zod input schema and roles (taken from its `mutate()` spec with `fromSpec`), its kind (`read`, `write`, `money`), how many rows it changes, and whether the agent may ever offer it. 2.1 registers every Phase 1 action too. `tests/unit/capabilities/registry.test.ts` fails when an exported Server Action in any `"use server"` module isn't registered, or a registration points at nothing. No behaviour change.
2. **Summary reads.** Each slice's main read functions also offer a compact summary shape (counts, totals, held-back reasons, masked values only), reused by dashboards. 2.1: `summariseClients` / `loadClientsSummary`.
3. **Preview, then confirm.** Every write that changes more than one row or touches money has a preview function returning what will change (`src/server/capabilities/previews.ts`), used by the screen's confirm step and the agent's confirmation card: activation, rate changes, headcount changes, the bank account. The registry test refuses `agent: true` on such a write without a preview.
4. **Audit channel.** `audit_log.channel` (`web` default, `worker_app`, `import`, `system`, later `lira`), set by the server path (2.1). Append-only rules unchanged.
5. **Test questions.** Each slice adds 5–10 realistic manager requests with expected outcomes to `fixtures/lira/<area>.md`.
6. **docs/LIRA.md** (written in 2.1) and a Lira line in BUILD_PLAN.md "Every phase".

## Roles

| Thing | Read | Write |
| --- | --- | --- |
| Clients, sites, checkpoints (names, address, geofence) | owner, admin, hr, finance, ops_manager, line_manager (keeps the 1.3 read rule); a worker reads the ones they're assigned to | owner, admin, ops_manager. hr keeps **insert only**, because the people import creates name-only clients and sites. Checkpoint QR tokens can be read by owner, admin and ops_manager only |
| Client contacts | owner, admin, finance, ops_manager | owner, admin, finance, ops_manager |
| Company bank account | full number: owner, finance (decision 7 pattern, `pii.reveal` audited); last 4 digits: every manager | request: owner, admin, finance. Approve: owner or finance, never the requester (the first account during setup excepted, below) |
| Contracts, contract sites, headcount, documents | owner, admin, finance, ops_manager | owner, admin, ops_manager |
| Client tax settings (`clients.deducts_wht`, `clients.withholds_vat`) | owner, admin, finance, ops_manager (through `client_billing`) | owner, admin, finance, through `set_client_tax_settings` (audited with a reason) |
| Rate cards and lines | owner, admin, finance, ops_manager | owner, admin, ops_manager, through SQL functions only |
| Posts, roster requirements | owner, admin, hr, finance, ops_manager, line_manager | none directly. Only `activate_contract`, `change_post_requirement`, `add_post`, `close_post` and `end_contract` write them (owner, admin, ops_manager) |

Nav: **Clients** (`/app/clients`, icon `clients`, group Business, above Projects) for owner, admin, ops_manager and finance. `EXTRA_PAGES` keeps the pages that write open only to their write roles.

## Slices (one pull request each)

### 2.1 Clients and contacts, Lira groundwork, 12px corners
- Migration `20261119100000_clients_contacts.sql`: extends `clients` (1.3) with `legal_name`, `rc_number`, `tin`, `billing_address`, `state`, `billing_terms_days` (null means the organisation's `payment_terms_days`, 0–180), `status` (active, archived) and `notes`, with the same plain-text checks as `name` (RC number and TIN in the organisations formats).
- New `client_contacts`: client_id, name, email, phone null, role (billing, approver, ops), is_primary, status (active, removed). One primary per client and role (partial unique index), kept by triggers: a new primary demotes the old one, the first active contact of a role becomes primary, removing the primary promotes the next. Email lower-cased and format-checked; one active address per client and role. A contact never moves client or changes role.
- Billing columns and notes are not granted on `clients` (hr, line managers and assigned workers keep reading the row's name and status); `public.client_billing(org, client?)` returns them to owner, admin, finance and ops_manager. hr may insert name-only clients and nothing else.
- `public.create_client`: a client with its first billing contact and first site in one transaction, as the caller (Add client and Setup step 4).
- RLS per the roles table; the delete policies and grants on clients, sites and projects dropped.
- `audit_log.channel` (Lira groundwork 4).
- Routes: `/app/clients` lists clients with sites, active contracts (0 until 2.4) and status, with search. Clients without a billing address or billing contact (every name-only row the import created) show "Needs details". The empty state uses the `no-clients` slot (160) with "No clients yet. Add the first company you work for." and an Add client action. `/app/clients/new` (details and a billing contact), `/app/clients/[clientId]/edit`, and `/app/clients/[clientId]` with the tabs Overview · Sites · Contracts · Contacts. Sites and Contracts are simple lists until 2.2 and 2.4 fill them.
- Setup step 4 is a quick add matching the board: a client, its billing email (saved as the primary billing contact) and a first site name, listed in the board's table. The Rate column shows "Add a contract" until 2.4. `continueFromClients` stays.
- Corner radius 12px (globals.css, button, input, select, dropdown, form fields; DESIGN_SYSTEM.md).
- Lira groundwork 1–6, with every Phase 1 action registered.
- Tests: unit (schemas, summary, registry completeness, nav), RLS (every policy change, hr inserts but can't update a client, the contact triggers, the audit channel), isolation, Playwright (add a client with two contacts at 390 and 1440, Setup step 4).

**Accept:** ops_manager adds a client with two contacts at 390px and 1440px; finance can see the client but can't edit it; a client the import created shows "Needs details" and can be finished; every save writes an audit row with its channel.

### 2.2 Sites: geofence and QR checkpoints
- Migration `<ts>_sites_geofence.sql`: extends `sites` with `address`, `state`, `landmark`, `centre geography(Point,4326)`, `radius_m` (25–2000, default 100), `boundary geography(Polygon,4326)` (null; an optional drawn outline), `geofence geography(Polygon,4326)`, `geofence_set_at`, `geofence_set_by` and `status` (active, archived).
  - A trigger keeps `geofence = coalesce(boundary, ST_Buffer(centre, radius_m))`.
  - Checks: `ST_IsValid`, 200 vertices or fewer, area 4 km² or less, and a point inside Nigeria's bounding box. There is a GiST index on `geofence`.
  - A site's client never changes after it has a contract or an assignment.
- New `site_checkpoints`: site_id, name, `qr_token` (32 random bytes, hex, unique, made by the database), `location geography(Point)` (null), sort_order, status (active, retired), retired_at. Retired, never deleted, because Phase 3 patrol scans point at them. `rotate_checkpoint_qr` swaps the token, so the old printout stops working (audited, token never logged). Column grants keep `qr_token` away from anyone who isn't owner, admin or ops_manager.
- SQL helper for Phase 3: `private.site_geofence_check(site_id, point geography, accuracy_m int) returns text` gives `inside`, `near` or `outside`. It uses `ST_Covers` and then `ST_DWithin(point, geofence, accuracy_m)`. Phase 3 decides how much tolerance to allow; this only reports.
- Route `/app/clients/[clientId]/sites/[siteId]` covers address, the geofence editor and checkpoints. The geofence editor is a **Leaflet** map with **MapTiler** tiles (one key in `NEXT_PUBLIC_MAPTILER_KEY`, restricted to ops.metaliratech.com, *.vercel.app and localhost; the owner has added it in Vercel): drop a pin and set a radius, or draw an outline. "Use my location" sets it while standing at the site on a phone. The editor stays inside one client component.
- Route `/app/clients/[clientId]/sites/[siteId]/checkpoints/print` is a print page with one QR code and name per checkpoint, built with the existing `qrcode` package the way the worker invite sheet is. The QR encodes `/m/checkpoint/<token>`; the scan page comes in Phase 3.
- Sites without a geofence show "No geofence" on the client's Sites tab, and a count shows on `/app/clients` (add it to `summariseClients`).
- Register the new actions; add `fixtures/lira/sites.md`.
- Tests:
  - Unit: the radius and polygon Zod checks.
  - Database (Vitest against the local stack): circle to polygon; inside, near and outside points; an invalid polygon refused; QR rotation.
  - RLS: line_manager reads sites but not `qr_token`; a worker reads only their assigned site.

**Accept:** a site gets a 100 m geofence from a pin on a phone and a drawn outline on desktop; three checkpoints print as QR codes; rotating a code changes it; Apapa Warehouse 3 (from the import) gets its geofence added.

### 2.3 Company bank account (parallel with 2.1)
Replaces the "Connect in Phase 2" placeholder on Setup step 3 and in Settings (DATA_MODEL: Phase 2).
- Migration `<ts>_organisation_bank_accounts.sql` creates `organisation_bank_accounts` with these columns: bank_name, account_name, bank_account_enc (bytea, sealed with `sealPii`), bank_account_last4, is_default, status (pending, active, retired, rejected), requested_by, approved_by, decided_at, applies_after, retired_at.
  - The rule `approved_by <> requested_by` is enforced by a check constraint and a trigger, following the 1.7 pattern.
  - **72-hour hold**: an approved change applies `applies_after = decided_at + 72 hours`, as for worker bank changes; the old account stays in force until then.
  - **First account during setup**: the company's first account, added by the owner while setup is not complete, is active at once with one approver, audited (`billing.bank_account_single_approver`), like the first import (decision 20).
  - One default active account per organisation (partial unique index).
  - Rows are never edited. A change is a new pending row, and approving it retires the old one when `applies_after` passes (pg_cron, as in 1.7).
- Rows are written by the SQL functions `request_org_bank_account`, `decide_org_bank_account` and `withdraw_org_bank_account`. On approval, the server decrypts the account number and refuses it if the last 4 digits don't match (1.7 lesson).
- Emails: approvers (owner, finance) get one when a request is raised. Every owner and finance user gets one when it is approved and when it applies.
- `COLLECTION_RAILS` reads the active account: "GTBank ••••4410 · ADEBAYO FACILITY SERVICES LTD". Settings > Company gets a "Where clients pay" card with request, approve and history. Invoices (Phase 6) read the account as of the issue date through `org_bank_account_as_of(org, at)`.
- Preview for the request and decision (Lira groundwork 3); register the actions as `money`, `agent: false` for the decision.
- Tests: unit tests for the masking and last-4 check; RLS for the requester-cannot-approve rule, raised by the database, and the hold; e2e for owner requests, finance approves, and the masked account showing on Setup step 3.

**Accept:** an account requested by the owner stays pending until a finance user approves it, then applies after 72 hours and shows masked in setup and settings; a requester approving their own request is refused by the database; security-reviewer has no high findings.

### 2.3b Bank picker and account name check (owner request, 19 Nov 2026)
Wherever bank details are entered (the company account; Add employee; Change bank details; the worker app's bank change), the bank is picked from a searchable list with its bank code (`src/lib/banks.ts`, codes from Monnify's Supported Banks page) and the person types only the 10-digit number. The server asks the bank network for the account name with Metalira's own provider account (Monnify "Validate Bank Account", free per its docs; `src/lib/payments/`, called only from `src/server/billing/bank-lookup.ts`) and shows it read-only.
- Migration `20261119115000_bank_account_lookup.sql`: `bank_account_lookups` (secret key writes only; 30 lookups an hour per user, 60 per network address, 20 an hour per company for its own account and 100 for employees, 10 a day while setup is unfinished, a platform ceiling; the number kept as a keyed digest and last 4); `bank_code`, `bank_lookup_id`, `bank_account_digest`, `name_check` (match, near, not_checked), `name_check_reason`, `name_check_source` on `organisation_bank_accounts` and `bank_detail_changes`; `bank_code` and the last check (`bank_checked_*`) on `workers`. A request that names a lookup gets the bank's name from it, whatever the caller sent; a lookup backs one request, by its own user, within 30 minutes, for the same bank and number.
- Name matching (`src/lib/bank-name-match.ts`): companies against the legal and trading names (suffixes normalised: LTD/LIMITED, NIG/NIGERIA, SVCS/SERVICES...); workers against first and last name in any order, middle names allowed. `match` accepts; `near` needs a reason of 10+ characters the approver sees; `no_match` is refused. The server recomputes it on approval from the stored name and refuses a no match, a near match without a reason, or a number other than the one checked (digest).
- Without provider keys: the deterministic test resolver outside production ("Test lookup" on screen); production refuses with a clear message.
- Imports don't look names up per row: their requests are `not_checked` (raised only through the import's definer function; signed-in users can't raise unchecked requests, `MLBL7`), approving one needs a note saying how the account was confirmed, and "Check bank details" on the person page checks the details on file later.
- Test and sandbox lookups back requests only where the database allows them (`private.settings`, seeded on local and CI databases only); the hosted project, which previews share, shows them but refuses to use or approve them.

**Accept:** an account in someone else's name can't be sent; a close match carries a reason to the approver; the approver sees the bank's name and the result; tests, CI and previews without keys use the test resolver.

### 2.4 Contracts, dated rate cards and WHT per line (after 2.1; can run alongside 2.2)
- Migration `<ts>_contracts_rate_cards.sql`:
  - `contracts`:
    - client_id, `reference` (unique per organisation ignoring case; generated as `CTR-0001` when left blank, never reused), name, type: **manned_post, per_visit, fixed_monthly, per_job** (milestone and cost_plus come later: milestone needs Phase 8 projects, cost_plus needs markup rules nobody has written).
    - start_date, end_date (null means rolling), `go_live_date` (set at activation: the later of start date and activation day), billing_terms_days (null means the client's terms, then the organisation's), `vat_applies` (default from `organisations.vat_registered`).
    - `sla jsonb` (Zod shape: `coverage_target_bps`, `response_minutes`, `notes`), status (draft, active, ended), activated_at, activated_by, ended_at, end_reason.
    - Columns other than status, the activation fields and the end fields freeze once the contract is active.
  - `contract_sites`: contract_id, site_id, unique pair. A trigger requires the site to belong to the contract's client. Locked once the contract is active; 2.8 adds sites to a live contract.
  - `rate_cards`: contract_id, effective_from, effective_to, note. No overlaps, and versions sit inside the contract's dates.
  - `rate_card_lines`: rate_card_id, role, `band` (default `standard`; for example Day, Night, Supervisor), unit (shift, hour, visit, month, job), `rate_kobo` (above 0, up to ₦1bn), currency, **`ot_rate_kobo`** (null, or above 0: the line's own overtime rate per hour, owner decision), `ot_multiplier_bps` (null, or 10000–30000; shown as "overtime 1.5×" when no hourly rate is set). Unique on `(rate_card_id, lower(role), lower(band), unit)`. The **rate key** is (role, band, unit).
  - ~~`contract_wht_rates`~~ (superseded 19 Nov 2026, owner's accountant): WHT is set **per rate line** (`service_type`, `wht_rate_bps`), see "As built" below.
- Writes are SQL functions only (no insert or update grants on the rate tables):
  - `save_draft_rate_card(contract, effective_from, lines jsonb)` replaces the card while the contract is a draft. Nothing has used it yet, and the audit row keeps the before and after.
  - `add_rate_card_version(contract, effective_from, lines jsonb)` is for active contracts. It runs in one transaction, needs `effective_from >= org_today` (backdating waits for Phase 6, like decision 17), closes the previous version the day before, and refuses the change if any open post's rate key is missing from the new lines.
  - `cancel_rate_card_version(id)` works only on a version that hasn't started yet, and only the latest one; it reopens the version before it.
  - (No WHT functions: WHT lives on the rate lines and is versioned with the card.)
- Pure library `src/lib/rate-cards.ts` (isomorphic, built in 2.4 so the rate card editor shows the same preview in the browser; it imports nothing from `src/server/`):
  - `rateCardInForce(versions, date)`.
  - `planNewVersion(versions, from, today)`, which returns the row to close and the new row, or a reason it can't (also the preview for "Change rates from").
  - `findRateLine(version, key)`.
  - `missingRateKeys(headcountLines, version)`.
  - `formatRateSummary(lines)`, which gives "₦12,500 day · ₦15,000 night shift · overtime 1.5×" for the setup table and client page.
  - No billing arithmetic beyond that. Pricing a Work Unit is Phase 6.
- Routes:
  - `/app/clients/[clientId]/contracts/new` takes type, name, reference, dates, sites, terms, VAT and SLA (WHT is on the rate lines).
  - `/app/clients/[clientId]/contracts/[contractId]` has the tabs Details · Rate card · Headcount · Documents and an Activate button with a checklist in the header (2.7). The Rate card tab shows the version in force, scheduled versions and history, with "Change rates from"; Details shows the WHT history with "Change WHT rate from".
  - The client's Contracts tab and the Setup step 4 Rate column fill in.
- Register the actions (rate changes are `money` with previews); add `fixtures/lira/contracts.md`.
- Tests:
  - Unit tests on `rate-cards.ts`: an overlap refused, a past version frozen, the previous version closed the day before, the scheduled version cancelled, the exact kobo round trip of `"12,500"` and `"12500.50"`, a missing key reported, the summary text with and without `ot_rate_kobo`.
  - Database tests for the triggers, including the per-line WHT defaults.
  - RLS for the five tables.
  - money-reviewer before merge.

- **As built (2.4):**
  - Rate card writes are private security definer functions (role checked through `private.has_role`, so untrusted sessions are refused) behind public invoker wrappers, because the tables have no write grants. The audit actor is still the caller. Contracts and contract sites are written as the caller (`create_contract`, `update_draft_contract`).
  - "Frozen" applies once the contract has left draft: on a draft nothing has used the card, so `save_draft_rate_card` replaces it whole and versions may be cancelled. `add_rate_card_version` also works on a draft (a change already agreed, from after the current card), which is how "Change rates from" is shown before activation exists.
  - Lines are insert-only. `private.rate_card_open_post_keys(org, contract)` returns nothing until 2.7 replaces it with the open posts' keys; `add_rate_card_version` already refuses (`MLRC5`) a change that leaves one out.
  - Moving a draft's start date moves its first rate card with it; anything else left outside the dates is refused (`MLCO4`).
  - The first rate card always starts on the contract's start date (`save_draft_rate_card` refuses anything else, `MLRC4`), so no day of the contract goes unpriced. Once live, `end_date` is frozen like the other terms (`MLCO1`); 2.7's `end_contract` must let it through and close the dated versions with it.
  - **Overtime (owner confirmed 19 Nov 2026):** what bills is `ot_rate_kobo`, charged per overtime hour. The multiplier is an entry helper: on an hourly line the editor works the rate out as `roundHalfUp(rate_kobo × bps / 10000)` (half up, once, on the final amount) and stores both; on shift, visit, month and job lines a multiplier alone can't make an hourly rate, so `ot_rate_kobo` is required when overtime is offered (check `rate_card_lines_ot_needs_rate`), and any multiplier is display-only.
  - **WHT per line (owner's accountant, 19 Nov 2026; supersedes per-contract WHT).** Each rate line has a `service_type` (`services` default, `management_fee`, `rent_hire`, `goods`, `other`) and a `wht_rate_bps` (0–20%) that defaults from the type (2%, 5%, 10%, 2%, 2%; `private.default_wht_rate_bps` and `DEFAULT_WHT_BPS`), is editable per line and is versioned with the card (insert-only, frozen with the line). The editor prefills it from the type, with the hint to split facility management into service lines and a separate management fee line. `formatRateSummary`, the diff and the preview include WHT. Phase 6 computes the expected WHT per invoice line on the amount before VAT and sums it.
  - **Client tax settings.** `clients.deducts_wht` (`expected` default, `not_deducted`) and `clients.withholds_vat` (default false; government MDAs and appointed VAT withholding agents), read through `client_billing` like the other billing columns (not hr or line managers), written by owner, admin and finance through `set_client_tax_settings` (row audit plus `clients.tax_settings_changed` with the reason), shown on the client Overview. The app applies no turnover threshold; Phase 6 learns from payments and flags differences.
  - `rateCardInForce(versions, date, contractEndDate)` puts nothing in force after the contract's end date, even on an open version.
  - Pages work out "today" in the company's own time zone (`todayIn(organisations.timezone)`), as `private.org_today` does. Registry previews still use Lagos time.
  - `billing_frequency` is monthly, fortnightly, weekly or on_completion (owner confirmed 19 Nov 2026). Refusal codes: `MLCO1`–`MLCO4`, `MLRC1`–`MLRC8`, `MLCL1` (MLCT stays for 2.7).
  - Routes: `/app/clients/[clientId]/contracts/new`, `/app/clients/[clientId]/contracts/[contractId]` (Details, Rate card with versions including each line's service type and WHT, Headcount and Documents placeholders), `.../edit` (draft only) and `.../rates` (draft card or `?mode=change`), each with a Review step that shows the preview before saving.

**Accept:** a draft Coastline contract gets a rate card (Guard Day ₦12,500 a shift, Guard Night ₦15,000 a shift, overtime 1.5×, WHT 2% per line); after activation in 2.7, "Change rates from 1 Jan" adds a version and closes the old one on 31 Dec; editing a past version is refused by the database.

### 2.5 Headcount (after 2.4)
- Migration `<ts>_headcount.sql` creates `headcount_requirements`. This is the draft plan the client signs up to, and is frozen at activation.
  - Columns: contract_id, site_id (must be a contract site), `post_name` ("Gate A"), role, band, kind (shift, visit), `days_of_week smallint[]` (ISO 1–7, non-empty, no repeats), `start_time time`, `end_time time` (ending at or before the start means it ends the next day), `duration_minutes` (worked out, 15–1440), `required_count` (1–200), notes.
  - Unique on `(contract_id, site_id, lower(post_name), lower(band))`. The post is named "Gate A · Day" from `post_name · band`.
- On the Headcount tab, rows are grouped by site, with a weekly total line: "4 posts · 28 shifts a week · ₦385,000 a week at today's rates". That total is a preview from `rate-cards.ts`; nothing is stored. A row whose rate key has no rate line is marked "No rate for Guard · Night".
- Pure `src/server/business/headcount.ts` provides `expandWeek(lines)` and `shiftsPerWeek`, with tests that cover a night shift crossing midnight and a 24-hour post. Its weekly total is the preview for headcount changes.
- Tests: unit tests as above; RLS; a check that the database refuses an edit after activation.

**Accept:** a manned-post contract at two sites gets 4 headcount rows; the weekly totals are right to the kobo; a row with no matching rate line is flagged.

### 2.6 Contract documents (after 2.4; parallel with 2.5)
- Migration `<ts>_contract_documents.sql`:
  - A private bucket `contract-docs` (PDF, PNG and JPEG, 10 MB or less) at `{organisation_id}/{contract_id}/{document_id}.{ext}`.
  - Storage policies parse the path the way `org_asset_org_id` does. Read by owner, admin, finance and ops_manager; insert by owner, admin and ops_manager; no update or delete through SQL.
  - Table `contract_documents`: contract_id, storage_path (unique), kind (signed_contract, sla, purchase_order, insurance, other), title, size_bytes, mime_type, sha256, uploaded_by, removed_at, removed_by.
- The browser uploads straight to the bucket as 1.8 does. The server checks the type from the file's magic bytes, then records the row. Opening a document makes a 60-second signed URL. "Remove" marks the row; the file is deleted through the Storage API by a daily sweep 30 days later.
- Tests: RLS covering the table and the storage paths (company B can't read or upload under company A's prefix; hr can't read); unit test for the magic-byte check.

- **As built (2.6):**
  - Migration `20261119145000_contract_documents.sql`. Kinds add `amendment` (signed_contract, sla, amendment, purchase_order, insurance, other). Columns add `file_name` (the cleaned original name, used as the download name), `file_ext`, `status` (pending, active, rejected, removed), `uploaded_at`, `removed_reason` and `file_deleted_at`. DOCX is not accepted (the plan's PDF, PNG and JPEG only; a DOCX can't be opened in the browser and its zip signature says nothing about its content).
  - The upload is three steps, as 1.8: `startContractDocumentUpload` inserts a pending row (the database fixes `storage_path`, the uploader and the state); the browser uploads to that path (Storage's insert policy needs the uploader's own pending row, under an hour old); `confirmContractDocumentUpload` reads the object back as the user, checks its magic bytes and size, works out its sha256 and only then calls `confirm_contract_document` with the secret key, naming the verified user as `p_actor`. The function is executable by `service_role` only; it re-checks the actor's role and that they uploaded it, and that the object is in Storage with the stated size, type and owner, before marking the row active (`contract_document.uploaded`, actor the user). A file that fails is marked rejected (`reject_contract_document`, also secret key only) and deleted at once. Caps (MLCD5, advisory-locked per uploader): 10 uploads an hour and 20 unconfirmed or refused files not yet deleted per person, 300 a day per company.
  - The bucket's select policy needs an active row (or the uploader's own pending one), so a removed document can't be opened or signed again. No update or delete policies on the bucket, and no update or delete grants on the table: rows move only through `confirm_contract_document` and `reject_contract_document` (secret key only) and `remove_contract_document` (editors) (private definers behind invoker wrappers), and a guard refuses every other change and every delete for all roles, the database owner included (`MLCD1`–`MLCD4`).
  - Opening is the route `/app/clients/[clientId]/contracts/[contractId]/documents/[documentId]` (`?download=1` to save), which checks the role, reads the row under RLS (it must belong to the contract in the URL, and the contract to the client in the URL) and answers 303 to a 60-second signed URL made with the user's own client (410 once removed). A link already handed out lives out its 60 seconds.
  - Daily sweep `/api/cron/contract-documents` (Vercel Cron, `CRON_SECRET`): rejects uploads still pending after an hour, and deletes the files of rejected documents and of documents removed more than 30 days ago, stamping `file_deleted_at`.
  - Registered: `contract_documents.summary` (active contracts with no signed contract on file), `.list`, `.open` (agent false), `.start_upload`, `.confirm_upload` (agent false) and `.remove` (one row, with a preview). `fixtures/lira/documents.md`. The isolation entry is in `tests/rls/tables/documents.ts` (its own file, to stay clear of 2.5's edits to `business.ts`).

**Accept:** a signed contract PDF uploads, opens by signed URL, and can't be fetched by another company or by hr.

### 2.7 Activation: posts and roster requirements (after 2.2, 2.4, 2.5)
- Migration `<ts>_posts_roster_requirements.sql`:
  - **`posts`** is the place where one role is staffed, and what a roster row is ("Gate A · Day"):
    - Columns: contract_id, site_id, headcount_requirement_id (unique; null for posts added later in 2.8), name, role, band, kind (shift, visit), status (open, closed), opened_on, closed_on (null), closed_reason.
    - Unique on `(contract_id, site_id, lower(name))` among open posts.
    - Never deleted. Closing sets `closed_on`, and posts don't reopen.
  - **`roster_requirements`** says how many people a post needs, when, and from which date:
    - Columns: post_id, contract_id, site_id (copied from the post, composite foreign keys), effective_from, effective_to (null), `days_of_week smallint[]`, `start_time`, `end_time`, `duration_minutes`, `required_count`.
    - No overlapping versions per post (GiST exclusion). A version in force or in the past is never updated except to close `effective_to`. Versions sit inside the post's open dates.
  - **`private.required_shifts(org uuid, from_date date, to_date date)`** (stable, security definer, filtered by `user_org_ids`, with a public invoker wrapper) is what Phase 3 rosters against:
    - It returns one row per (post, date) with requirement_id, post_id, site_id, contract_id, role, band, `starts_at timestamptz` and `ends_at timestamptz` (organisation timezone; a night shift ends the next day), and `required_count`.
    - It covers dates where the requirement is in force, the weekday is in `days_of_week`, the post is open, and the contract is active and not past `end_date`.
    - Range capped at 62 days.
- **`activate_contract(p_organisation_id, p_contract_id, p_send_welcome bool)`** runs as one transaction with the contract row locked:
  - It refuses with plain-English reasons (SQLSTATE `MLCT1`–`MLCT9`), also shown as the checklist on the contract page, when any of these is true:
    - The contract isn't a draft.
    - The client has no active billing contact with an email.
    - A contract site has no geofence.
    - There is no rate card version in force on the go-live date.
    - A headcount row has no matching rate line.
    - (No separate WHT check: every rate line carries a service type and WHT rate, which the defaults guarantee.)
    - A manned_post contract has no headcount.
    - The end date is before the go-live date.
  - It sets `go_live_date = greatest(start_date, org_today)`. Then it inserts one `posts` row per headcount row (`opened_on = go_live_date`) and one `roster_requirements` row per post copying the days, times and count (`effective_from = go_live_date`, `effective_to = end_date`). Finally it sets status `active`, activated_at and activated_by, and logs `contract.activated` with the post and requirement counts.
  - Calling it again on an active contract changes nothing and returns the existing posts (idempotent).
  - A pure preview (`planActivation`) gives the checklist and "Creates 4 posts and 4 roster requirements from 1 Dec 2026" before the call.
- **`end_contract(p_contract_id, p_end_date, p_reason)`** sets end_date, closes every open post and requirement on that date, and sets the status to `ended` once the date has passed (pg_cron daily). An end date in the past is refused. It must close (or cancel, if they start after the end date) the open rate card versions on that date **before** the status becomes `ended`: the 2.4 guards refuse every rate card write once a contract is ended, and freeze `end_date` once it is live (`contracts_before_write` must be replaced to let `end_contract` through).
- **Welcome email** (owner decision): on by default. With `p_send_welcome`, an email is sent with `after()` to the client's primary ops and billing contacts. It names the company, the contract, the sites, the go-live date and the address invoices will come from. No bank details; they appear on invoices only. The company's `invoice_email` is the reply-to. The ops managers get an in-app or email notice.
- UI: an Activate dialog shows the checklist (each item ticked or showing the reason, with a link to fix it), the preview line, and a "Send welcome email" checkbox, ticked. After activation the contract page shows a Posts table: Post · Site · Days · Hours · Required · From.
- Tests:
  - Database tests for activation:
    - Every refusal.
    - The happy path: posts and requirements match the headcount.
    - Idempotency.
    - Two activations at once, giving one set of posts.
    - `required_shifts` over a week with a night post across midnight, a Mon–Fri post and an ended contract.
  - Unit test for the welcome email template.
  - RLS for posts and requirements: no direct insert or update by any role; line_manager can read.

**Accept:** activating the Coastline contract creates its posts and roster requirements, and `required_shifts` for the next week returns exactly the shifts the headcount describes. This is the Phase 2 "done when".

### 2.8 Changes to a live contract (after 2.7)
- These are SQL functions, each dated, audited and one transaction, each with a preview:
  - `change_post_requirement(post, from_date, days, start, end, count)` closes the current version the day before and inserts the new one. The from date must be today or later.
  - `add_post(contract, site, name, role, band, kind, from_date, ...)` refuses a rate key that isn't on the version in force.
  - `close_post(post, on_date, reason)`.
  - `add_contract_site(contract, site)`.
- Contract page: "Change headcount from", "Add post" and "Close post", each with a history drawer per post.
- Tests: database tests for each function, with a check that `required_shifts` reflects the change from the right date; unit tests for the date planning (reusing `planNewVersion`).

**Accept:** raising Gate A · Night from 1 to 2 guards from next Monday shows 1 before that day and 2 from it, and history keeps both versions.

## Order and parallel work

```
2.1 clients ──┬── 2.2 sites ─────────────┐
              └── 2.4 contracts ──┬── 2.5 headcount ──┴── 2.7 activation ── 2.8 live changes
                                  └── 2.6 documents
2.3 company bank account (independent, any time)
```
Wave 1: 2.1 and 2.3. Wave 2, off 2.1's branch: 2.2 and 2.4. Wave 3, off 2.4's branch: 2.5 and 2.6. Then 2.7, then 2.8. security-reviewer runs on 2.1 (RLS, audit channel), 2.2 (storage and tokens), 2.3, 2.6 and 2.7. money-reviewer runs on 2.4, 2.5 and 2.7.

## Illustrations
- `no-clients` (160) on the empty `/app/clients`, already drawn in `src/components/illustrations/later.tsx`; 2.1 wires it up.
- Not needed elsewhere: one per screen at most, and the contract pages, sites tab and activation dialog use plain empty-state copy ("No sites yet. Add the places your people work."). If the owner wants a success scene after activation, add a `contract-active` slot (240) to the DESIGN_SYSTEM table and draw it in 2.7.

## Test plan
- **Unit (Vitest):**
  - Client and contact schemas, the clients summary, the capability registry (2.1).
  - `rate-cards.ts`: dating, the version in force, closing the previous version, cancel, missing keys, summary text, kobo parsing round trips.
  - `headcount.ts`: weekly expansion, midnight crossing, weekly kobo preview using `sumKobo`.
  - Zod schemas for site, geofence, contract and SLA.
  - Templates for the welcome and bank-account emails.
  - Magic-byte check for documents.
- **Database (Vitest against `supabase start`, alongside the RLS suite):** the contact triggers and `create_client` (2.1), rate card (with per-line WHT defaults) and requirement triggers, exclusion constraints, geofence trigger and check function, `activate_contract` (refusals, idempotent, concurrent), `required_shifts`, `end_contract`, the 2.8 functions, two-person rule and hold on the bank account.
- **RLS:**
  - `tests/rls/tables/business.ts` registers `client_contacts` (2.1), then `site_checkpoints`, `organisation_bank_accounts`, `contracts`, `contract_sites`, `rate_cards`, `rate_card_lines`, `headcount_requirements`, `contract_documents`, `posts` and `roster_requirements`. The existing `clients` and `sites` entries stay in `people.ts`.
  - Role matrix tests per the roles table, plus storage-path tests for `contract-docs`.
- **Playwright:**
  - `tests/e2e/clients.spec.ts` (2.1): ops_manager adds a client with two contacts at 390px and 1440px; finance reads without editing.
  - `tests/e2e/clients-contracts.spec.ts` (grows from 2.2 to 2.7): ops_manager adds Apapa Warehouse 3 with a pin geofence and 2 checkpoints, creates a manned-post contract, enters the rate card, adds headcount (Gate A · Day and Night, Patrol · Night, Warehouse floor · Day), uploads a PDF, activates, and sees 4 posts. Run at 390px and 1440px.
  - `company-bank-account.spec.ts`.
  - The setup step 4 quick add in `company-setup.spec.ts` (2.1).
  - New fixture `fixtures/contracts-sample.json` holds the three board clients with their sites, rate cards and headcount (Coastline ₦12,500 day, ₦15,000 night, 1.5×; Greenfield ₦18,000 supervisor 12 h shift; Marina VI Tower), for e2e now and Phase 6 pricing later.

## Phase 2 done when
- Activating a contract creates its posts and roster requirements, and `required_shifts` returns the shifts its headcount describes. This is proven in CI (database test and Playwright) and on the Vercel preview.
- Rate cards are dated versions that the database refuses to change after the fact; rate-card unit tests pass and money-reviewer has no findings.
- Every Phase 2 table is in the isolation test. Company bank account changes provably need a second approver and wait out the hold. Contract documents can't be read outside their company.
- Clients, sites (geofence and checkpoints), contracts, headcount and documents work at 390px and 1440px.
- Every Phase 2 Server Action is in the capability registry, and every multi-row or money write has a preview.

## Decisions (owner, 19 Nov 2026)
1. Contracts and Phase 1 "projects" stay separate. The people import's project column keeps filling `projects`. A worker's site mapping is what ties them to a contract's posts in Phase 3, and no `contract_id` is added to `worker_assignments`.
2. Geofence is a circle by default (pin plus radius 25–2000 m, default 100 m), with an optional drawn outline. Checkpoints are their own table (not `sites.checkpoints jsonb` as DATA_MODEL says); update DATA_MODEL in 2.2.
3. Rates are VAT-exclusive. VAT is applied in Phase 6 from the tax rule set (7.5%, RULES_NIGERIA) when `contracts.vat_applies` is set.
4. Rate changes on a live contract start today or later. Backdating is decided in Phase 6, alongside posted invoices.
5. Headcount is the frozen draft plan; posts and roster requirements are the live, dated records. Rate lines are matched by key (role, band, unit), not by foreign key, so a new rate version never touches posts.
6. NGN only (`currency = 'NGN'` check on every money column this phase).
7. Corners are 12px everywhere (buttons, inputs, selects, form fields, cards).
8. Lira groundwork in every slice (above).

## Answered questions (owner, 18–19 Nov 2026)
1. **Map for geofences.** Leaflet with MapTiler tiles: one key, restricted to ops.metaliratech.com, *.vercel.app and localhost, in `NEXT_PUBLIC_MAPTILER_KEY` (added in Vercel). Plus "Use my location".
2. **Company bank account approval.** Changes wait out a 72-hour hold, as worker bank changes do. The first account during setup is allowed with one approver and audited.
3. **Overtime billing on shift-priced lines.** Each rate-card line carries its own overtime rate (`ot_rate_kobo`), with the multiplier kept for display and lines that have no hourly rate. Refined by 9 below.
4. **WHT.** ~~Per contract~~ Superseded 19 Nov 2026 (owner's accountant): WHT is set per rate line by service type (see 12).
5. **Contract types.** manned_post, per_visit, fixed_monthly and per_job now; milestone and cost_plus later.
6. **Welcome email.** Sent on activation to the client's ops and billing contacts, on by default, with the sites, go-live date and invoice sender, and no bank details.
7. **"Import clients from Excel"** (Setup board button). Later. The people import already creates clients and sites by name.
8. **Billing frequencies** (owner confirmed 19 Nov 2026). monthly, fortnightly, weekly and on_completion.
9. **Overtime billing** (owner confirmed 19 Nov 2026). Overtime is billed as each line's per-hour overtime rate (`ot_rate_kobo`); the multiplier is only an entry shortcut (on hourly lines it works the rate out, half up once).
10. **WHT base** (owner, 19 Nov 2026). WHT is calculated on the service amount before VAT. Rates, remittance and VAT withholding are in RULES_NIGERIA.md "WHT and VAT withholding".
11. **Clients that withhold VAT** (owner, 19 Nov 2026). Government MDAs and appointed VAT withholding agents pay the VAT to the tax authority; it is a client setting, `clients.withholds_vat` (a government client withholds VAT on all its contracts).
12. **WHT per line** (owner and accountant, 19 Nov 2026). Each rate line has a service type and its WHT rate (services 2%, management fee 5%, rent or hire 10%, goods 2%, other 2%), editable per line and versioned with the card. Staffing is 2%; facility management is split into service lines (2%) and a separate management fee line (5%). Whether a client deducts WHT is a client setting (`clients.deducts_wht`, expected or not deducted), learned from payments in Phase 6; the app applies no small-company threshold (₦50m under the Nigeria Tax Act, but the client's decision).

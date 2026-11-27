# Phase 6: invoicing and collections (about 3 weeks)

Goal: approved, billable work becomes invoices without anyone retyping it. Finance picks clients from the unbilled queue, the app drafts one invoice per contract per billing period at the rate card in force on each day, with VAT where the contract charges it, and on posting gives the invoice a gap-free number, a PDF showing the company's own bank account and the invoice number as the transfer narration, and an email to the client's billing contacts. Finance uploads the company's bank statement (CSV or XLSX); the app reads every line, refuses nothing silently, matches each credit to an invoice (exact, by reference, net of WHT, partial) and each salary debit to the payroll bank file it paid. An exact match pays its invoice and emails a receipt with nobody touching it; everything else waits for a person in the suggested queue. Credit notes correct posted invoices, overpayments become client credit, ageing shows what is overdue, and reminders go out by email inside the caps. Metalira never holds or moves the money.

**Done when** (BUILD_PLAN): an imported sample statement's exact match (amount and invoice number) pays its invoice and emails a receipt with nobody touching it; fuzzy matches wait in the suggested queue.

Planned 27 Nov 2026, from `main` at `461dd22` with Phase 5 signed off (25 Nov 2026, #91) and the owner-requested slices U.1 to U.4 merged (#85, #89, #92, #93). The screens follow the prototype boards:
- `Unbilled.dc.html`: "₦3,418,500 of work not yet billed", "Approved hours and finished jobs, priced at each contract's rate card. Pick clients to draft one invoice each.", the client cards (name, "Lekki Estate Gate B · guarding contract · monthly in arrears", total, age dot "12 days old"), lines with Work, the Work Unit range ("WU-0981 to WU-1072") and Quantity ("92 × ₦12,500"), "Not included: 5 flagged timesheets worth ₦62,500 until they are approved. Review them", the draft summary (Invoices to create, Subtotal, VAT 7.5%, Total, "Draft 3 invoices"), "Drafts stay editable until you post them."
- `Collections.dc.html`: "Import bank statement", "Money in", the ageing tiles (0–30, 31–60, 61–90, over 90 days), the tabs Unmatched · Suggested · Matched with counts, each row with amount, payer, source, "Suggested match" or "Not matched", the invoice and the reason ("Matches after 5% withholding tax on the ₦2,000,000 subtotal.", "Part payment. ₦2,332,500 stays outstanding, 24 days old."), Accept match, Change, "Invoice to allocate to", Allocate, Keep as credit.
- `Simulate.dc.html` steps 4 to 6: the invoice layout (company name, RC and TIN, address; "Invoice INV-0412 · 31 Oct 2026", "Due 30 Nov 2026"; Bill to; Work period and site; Description · Qty · Rate · Amount with the source line "22 approved shifts"; Subtotal, VAT 7.5%, Total due; "Pay by bank transfer"), "Send 3 invoices", and the receipt ("Receipt RCT-…", Received from, Amount, "For INV-0412, paid in full", Method, "Sent to …, copy to …").
- `Setup.dc.html` step 3 "Invoices and getting paid" (invoice email, "Invoice number starts at", payment terms 30 / 14 days / on receipt, VAT registered, "Email a receipt to the client as soon as a payment is matched"): already built in Phase 1 and slice 2.3.
- `Main.dc.html`: the "Overdue invoices" tile ("₦2.14m · 2 invoices · 31–60 days"). Revenue figures ("Revenue counts when an invoice is posted") are Phase 7.

Parts of those boards that are superseded:
- "Paystack connected · Flutterwave connected", "Payments arrive in each client's dedicated account number", "Each client pays into their own dedicated account number", "Or pay online pay.flutterwave…", "Wema Bank · 99 1234 5671 · Account for Coastline only", "Simulate Flutterwave payment" and "New payments appear within a minute of the bank confirming them": clients pay by transfer into the company's one business account, and payments are found when a statement is imported (BUILD_PLAN "Payments model"). The source line reads "GTBank statement · imported 31 Oct · value date 30 Oct".
- "A WHT credit note is recorded" (Collections): the WHT the client deducted is recorded on the allocation, and the client's WHT credit note is tracked as **awaited** until Finance records it (decision 10).
- "Night overtime pass-through, 1.5×", "12 h × ₦1,875": overtime bills at the rate line's own per-hour overtime rate `ot_rate_kobo` (Phase 2 answered question 9); the multiplier is only how the rate was entered.
- "Sent from billing@adebayofs.example": invoices are sent from Metalira's verified domain with the company's name as the sender name, its invoice email as the reply-to address and a copy to it (decision 19). Sending from the company's own domain is later.
- "Matched automatically" on a net-of-WHT payment: only an exact match (amount and invoice number) is confirmed without a person; every other pattern waits in Suggested (BUILD_PLAN).
- The ageing tiles count days **past the due date**, with "Not due yet" as its own figure (decision 13).

Builds on (names as they are on `main`):
- `organisations`: `legal_name`, `trading_name`, `rc_number`, `tin` (FIRS format, nullable), `address`, `phone`, `logo_path` (`org-assets`, PNG or SVG), `invoice_email`, `invoice_number_start` (default 1), `payment_terms_days` (default 30), `vat_registered`, `auto_email_receipts` (default true), `timezone`, `business_type` (`workforce` or `services`, 3.0).
- `clients` (`legal_name`, `tin`, `billing_address`, `state`, `billing_terms_days`, `deducts_wht` expected or not_deducted, `withholds_vat`), read through `client_billing` (owner, admin, finance, ops_manager); `client_contacts` with `role` billing, approver or ops.
- `contracts`: `type` (manned_post, per_visit, fixed_monthly, per_job), `billing_frequency` (monthly, fortnightly, weekly, on_completion), `billing_terms_days`, `vat_applies` (default from `vat_registered`), `start_date`, `go_live_date`, `end_date`, `status`; `contract_sites`, `posts` (role and band as written), `contract_changes` (never a pricing source).
- `rate_cards` and `rate_card_lines` (dated, insert-only; rate key role, band, unit with `unit` shift, hour, visit, month or job; `rate_kobo`, `ot_rate_kobo`, `ot_multiplier_bps`, `service_type`, `wht_rate_bps`); `src/lib/rate-cards.ts` (`rateCardInForce(versions, date, contractEndDate)`, `findRateLine`, `normaliseKeyPart`) and its SQL twin `private.rate_key_part`; `add_rate_card_version` refuses a start before today (Phase 2 decision 4: backdating waits for this phase).
- `work_units` (4.3): one per approved timesheet day on a post; `contract_id`, `site_id`, `post_id`, `shift_id`, `timesheet_line_id` (unique), `worker_id`, `kind` (shift_post; visit, job and milestone allowed by the check), `work_date`, `unit`, `quantity_minutes`, `ot_minutes`, `contract_type`, `billable`, `status` approved or cancelled. A reopened or disputed day cancels its unit; nothing yet stops that once the unit is billed.
- `organisation_bank_accounts`, `public.org_bank_account_as_of(org, at)` (the account in force at a moment, with ciphertext), `org_bank_account_masked`; `src/server/crypto/pii.ts`; the rule that invoice code decrypts the account and refuses a last-4 mismatch before printing it (slice 2.3).
- Phase 5's `payout_batches` and `payout_items` (status pending, left_out, voided; "Phase 6 adds `matched`"), `payout_supplements` and `payout_supplement_items`, the narration "Salary Oct 2026 MLS-0001".
- `src/lib/money.ts` (`roundHalfUp`, `applyBps`, `sumKobo`, `allocateKobo`, `formatNaira`, `parseNairaToKobo`), `src/lib/bank-name-match.ts` (company-name normalising: LTD/LIMITED, NIG/NIGERIA…), `src/lib/personal-number.ts`.
- `@react-pdf/renderer` with Inter embedded (5.5); the private-bucket pattern (no Storage policy, server signs 60-second URLs with the secret key, downloads audited); `read-excel-file` (the people import).
- `src/server/email/send.ts` and its caps (30 per company and 80 overall a day, `claim_manager_email`), `inbox_items`.
- The daily `/api/cron/contract-documents` job, which already runs the Storage sweeps; `vercel.json` has 7 daily crons.
- Placeholders `/app/unbilled` (nav: owner, admin, finance, ops_manager), `/app/collections` and `/app/revenue` (owner, admin, finance). Illustrations `no-invoices` and `all-collected` are drawn (`src/components/illustrations/later.tsx`).
- `fixtures/october-2026-golden.json` `invoices`: INV-0412 Coastline ₦597,500 + ₦44,812.50 VAT = ₦642,312.50; INV-0413 Marina ₦418,000 + ₦31,350 = ₦449,350; INV-0414 Greenfield ₦396,000 + ₦29,700 = ₦425,700.

## Rules that apply to every slice here (as in Phases 1 to 5)

- Every new table has `organisation_id uuid not null`, RLS in the set-helper form (`organisation_id in (select private.role_org_ids(array[...]))`), composite `(organisation_id, id)` foreign keys, and an entry in `tests/rls/tables/` (new files `zzzzzzz_billing.ts` and so on, sorting after Phase 5's). `tests/rls/isolation.test.ts` "declares exactly the tables in schema public" fails on any table without one.
- **Money is integer kobo** (`bigint`) with a `currency` column (`NGN`, checked). The billing engine computes in `bigint`; no `number` ever holds kobo; SQL does no money maths except sums and the invariant checks below. Statement amounts are parsed by a dedicated strict parser, never `parseNairaToKobo` and never through a float (DATA_MODEL). Format only at the edge with `formatNaira()`; documents show two decimals.
- **Rounding** (RULES_NIGERIA "Rounding"): round once, half up, at the final value of each line; VAT once on the invoice; WHT once per line; `allocateKobo` for splits. Negative (credit-note) lines round half away from zero, mirroring the line they reverse.
- **Dated rates** (rule 3): VAT rates and rate cards are dated versions; a version in force is never updated except to close it.
- **Posted is final** (rule 5): a posted invoice, its lines and sources, a credit note, a receipt, a payment and an allocation are never edited or deleted by anyone, the secret key and the database owner included (ENABLE ALWAYS guards and truncate guards, as Phase 5). A correction is a credit note, a reversing allocation with a reason and an actor, or a receipt cancellation row.
- **Gap-free numbers**: invoice, credit-note and receipt numbers come from a per-company counter row locked inside the posting transaction, so a refused posting uses no number and no number is ever used twice or skipped.
- **No custody** (rule 6): nothing in Phase 6 calls a bank or payment API. Invoices print the company's own account; statements are files the company exports from its own bank. Monnify stays Phase 9 and outside `src/server/billing/` invoicing code paths.
- **Personal data** (rule 9): the company's full account number is decrypted on the server only to print the invoice and receipt PDFs and the invoice email, never logged, never in `audit_log`, never in a Lira summary. Statement files and lines (narrations name payers and, on debits, workers and their account numbers) live in a private bucket and tables read by owner and finance only, are never logged, and narrations never reach `audit_log` (the row audit drops them).
- **Notifications** (rule 8): email through `src/server/email/send.ts` and the in-app inbox. Client-facing emails (invoice, receipt, reminder) carry the amount, the PDF as an attachment and the bank details, because that is their purpose; the decision below gives them their own caps. Manager notices carry no amounts.
- **Never invent a rule**: VAT and WHT come from RULES_NIGERIA.md ("Invoicing", "WHT and VAT withholding"). Where code needs a rule that is not there, the slice stops and asks (open questions below, marked **(accountant)**). Settings > Billing shows "Confirm VAT and WHT handling with your accountant before the first live invoice" until the owner records the accountant's confirmation.
- Every mutation goes through `mutate()` with module `billing`; multi-row writes are SQL functions (private security definer behind a public invoker wrapper, `search_path ''`, grants revoked from public and anon), one transaction each, audited with `log_audit` events as well as the row triggers. Refusal codes: **MLIN** (invoices), **MLBS** (bank statements), **MLMA** (matching and allocations), **MLRT** (receipts), **MLCX** (credit notes; MLCN, MLCR and MLCD are taken), **MLRM** (reminders), **MLPM** (payout matching), **MLJB** (recorded jobs). Each slice checks its codes are unused before it migrates.
- Code lives in `src/lib/billing/` (pure: pricing, totals, WHT, matching, ageing, reminder schedule, statement parsing), `src/server/business/invoicing/` (drafts, posting, documents, sending), `src/server/business/collections/` (imports, matching, payments, receipts, credits, reminders), `src/app/app/unbilled/`, `src/app/app/invoices/`, `src/app/app/collections/`. The company bank account stays in `src/server/billing/` (2.3). Each slice has its own timestamped migration. Merge `main` in and regenerate `src/types/db.ts` before the PR. Merge main INTO branches; never rebase or force-push. If a later-numbered migration merges first, rename the slice's migration to the next free slot (5.4's lesson).
- Corners are 12px; screens work at 390px and 1440px.
- Crons stay daily (Vercel Hobby). Phase 6 adds at most one (`/api/cron/billing`, reminders) after checking Hobby's cron limit; otherwise reminders run from the existing daily job.

## Decisions

These are the plan's defaults; the owner can overturn any. None is a Nigerian legal rule except where it cites RULES_NIGERIA.md. Items marked **(accountant)** are built as written and shown with the accountant line until confirmed.

1. **Invoice numbers.** `INV-` and at least four digits (`INV-0001`, then `INV-10000` past 9,999), one continuous sequence per company starting at `organisations.invoice_number_start` (the golden fixture starts at 412), never reset by year. Credit notes `CN-0001` and receipts `RCT-0001` have their own sequences. A number is given **at posting**, never to a draft, from `billing_sequences` (one row per company and kind, `next_value`, locked `for update` in the posting transaction), so a rolled-back posting gives the number back and the sequence has no gaps. A draft is discarded freely (it has no number). A posted invoice is never voided or deleted: "Cancel invoice" is a full credit note with a reason, the number stays used and the invoice shows Credited. `invoice_number_start` can't be lowered below the next value once an invoice is posted (MLIN).
2. **One invoice per contract per billing period.** A contract's terms (VAT, payment terms, WHT per line, its sites) belong on one document. The unbilled queue groups by client so Finance picks clients as on the board, then drafts one invoice per contract and period. Combining contracts on one invoice is open question 2.
3. **Billing periods** from `contracts.billing_frequency`, always in arrears: **monthly** is the calendar month; **weekly** is Monday to Sunday; **fortnightly** is 14-day periods counted from the go-live date (open question 3); **on_completion** bills each completed Work Unit or recorded job when it is approved, one invoice per pick. A period is clamped to the go-live date and the end date. The queue offers every period that has ended ("Up to 31 October"); a period still running can be billed early only by choosing "Bill to today" with a reason.
4. **Pricing** (Phase 2 and 4 carry): each Work Unit is priced from the rate card version in force on its `work_date` (`rateCardInForce`, nothing after the contract's end date), joining the post's role and band to the rate line through `private.rate_key_part` / `normaliseKeyPart`, never `=` or `lower()`. Never from `contract_changes`. A Work Unit whose key has no line on that day's version is **not priced** and is held out of the draft with "No rate for Guard · Night on 14 Oct", listed on the queue. Units per rate line:
   - `shift` and `visit`: quantity = the count of Work Units; amount = count × `rate_kobo`.
   - `hour`: quantity = Σ `quantity_minutes`; amount = Σ minutes × `rate_kobo` ÷ 60, rounded once per invoice line.
   - **Overtime**: Σ `ot_minutes` × `ot_rate_kobo` ÷ 60, its own line, rounded once. A Work Unit with overtime minutes on a line with no `ot_rate_kobo` bills no overtime and is flagged "Overtime not billed: no overtime rate" (the rate card says overtime isn't offered).
   - `month` (fixed_monthly): one line per period at `rate_kobo`, prorated for a part month by calendar days (Phase 2 decision 17: from the go-live date): `rate × days billed ÷ days in the month`, rounded half up once per line. A rate change inside the month splits the line by version.
   - `job` (per_job): one line per recorded job (decision 5) at its rate line's `rate_kobo` × quantity.
5. **Recorded jobs** for per_job and services businesses. `work_units` today needs a post, shift and timesheet day. 6.1 relaxes those columns for `kind = 'job'` (a check keeps them required for `shift_post`) and adds "Record a completed job" on a per_job contract: date, site, rate line (unit `job`), quantity, description, who did it (optional), by ops_manager, finance or owner, audited; it is a billable Work Unit at once (no timesheet). Cancelled, never deleted, while unbilled. Phase 8's milestones use the same columns.
6. **A Work Unit is billed once.** `invoice_line_sources` records every Work Unit (and every fixed-monthly day range) a line bills, under an exclusion constraint while its invoice stands (a draft or a posted invoice not credited for that line), like 5.2's `payslip_sources`. **Unbilled work is a query, never a stored status** (PRODUCT glossary): approved, billable Work Units with no standing source row.
7. **Billed work is locked.** Once a Work Unit is on a posted invoice, 4.3's reopen and dispute refuse its timesheet day (`private.work_unit_billed`, an MLIN refusal beside 4.3's MLTA5: "This day is on INV-0412. Credit the line first."). A credit note that credits the line **with "bill again"** frees its Work Units (their sources stop standing). A Work Unit cancelled while on a **draft** marks the draft stale.
8. **Stale drafts can't be posted.** A draft stores the SHA-256 of its canonical inputs (Work Unit ids and minutes, rate line ids, VAT rate id, contract terms, client tax settings). Posting re-gathers them and refuses a changed hash (MLIN, "Something changed since this draft was made: refresh it"), as 5.3 does for payroll. "Refresh draft" re-prices it with a preview of the difference.
9. **VAT** (RULES_NIGERIA "Invoicing"): 7.5% on taxable services, shown as its own line, from a dated `vat_rates` version (first version 750 bps from 1 Jan 2026, `source_label` "RULES_NIGERIA.md"; Settings > Billing; owner or finance add a new version from tomorrow). The rate is the version in force on the invoice's **issue date** **(accountant)**. VAT applies when `contracts.vat_applies` is true (default `organisations.vat_registered`); a company that isn't VAT registered shows no VAT line. VAT = (Σ VAT-able line amounts) × rate, rounded half up **once per invoice**; each line keeps its share by `allocateKobo` only where something needs it (a partial credit note). The golden invoices give exactly ₦44,812.50, ₦31,350 and ₦29,700. **VAT-exempt clients**: there is no client flag; exemption is set on the contract (`vat_applies` off) and needs a reason when the company is VAT registered ("VAT not charged: …" prints on the invoice). Which supplies or clients are exempt is **(accountant)**. A company with no TIN is warned on every draft and can't post until it adds one (RULES_NIGERIA: the TIN must be printed on every invoice).
10. **WHT deducted by the client** (RULES_NIGERIA "WHT and VAT withholding"). Expected WHT is worked out per invoice line on the line's pre-VAT amount at the line's `wht_rate_bps` (versioned with the rate card; lines are split by rate-card version so each has one rate), rounded once per line, and summed; manual lines take a service type and rate. Each invoice stores `expected_wht_kobo` and, for `clients.withholds_vat`, `expected_vat_withheld_kobo` (= the VAT). The invoice's three **expected receipts** are: the total; the total less WHT; the total less WHT and VAT (VAT-withholding clients only). A client with `deducts_wht = not_deducted` expects the total only (and the WHT line on the PDF reads "WHT not expected"). When a payment is allocated, the WHT and VAT withheld are recorded on the allocation; a difference from the expected amount is flagged on the allocation and the client. **The invoice counts as settled when payments + WHT recorded + VAT withheld + credit notes = the total.** The WHT credit note the client must issue is tracked per allocation as **awaited** until Finance records its number, date and an optional scan (6.7). Whether an invoice may be treated as settled before the credit note arrives is **(accountant)**.
11. **Learning `deducts_wht`.** A client marked `expected` that pays an invoice in full without WHT is flagged on the client ("Paid INV-0412 in full without WHT"); Finance may switch it with a reason (2.4's `set_client_tax_settings`). The app never switches it on its own and applies no threshold (RULES_NIGERIA small-client exemption).
12. **Payment terms and due dates.** Due date = issue date + terms, where terms are `contracts.billing_terms_days`, else `clients.billing_terms_days`, else `organisations.payment_terms_days` (0 = "Due on receipt"). Stored on the invoice at posting. The **issue date** is the company's today by default; Finance may set it up to 7 days back, never before the latest posted invoice's issue date (numbers stay in date order) and never in the future.
13. **Ageing** is worked out on read from each posted invoice's outstanding balance (total − allocations − WHT − VAT withheld − credit notes) and its due date in the company's time zone: Not due yet, 1–30, 31–60, 61–90 and over 90 days past due. The board's four tiles show the overdue buckets; "Not due yet" is a separate figure. Totals per client and for the company; a client statement of account (open invoices, payments, credits) on the client page.
14. **Partial payments** are normal: an allocation below the outstanding balance leaves the invoice Part paid, and the payment's receipt says "Part payment of INV-0413; ₦249,350 still due".
15. **Overpayments and credits.** Money in a payment beyond what is allocated becomes **client credit** (`client_credit_entries`, an insert-only ledger per client: overpayment, applied, refunded, reversal). Credit is applied to another open invoice of the same client by a person (an allocation whose source is the credit), or marked refunded with the date and reference of the company's own transfer (matched to a statement debit later). Credit never moves between clients.
16. **Credit notes, not voids.** A credit note names a posted invoice, credits whole lines or an amount on a line, with a reason (required) and, per line, whether its Work Units may be **billed again**; VAT and expected WHT are reversed in proportion (negative lines round half away from zero). Credit notes post at once with their own number and PDF and are emailed to the billing contacts when Finance chooses. A credit note can't take an invoice below what has already been paid against it; that part needs a refund recorded from client credit first. Drafts are discarded, never credited.
17. **Receipts.** One receipt per payment, numbered at confirmation, with a PDF (company details, Received from, amount, date received, what it paid: each invoice with the amount, WHT and VAT withheld; credit kept; "Method: bank transfer to GTBank ••••4410"). When `organisations.auto_email_receipts` is on (default), the receipt is emailed to the client's billing contacts with a copy to the invoice email as soon as the payment is confirmed, whether by the exact-match rule or by a person. A reversed allocation cancels its payment's receipt with a cancellation row (the PDF says nothing new; the receipt list shows Cancelled) and the corrected allocation issues a new receipt.
18. **Matching** (BUILD_PLAN, DATA_MODEL): every credit line of an import is scored against the company's open invoices (see "Calculation and matching design"). **Exact** (the amount equals one invoice's outstanding balance and that invoice's number, and only that number, is in the narration) is confirmed automatically by the server with the secret key, writes the payment, the allocation and the receipt, and emails it: the "done when". **Everything else waits in Suggested**, with its reason, for a person: reference only, amount net of WHT (or WHT and VAT), partial, several invoices in one transfer, and amount only. Lines with nothing to suggest are Unmatched. A person can Accept, Change (pick invoices and amounts), Keep as credit, or Ignore with a reason (not a client payment: a loan, a refund from a supplier).
19. **Invoice email.** Sent from Metalira's verified sending domain with the company's trading name as the sender ("Adebayo Facility Services via Metalira Ops"), `Reply-To` the company's invoice email and a copy to it, to every billing contact of the client (an ops contact only when the client has no billing contact, with a warning). Body: amount due, due date, the company's bank, account name and account number, "Please use INV-0412 as the transfer narration", and the PDF attached. Every send is an insert-only `invoice_sends` row (contact ids, never addresses in the audit log). Posting and sending are separate steps; "Post and send" does both with one preview.
20. **Email volume and caps.** Client billing email has its own caps (`claim_billing_email`): per company 300 a day, per client 20 a day, one reminder per invoice per day, inside a platform ceiling set from the Resend plan. On Resend Free (100 a day for everything) this ceiling is 60, so pilots need **Resend Pro**. A send over a cap is **refused, never dropped**: the screen says "Daily email limit reached. Download the PDF or send tomorrow." Automatic sends (receipts, reminders) over a cap wait for the next day's run and say so on the invoice.
21. **Reminders** (open question 12 for the cadence): on by default per client, for posted invoices with a balance, to the billing contacts: 3 days before the due date (only for terms of 14 days or more), on day 1 past due, then days 7, 14 and 30, then every 30 days, **at most 6 per invoice**. Never on a credited or settled invoice, never while the invoice or client is paused (Finance pauses with a reason, e.g. "In dispute"), never more than one email per contact a day (several overdue invoices of a client go in one reminder). Sent by the daily job; worked out on read, so a missed day doesn't send twice. Copy is plain and polite (open question 13 for tone).
22. **Statement formats.** First a **generic column mapping** for CSV and XLSX: the person maps date, narration, credit, debit (or one signed amount, or an amount with a DR/CR column), balance and reference once per company account, and the mapping is saved as that account's format. Then **one template per pilot bank** from the owner's sample exports, each a format with its fixture test (open question 14). PDF statements are not read.
23. **Strict amount parsing.** `src/lib/billing/statement-amount.ts` accepts "1,234,567.89", "1234567.8", "(1,234.00)" and "-1234" with an explicit sign or a DR/CR column, refuses anything else by row and column, and never goes through a float. XLSX cells read as numbers are taken only when they round-trip to the same text at two decimals; otherwise the row is refused with "Amount in row 14 isn't exact: export as text or CSV".
24. **De-duplicating imports** (DATA_MODEL): each line's `line_hash` covers the account, value date, signed amount, running balance, bank reference and an occurrence index for identical rows within one file, unique per company account, so two genuine equal credits on one day both survive. A file with the same SHA-256 as an earlier import is refused outright. A line whose hash already exists is skipped and counted ("38 lines were already imported on 2 Nov"); a line with the same date, amount and narration but a different balance or reference (an overlapping export from another channel) goes to **review as suspected duplicate**, never silently dropped or matched twice.
25. **Statements belong to an account.** An import names one of the company's accounts (`organisation_bank_accounts`, active or retired); if the file's header shows an account number, its last 4 must match (MLBS). A credit into a retired account still matches.
26. **Payroll debits** (Phase 5 carry). Debit lines are matched to payroll bank files: an **exact** match is a debit equal to an active batch's `total_kobo` within 10 days after the file was made, or a debit equal to one `payout_items` (or supplementary item) amount whose narration holds the item's staff ID or the batch's narration reference; it sets the items to `matched` (a new status, written only by the matching function, insert-only history in `payout_item_matches`). Anything else waits in Suggested under "Money out". A matched batch shows "Paid out on 25 Oct, matched to the statement" on the Pay step. "Mark paid outside the file" for a left-out payslip (5.4 money review L7) lands here as a payout match without a batch. Other debits (bank charges, the transfer levy, suppliers) are left for Phase 7's costs; they are listed, not matched.
27. **Backdated rate cards** (Phase 2 decision 4): once a contract has a posted invoice, a new rate card version may start back to the day after the latest period posted for that contract; before then, today or later as now. A version a posted invoice line used never changes or is cancelled (MLRC codes, as 5.3 did for pay rates).
28. **Who does what** (see "Roles and access"): ops managers and Finance draft; Finance and the owner post, send, credit, import statements and confirm matches; admins read invoices and ageing but no statement lines; hr and line managers see nothing here. No two-person rule applies to invoices in RULES or CLAUDE.md (rule 10 names payroll release and bank-detail changes), so none is added by default; open question 16 offers one for credit notes.
29. **Lira**: every new Server Action is registered; reads have summaries with counts and totals only (no narrations, no account numbers, no contact emails); drafting from unbilled work and refreshing a draft are `agent: true` writes with previews (nothing posted, nothing sent); posting, sending, credit notes, statement imports, confirming or reversing matches, applying credit, recording refunds, payout matches and settings are `agent: false`. Details per slice.

### Choices made in this plan (recommended defaults; the owner can overturn any)

None of these is a Nigerian legal rule.
- **Settlement status is worked out on read**, not stored: invoices store their lifecycle (draft, posted, discarded) and a view gives Unpaid, Part paid, Paid, Credited, Overdue (DATA_MODEL's `status` list becomes the view's; 6.2 updates DATA_MODEL). Posted rows therefore never change.
- **Payments exist only from statement lines** (one payment per confirmed credit line, `statement_line_id` unique). A cheque or a transfer not yet on a statement waits for the next import. No hand-entered payments in Phase 6.
- **Auto-confirmation runs as the system**: the server confirms exact matches with the secret key right after an import commits, recording `confirmed_by` null, `confirmation = 'auto'` and the rule version (`exact_v1`), channel `system`. A person's confirmation records them.
- **Narrations are matched on a normalised copy** (upper case, runs of spaces, slashes and dashes folded); the invoice number matches "INV-0412", "INV 0412", "INV0412", "INV-412" and "inv/0412", and never as part of a longer number ("INV-04125" is not INV-0412).
- **The unbilled value of pending timesheet days** ("Not included: 5 flagged timesheets worth ₦62,500") is an estimate at today's rate card, labelled as one, never stored.
- **Manual lines** on a draft (a one-off charge, a reimbursable) take description, quantity, unit rate, service type and WHT rate, and a reason; VAT follows the contract. Phase 7's rebillable costs and materials and Phase 8's milestones add source kinds to `invoice_line_sources`.
- **The invoice PDF** prints the company's PNG logo (an SVG logo is left out, as on payslips), legal and trading name, RC number, TIN, address, the client's legal name, address and TIN, the period and sites, lines with their source summary ("22 approved shifts, 1–31 Oct"), Subtotal, VAT 7.5%, Total due, expected WHT as a note ("If you deduct WHT: ₦11,950; please send the credit note"), the bank details as of the issue date, "Use INV-0412 as the transfer narration", and the due date. No illustration (DESIGN_SYSTEM).
- **Statement files** are kept in the private bucket with their SHA-256 for as long as the company exists (open question 15 asks the accountant how long they must be kept); lines are insert-only.

## Open questions for the owner (defaults above apply until answered)

Each has a recommended default; the plan builds the default. Questions marked **(accountant)** need the company's accountant before the first live invoice, whatever the owner chooses for the build.

1. **Invoice number format.** **Default:** `INV-0001`, continuous, starting at the setup value, never reset. Alternatives: a company prefix (`AFS-0001`) or a yearly sequence (`INV-2026-0001`). Credit notes `CN-`, receipts `RCT-`.
2. **One invoice per contract, or per client?** **Default:** per contract per billing period. Alternative: one invoice per client per period with a section per contract, allowed only when the contracts share VAT and payment terms.
3. **Fortnightly periods.** **Default:** 14-day periods from the go-live date. Alternative: half-months (1st–15th, 16th–end).
4. **Fixed-monthly billing.** **Default:** in arrears, prorated by calendar days from the go-live date and to the end date (Phase 2 decision 17, rule to be confirmed). Alternative: in advance at the start of the month, with a credit note when a contract ends early.
5. **VAT rate date and tax point (accountant).** **Default:** the rate in force on the issue date; VAT is due on the invoice as issued. Confirm, and say whether VAT is accounted on invoice or on payment for the company's VAT return.
6. **VAT on staffing pass-through and reimbursable lines (accountant).** **Default:** VAT on every line of a contract with VAT on. Should wages passed through (staffing) or reimbursed costs be outside VAT?
7. **VAT-exempt supplies and clients (accountant).** **Default:** exemption per contract with a reason printed on the invoice; no client flag. Which of the pilots' clients or services are exempt or zero-rated, and does a non-registered company (below the registration threshold) say anything on its invoices?
8. **Auto-confirming net-of-WHT payments.** **Default:** no: only exact matches are confirmed without a person (BUILD_PLAN). Alternative: also auto-confirm when the invoice number is in the narration and the amount equals the total less the expected WHT to the kobo.
9. **WHT differences (accountant).** **Default:** no tolerance: any difference from the expected WHT is flagged and goes to Suggested. Should a client deducting 5% on a 2% line be accepted and flagged, or questioned with the client first?
10. **WHT credit notes (accountant).** **Default:** an invoice counts as settled once the payment and the recorded WHT cover it; the client's credit note is tracked as awaited and listed until recorded. Should the invoice stay "Awaiting WHT credit note" instead of Paid?
11. **Ageing buckets.** **Default:** by days past due: Not due yet, 1–30, 31–60, 61–90, over 90. Alternative: by days since issue (the board's labels read either way).
12. **Reminder cadence.** **Default:** 3 days before due (terms of 14 days or more), then days 1, 7, 14 and 30 past due, then every 30 days, at most 6, on by default per client. Alternatives: off by default; or no reminder before the due date.
13. **Reminder wording.** **Default:** "INV-0412 for ₦642,312.50 was due on 30 Nov 2026. If you have paid, thank you and please ignore this. Otherwise please pay into GTBank ••••4410 (Adebayo Facility Services Ltd) with INV-0412 as the narration." The owner supplies a preferred tone or a sample.
14. **Statement formats.** **Default:** the generic column mapping first, then one template per pilot bank from the owner's sample exports. Which banks do the pilots use?
15. **Keeping statement files (accountant).** **Default:** keep the files and lines for as long as the company uses Metalira. How long must bank statements and invoices be kept?
16. **A second person for credit notes.** **Default:** none; credit notes by owner or finance with a reason, audited. Alternative: a credit note over an amount the owner sets (say ₦500,000) needs a second person from finance or the owner, as payroll does.
17. **Issue-date backdating.** **Default:** up to 7 days back, never before the latest posted invoice. Alternative: today only.
18. **Billing a period early.** **Default:** allowed with "Bill to today" and a reason; the rest of the period bills next time. Alternative: never before the period ends.
19. **Sending domain.** **Default:** Metalira's domain with the company's name and reply-to (decision 19). Later: the company verifies its own domain in Resend so invoices come from billing@company. Wanted for the pilot?
20. **Overpayments.** **Default:** held as client credit and applied by a person. Alternative: applied automatically to the client's oldest open invoice.
21. **Refunds of client credit.** **Default:** recorded by Finance with the date and reference of the company's own transfer, then matched to the statement debit. Fine?

## Calculation and matching design

### Pricing and totals (6.0, pure)

```
unbilled inputs (6.1, server)  ──►  pricing (6.0)  ──►  invoice totals (6.0)  ──►  DraftInvoice
approved billable Work Units,       rate line per day     lines rounded once,        lines, sources,
recorded jobs, fixed-monthly        via rate_key_part,    VAT once, expected WHT     totals, expected
periods, rate card versions,        quantity, amount,     per line, expected         receipts, held-out
contract terms, client tax          OT lines, prorating,  receipts, due date         units with reasons
settings, VAT version               held-out units
```

- `src/lib/billing/periods.ts`: `billingPeriods(contract, upTo)` for monthly, weekly, fortnightly and on_completion, clamped to go-live and end dates; `prorateMonth(rateKobo, daysBilled, daysInMonth)`.
- `src/lib/billing/pricing.ts`: `priceWorkUnits(units, rateCards, contract): PricedLine[]` groups by (site, rate line id, kind normal or overtime) so every line has one rate and one WHT rate; each line lists its sources.
- `src/lib/billing/totals.ts`: `invoiceTotals(lines, vat, client): InvoiceTotals` and `creditNoteTotals(...)`.
- `src/lib/billing/vat.ts`: `VAT_RATE_V1` (750 bps from 1 Jan 2026) equals RULES_NIGERIA.md (a unit test compares, as `src/lib/payroll/rule-set.ts` does).

The contract between the stages, fixed here so 6.0, 6.1, 6.4 and 6.5 can be built at the same time:

```ts
type LineSource =
  | { kind: "work_unit"; workUnitId: string; minutes: number; otMinutes: number }
  | { kind: "fixed_period"; contractId: string; from: string; to: string }   // ISO dates
  | { kind: "manual"; reason: string };
interface PricedLine {
  description: string;            // "Guard · Day shifts, 1–31 Oct 2026 · Apapa Warehouse 3"
  sourceSummary: string;          // "22 approved shifts"
  rateLineId: string | null;      // null for manual
  rateCardId: string | null;
  unit: "shift" | "hour" | "visit" | "month" | "job" | "overtime_hour" | "manual";
  quantity: string;               // "22", "1,320 min", "13 of 31 days": display only
  unitRateKobo: bigint;
  amountKobo: bigint;             // rounded once; negative only on credit notes
  vatable: boolean;
  serviceType: "services" | "management_fee" | "rent_hire" | "goods" | "other";
  whtRateBps: number;             // 0..2000
  expectedWhtKobo: bigint;        // round(amount × bps), half up (half away from zero if negative)
  sources: LineSource[];
}
interface InvoiceTotals {
  subtotalKobo: bigint; vatableKobo: bigint; vatRateBps: number; vatKobo: bigint;
  totalKobo: bigint; expectedWhtKobo: bigint; expectedVatWithheldKobo: bigint;
  expectedReceipts: { pattern: "full" | "less_wht" | "less_wht_and_vat"; amountKobo: bigint }[];
}
interface HeldOut { workUnitId: string; reason: "no_rate_line" | "no_ot_rate" | "after_contract_end" }
```

Worked check, INV-0412 (golden, Coastline, VAT on, WHT 2% on every line):
- Guard · Day, 22 shifts × ₦12,500 = ₦275,000 (WHT ₦5,500); Guard · Night, 20 shifts × ₦15,000 = ₦300,000 (WHT ₦6,000); Night overtime, 12 h × ₦1,875 = ₦22,500 (WHT ₦450).
- Subtotal ₦597,500; VAT 7.5% = ₦44,812.50; total ₦642,312.50; expected WHT ₦11,950.
- Expected receipts: ₦642,312.50 (full); ₦630,362.50 (less WHT); ₦585,550 (less WHT and VAT, a VAT-withholding client only).
- INV-0413 Marina: ₦418,000 + ₦31,350 = ₦449,350. INV-0414 Greenfield: ₦396,000 + ₦29,700 = ₦425,700; less 2% WHT ₦7,920 = ₦417,780.

### Settlement (6.5 onwards)

Per posted invoice, worked out on read by `public.invoice_balances` (security invoker view) and mirrored in `src/lib/billing/settlement.ts`:
- outstanding = total − Σ allocation amounts − Σ WHT recorded − Σ VAT withheld − Σ credit-note totals (reversing allocations count negatively).
- status: Credited (credit notes = total), Paid (outstanding 0), Part paid (0 < outstanding < total), Unpaid; Overdue when outstanding > 0 and today > due date.
- Invariants checked in SQL by the one allocation function, under row locks on the payment and every invoice it touches: Σ allocations of a payment + credit kept = the payment's amount; per invoice, allocations + WHT + VAT withheld + credit notes ≤ total; no allocation to a draft, a discarded invoice or another client's invoice (a payment from an unknown payer may be allocated to any client's invoice by a person, and the payment takes that client).

### Matching (6.5, pure)

`src/lib/billing/matching.ts`: `scoreCredit(line, openInvoices, clients): MatchProposal` with no database access; the server gathers the open invoices (number, client, outstanding, expected receipts, client names and legal names) and stores the proposal.

| Level | Rule | Outcome |
| --- | --- | --- |
| **exact** | amount = outstanding of exactly one open invoice, and that invoice's number is the only invoice number in the narration | auto-confirmed by the server; payment, allocation, receipt, receipt email |
| high | number in narration and amount = that invoice's total less expected WHT, or less WHT and VAT (VAT-withholding client); or several numbers whose outstanding (or net-of-WHT) amounts sum to the amount exactly | Suggested, one-click Accept with WHT and VAT withheld filled in |
| medium | number in narration, amount below outstanding (partial) or above (overpayment, remainder to credit) | Suggested with "Part payment. ₦249,350 stays outstanding" or "₦50,000 over: kept as credit" |
| low | no number; payer name matches one client (bank-name-match) and the amount equals an expected receipt of one of its open invoices | Suggested with "Amount and payer match INV-0414; no invoice number in the narration" |
| amount only | no number, no name; the amount equals an expected receipt of one or more open invoices | Suggested with the candidates listed; never pre-picks one when there are several |
| none | nothing above | Unmatched: pick an invoice, keep as credit (needs a client), or ignore with a reason |

Rules that keep auto-confirmation safe: it never runs on a suspected duplicate, a debit, a line already confirmed, a line whose narration names two invoice numbers, an invoice with a payment already waiting in Suggested, or an amount that two open invoices share as outstanding; it never applies credit; it uses the rule version stored on the payment. A person's Accept re-runs the same checks against current balances (a second confirmation of the same line is refused by `payments.statement_line_id` unique).

### Statement lines (6.4)

```
file (CSV / XLSX)  ──►  rows (format: column map)  ──►  parsed lines  ──►  de-dup  ──►  stored lines
private bucket,         header row, date format,        value date, narration,  file SHA-256,   new, suspected_duplicate
SHA-256, size cap       amount columns                  direction, amount,      line_hash,      (then matched, ignored)
                                                        balance, reference      overlap check
```

- `line_hash` = SHA-256 of (account id, value date, signed amount in kobo, balance in kobo or empty, bank reference or empty, occurrence index within the file for otherwise identical rows).
- The import summary: lines read, credits and debits with totals, skipped as already imported, suspected duplicates, refused rows with reasons, opening and closing balance when the file has them, and a balance check (opening + credits − debits = closing) shown as a warning when it fails.

### Ageing and reminders (6.8, pure)

`src/lib/billing/ageing.ts` (`ageingBuckets(invoices, today)`) and `src/lib/billing/reminders.ts` (`remindersDue(invoice, sentSoFar, today, policy)`), both pure and unit-tested on dates around month ends and the company's time zone.

### Tests that gate the engine

- `tests/unit/billing/golden-invoices.test.ts`: reproduces the three golden invoices (subtotal, VAT and total in kobo) from Work Units built from the golden fixture's approved shifts and `fixtures/contracts-sample.json`-style rate cards (Coastline ₦12,500 day, ₦15,000 night, overtime ₦1,875 an hour).
- Property tests (loops, as Phase 5): lines sum to the subtotal; VAT rounds once; WHT per line sums to the expected WHT; a full credit note sums to minus the invoice; settlement never goes below zero.
- `tests/unit/billing/matching.test.ts` against `fixtures/statements/` (below): every line's expected level and invoice.

## Lira groundwork (every slice)

As in Phases 2 to 5 (docs/LIRA.md): every new Server Action goes in `src/server/capabilities/registry.ts`; summary reads give counts and totals only (unbilled total by client, invoices posted this month, overdue by bucket, suggested matches waiting, statement lines unmatched; no narrations, no account numbers, no contact emails); every write that changes several rows or money has a preview used by the screen's confirm step (draft from unbilled: invoices to create with totals; refresh draft: the difference; post: number to be given, totals, due date, held-out units; send: recipients by role and count; credit note: the invoice before and after; import: lines, totals, duplicates; confirm or reverse a match: the invoice balances before and after and the receipt to be issued; apply credit; record refund; payout match: items and total). New server paths set the audit channel (`system` for auto-confirmation and reminders). `agent: true` only for drafting and refreshing drafts and pausing reminders; everything that posts, sends, credits, imports, confirms or moves a balance is `agent: false` (LIRA.md "Never releases payroll or moves money"). Each slice adds 5 to 10 manager requests with expected outcomes to `fixtures/lira/billing.md` and `fixtures/lira/collections.md` ("how much work is unbilled for Coastline?", "draft October invoices for Coastline and Marina", "which invoices are over 60 days?", "why is INV-0414 in Suggested?" answered from the stored reason, "post INV-0412" refused as a person's decision).

## Roles and access

| Thing | Read | Write |
| --- | --- | --- |
| Unbilled work, recorded jobs | owner, admin, finance, ops_manager | jobs: owner, finance, ops_manager; drafting: owner, finance, ops_manager |
| Draft invoices | owner, admin, finance, ops_manager | owner, finance, ops_manager create, refresh, edit manual lines, discard |
| Posted invoices, lines, sources, sends, PDFs | owner, admin, finance, ops_manager (no PDF download for admin) | owner, finance post and send; nobody edits after posting |
| VAT rates, billing settings, numbering, reminder policy | owner, admin, finance | owner, finance (a dated VAT version from tomorrow with a reason) |
| Credit notes | owner, admin, finance | owner, finance (with a reason) |
| Statement imports, formats, lines (narrations) | owner, finance; admin sees import summaries (counts and totals) only | owner, finance import, map formats, mark duplicates, ignore lines |
| Payments, allocations, client credit, receipts | owner, admin, finance (payer names and amounts; no narrations for admin) | owner, finance confirm, change, reverse, apply credit, record refunds; the server confirms exact matches |
| Ageing, reminders, client statement of account | owner, admin, finance; ops_manager reads a client's open invoices and ageing on the client page | owner, finance pause and resume reminders |
| WHT credit-note tracker | owner, admin, finance | owner, finance record a credit note |
| Payout matches (money out) | owner, finance; hr sees "matched" on the Pay step | owner, finance confirm; the server confirms exact matches |
| hr, line managers, workers, client approvers | nothing in billing | nothing |

## Slices (one pull request each)

### 6.0 Billing engine, VAT rates and numbering (independent, first)
- Migration `20261127100000_billing_foundations.sql`.
- `vat_rates`: organisation, `rate_bps` (0–2500), `effective_from`, `effective_to`, `source_label`, `reason`, created_by; dated, no overlaps (GiST), never updated except to close; `ensure_vat_rate(org)` copies 750 bps from 1 Jan 2026 on first use; `add_vat_rate_version(org, bps, from, reason)` (owner, finance; from tomorrow).
- `billing_sequences` (organisation, kind invoice, credit_note or receipt, `next_value`, unique per kind); written only by `private.next_billing_number(org, kind)` inside posting functions (later slices); `invoice_number_start` changes move `next_value` only while no invoice is posted.
- `billing_settings` (one row per organisation): `accountant_confirmed_at`, `accountant_note`, reminder policy (on by default, cadence days, cap 6), credit-note second-person threshold (null, open question 16).
- Pure `src/lib/billing/periods.ts`, `pricing.ts`, `totals.ts`, `vat.ts`, `numbers.ts` (format and parse `INV-0412`, the narration normaliser and number finder) as in "Calculation and matching design".
- Screen: Settings > Billing (`/app/settings/billing`): VAT in force with history and "Add a version" (preview: the rate that changes and from when), numbering (next invoice, credit-note and receipt numbers), reminder policy, and the accountant line with "Record your accountant's confirmation" (owner).
- Tests: unit (golden invoices from the engine, hourly lines rounding once, overtime with and without `ot_rate_kobo`, a rate change mid-month splitting lines, fixed-monthly proration from a go-live on the 14th, weekly and fortnightly periods across a month end, WHT per line with the facility-management split (₦900,000 at 2% and ₦100,000 at 5% = ₦23,000), credit-note rounding half away from zero, the number finder on "INV0412", "INV 412", "INV-04125" (no), the VAT template equals RULES_NIGERIA.md), RLS (isolation; owner and finance write VAT; admin reads; ops_manager, hr and line manager see nothing of settings; no overlap; a version in force can't change; `billing_sequences` has no write grant).
- **money-reviewer.**

**Accept:** `pnpm test` reproduces INV-0412, INV-0413 and INV-0414 to the kobo from the engine, and Settings > Billing shows VAT 7.5% from 1 Jan 2026 with the accountant line.

### 6.1 Unbilled queue and recorded jobs (independent of 6.0; uses the contract above)
- Migration `20261127110000_unbilled_work.sql`.
- `work_units`: `post_id`, `shift_id`, `timesheet_line_id` and `worker_id` become nullable for `kind = 'job'` only (check `work_units_shift_post_complete`); new `rate_line_key` (role, band) and `quantity` (jobs), `description`, `recorded_by`, `cancel_reason`. `record_job(org, contract, site, date, rate key, quantity, description, worker)` and `cancel_job(org, unit, reason)` (owner, finance, ops_manager; per_job contracts only, date not in the future, inside the contract's dates; MLJB codes).
- `private.unbilled_inputs(org, up_to, client_ids)` and its invoker wrapper (owner, admin, finance, ops_manager): approved billable Work Units with no standing invoice source (6.2 adds the source table; until then every billable unit is unbilled), with their post's role and band, contract terms, rate card versions and lines overlapping the units' dates, the contract's billing periods, and the count and estimated value of pending timesheet days on billable posts. No worker names in the summary read.
- `private.work_unit_billed(org, unit)` hook returning false (6.2 replaces it), called by 4.3's `reopen_timesheet_line` and `dispute_timesheet_line` (their latest versions with only that call added).
- Server `src/server/business/invoicing/unbilled.ts`: gathers inputs, prices with the engine (until 6.0 lands, against the contract types), returns per client and contract the periods, lines, totals and held-out units.
- Screen `/app/unbilled` per the Unbilled board: period picker ("Up to 31 October", "Up to 15 October", "Bill to today" with a reason), "₦3,418,500 of work not yet billed", client cards with contract, period, lines, Work Unit ranges and quantities, age dot, the held-out list ("No rate for Guard · Night on 14 Oct: 2 shifts"), "Not included: 5 flagged timesheets worth ₦62,500 until they are approved. Review them" (to `/app/timesheets`), the draft summary. "Draft N invoices" is disabled until 6.2 (says "Drafting arrives with invoices"). "Record a completed job" on a per_job contract's page. Empty state with the `no-invoices` scene in a new `unbilled-clear` slot (DESIGN_SYSTEM table, as 4.3 did with `timesheets-clear`).
- Tests: unit (grouping per contract and period, held-out reasons, the estimate of pending days), RLS (isolation, hr and line managers refused the read, a job on a manned_post contract refused, a job can't be a shift_post without its post and shift, cancelled jobs stay), Playwright: the queue for the three golden clients at 1440px and 390px, record a job.
- **money-reviewer** (pricing inputs) and **security-reviewer** (a definer read across work records and rate cards; the change to `work_units` nullability).

**Accept:** with the golden October shifts approved, `/app/unbilled` "Up to 31 October" shows Coastline ₦597,500, Marina ₦418,000 and Greenfield ₦396,000 before VAT, and a Night shift with no rate line is listed as held out, not priced.

### 6.11 Head office site for non-service staff (owner request, 27 Nov 2026; independent, wave 2)
The owner wants staff who don't work at a client's site (HR, finance, the operations manager, admin) mapped to the company's own **Head office** as their site. Today every site belongs to a client (`sites.client_id not null`), so there is nowhere to put them.
- Migration `20261127090000_head_office.sql`.
- `sites.kind` (`client` default, `office`); an office site has `client_id` null and a client site must have one (check constraint). Every company gets one office site named "Head office" (backfilled for existing companies, created with each new company); more offices (branches) can be added the same way. Its address, geofence and checkpoints are edited like any site (SITE_EDITORS: owner, admin, ops_manager), on a new **Settings > Company > Head office** card rather than under a client.
- Office sites are never a client's site: they are left out of the Clients pages, contracts, posts, rate cards, the unbilled queue and invoices (no posts, so no Work Units are made there). A guard against a contract, post or headcount on an office site (MLHO codes).
- Mapping: `save_worker_mapping` and 6.11's change to U.3's **Map to site and project** accept an office site; projects can't be chosen for it (office sites have no client, so no projects). HR, owner and admin map people there, as today.
- Attendance: staff mapped to Head office can clock in there with the existing no-shift clock-in and its geofence check; there is no office roster in this slice (an office-hours roster is a later option). Their days show in Timesheets as non-billable.
- Payroll and Phase 7: a worker's site of record marks their pay as **overhead** rather than a client site's labour cost; 6.11 only stores and shows it ("Head office · overhead"), and Phase 7's overhead allocation reads it.
- Managers who are also on payroll (U.4's "Also paid through payroll") get a worker record, so they can be mapped to Head office like anyone else. Managers who aren't on payroll have no worker record and aren't mapped.
- Tests: unit (office vs client site rules), RLS (an office site with a client refused, a client site without one refused, a contract or post on an office site refused, office sites absent from the unbilled read and client lists, isolation for the new column), Playwright: HR bulk-maps HR, both Finance and the ops manager to Head office at 1440px, and the Head office card at 390px.
- **security-reviewer** (a nullability change on `sites` and every read that assumed a client) and **money-reviewer** (office sites can never reach an invoice).

- **Rule for 6.1, 6.2 and later (money review of 6.11):** every new Phase 6 table with a `site_id` (unbilled entries, recorded jobs, invoice lines) gets a `refuse_office_site` trigger, and the unbilled read filters `sites.kind = 'client'`; office sites never reach an invoice.

**Accept:** HR selects the finance, HR and operations staff, uses **Map to site and project** with "Head office", and each person's page shows "Head office"; the unbilled queue and invoices never list Head office, and a contract can't be created on it.

### 6.4 Bank statement import (independent of 6.0 to 6.3; wave 1)
- Migration `20261127120000_bank_statements.sql`.
- Private bucket `bank-statements` (CSV and XLSX by magic bytes, 10 MB), path `{organisation_id}/{account_id}/{import_id}.{ext}`, no Storage policy (the 5.4 pattern): the browser uploads through a signed upload token for one path; the server checks the bytes and records it with the secret key.
- `statement_formats` (organisation, account, name, kind generic or a bank template id, `column_map jsonb` with a Zod shape: header row, date column and format, narration, credit and debit or signed amount or amount with DR/CR, balance, reference; created_by). `bank_statement_imports` (account, file path, SHA-256 unique per account, size, format id, period from and to, counts and totals, status processing, done, refused; imported_by). `bank_statement_lines` (import, account, position, value_date, narration, direction credit or debit, amount, balance, bank_reference, occurrence, `line_hash` unique per account, status new, suspected_duplicate, matched, ignored; `duplicate_of_line_id`; status moves only through functions; insert-only otherwise; the row audit drops narration).
- `src/lib/billing/statement-amount.ts` (decision 23), `statement-parse.ts` (rows to lines with a format; dates "30/10/2026", "30-Oct-2026", "2026-10-30", Excel serial dates), `statement-dedupe.ts`; the generic mapping and its preview; bank templates registry `src/server/business/collections/statement-formats/` (generic first; one module per pilot bank when the samples arrive).
- Functions: `start_statement_upload`, `record_statement_import(org, account, path, sha256, format, lines jsonb)` (secret key, naming the user; one transaction; refuses a repeated file SHA-256 (MLBS), a last-4 mismatch, more than 20,000 lines; skips existing hashes; flags suspected duplicates), `resolve_suspected_duplicate(org, line, keep or ignore, reason)`, `ignore_statement_line(org, line, reason)` (owner, finance).
- Screen `/app/collections/statements`: "Import bank statement" (account picker, file, format picker or "Map the columns" with a 10-row preview), the import summary (decision 24's counts, balance check), the import list, lines by import with status, suspected duplicates to resolve.
- Fixtures: `fixtures/statements/generic-october-2026.csv` and `.xlsx` (synthetic, golden clients, see "Fixtures" below) and `fixtures/statements/generic-october-2026.expected.json` (each line: parsed values in kobo, expected status after import, expected match level and invoice for 6.5, expected payout match for 6.9); `fixtures/statements/overlap-november-2026.csv` repeating three October lines and one same-day equal credit.
- Tests: unit (every accepted and refused amount form, XLSX floats that don't round-trip refused, dates, DR/CR, occurrence index for two equal same-day credits, the overlap fixture: 3 skipped, 1 suspected duplicate, formula-injection characters in narrations kept as text), RLS (isolation, admin sees import counts but no lines, hr and ops_manager nothing, lines insert-only, the bucket refuses every signed-in role, another company's path), a log test (no narration or account number in any log through an import and a refusal), Playwright: import the October CSV with the generic mapping at 1440px and 390px.
- **money-reviewer** (amount parsing) and **security-reviewer** (file upload, a private bucket, personal data in narrations).

**Accept:** importing `generic-october-2026.csv` reads every line with amounts exact to the kobo; importing it again is refused; importing the overlap file skips the three repeats and holds the near-duplicate for review.

### 6.2 Invoice drafts and posting (after 6.0 and 6.1)
- Migration `20261127130000_invoices.sql`.
- `invoices`: client, contract, period from and to, lifecycle (draft, posted, discarded), `number` and `number_value` (null until posted; unique per organisation), issue_date, due_date, terms_days, `organisation_bank_account_id` (as of the issue date, set at posting), VAT rate id and bps, subtotal, vatable, VAT, total, expected WHT, expected VAT withheld, currency, `vat_exempt_reason`, snapshots (company name, RC, TIN, address; client legal name, address, TIN; contract reference and name), `inputs_sha256`, created_by, posted_by, posted_at, discarded_by, discard_reason. `invoice_lines` (position, description, source summary, rate line and rate card ids, unit, quantity text, unit rate, amount, vatable, service type, WHT bps, expected WHT, kind work, overtime, fixed, job or manual). `invoice_line_sources` (line, work unit or fixed period or manual; `stands`; exclusion constraint on a work unit while standing; a fixed period's day range can't overlap another standing one for the contract).
- Functions: `create_invoice_drafts(org, picks jsonb, up_to)` (owner, finance, ops_manager; the server computed lines with the engine; SQL re-checks every source is approved, billable, unbilled and the lines' invariants: lines sum to subtotal, VAT and totals consistent with the stored bps), `refresh_invoice_draft`, `add_invoice_manual_line` / `remove_invoice_manual_line` (draft only, reason), `discard_invoice_draft(reason)` (sources stop standing), `post_invoice(org, invoice, issue_date)` (owner, finance; trusted session; re-gathers inputs on the server and refuses a changed hash; refuses no company TIN, no billing or ops contact, no bank account in force on the issue date; takes the next number; sets due date; ENABLE ALWAYS guards then freeze the invoice, lines and sources).
- Replace `private.work_unit_billed`: true while the unit is a standing source of a posted invoice. Rate-card backdating floor (decision 27) in `add_rate_card_version` (its latest version with that change).
- Screens: `/app/unbilled` "Draft N invoices" (preview: invoices to create, subtotal, VAT, total); `/app/invoices` (list: number or Draft, client, period, total, outstanding, due, status chip; filters; the `no-invoices` illustration when empty; CSV export as U.2); `/app/invoices/[id]` (the invoice laid out as on the Simulate board, held-out units, Refresh draft, Add a line, Discard, "Post invoice" with its preview: "INV-0412 will be issued today, due 30 Nov 2026, ₦642,312.50"). DATA_MODEL "Billing" updated to the as-built tables.
- Tests: unit (canonical hash ignores key order; manual line rounding), RLS (isolation for every table; ops_manager drafts but can't post; a work unit on two standing drafts refused; a posted invoice, its lines and sources refused for every role and the database owner, triggers off or in replica mode; numbers gap-free under two concurrent postings and after a refused one; a stale draft refused; reopening a billed timesheet day refused; a rate card backdated into a posted period refused, into an unposted one allowed), Playwright: draft from unbilled, add a manual line, post INV-0412 at 1440px and 390px.
- **money-reviewer** and **security-reviewer.**

**Accept:** Finance drafts the three October invoices from the queue, posts Coastline as INV-0412 for ₦642,312.50, the queue no longer shows its Work Units, and reopening one of its timesheet days is refused.

### 6.9 Payroll payout debits (after 6.4; built beside 6.2)
- Migration `20261127140000_payout_matching.sql`.
- `payout_items.status` and `payout_supplement_items.status` gain `matched`; `payout_item_matches` (insert-only: item or supplementary item, statement line, amount, confirmation auto or person, confirmed_by, reversed_by_id, reason). 5.4's guards (their latest versions) allow pending -> matched only from `confirm_payout_match` and matched -> pending only from `reverse_payout_match` with a reason.
- `src/lib/billing/payout-matching.ts` (decision 26), the server step after an import commits, Suggested "Money out" tab, "Mark paid outside the file" (5.4 money review L7) for a left-out payslip: a match without a batch, so 5.7c's supplementary file can't pay it again.
- Screens: `/app/collections` gains the Money out tab (debits matched, suggested, left); the Pay step on `/app/payroll/[id]` shows "Matched to the statement on 26 Oct" per batch and item.
- Tests: unit (batch total within 10 days, per-item staff ID in narration, two batches with equal totals never auto), RLS (isolation, hr reads but can't confirm, a debit matched twice refused, a credit can't match a payout), Playwright: import the October statement, see the golden payroll debit of ₦745,250 matched to the batch.
- **money-reviewer** and **security-reviewer** (worker names and account details in narrations).

**Accept:** the sample statement's ₦745,250 salary debit is matched to the October batch without a person and the Pay step says so; a debit with the same amount as two batches waits in Suggested.

### 6.3 Invoice PDF and email (after 6.2)
- Migration `20261127150000_invoice_documents.sql`.
- `invoice_documents` (invoice or credit note, storage path, SHA-256, size, made_at; insert-only, newest row is the document) and the private bucket `invoices` (PDF, 5 MB) at `{organisation_id}/{invoice_id}.pdf`, no Storage policy; `open_invoice_document` (owner, finance, ops_manager) audits the download and the server signs a 60-second URL. `invoice_sends` (insert-only: invoice, kind invoice, credit_note, receipt or reminder, contact ids, cc invoice email, status sent, refused_cap, failed with the error name, Resend message id, sent_by or system).
- `src/server/business/invoicing/invoice-pdf.tsx` (the Simulate board's layout and "Choices made" above; Inter embedded; PNG logo only). The bank details come from `org_bank_account_as_of(org, issue_date)`, decrypted with `pii.ts`, refused on a decrypt failure or last-4 mismatch (MLIN, by account), held only in memory, the buffer zeroed after rendering.
- `claim_billing_email(org, client, kind)` with decision 20's caps; `sendInvoice(org, invoice)` (React Email template, PDF attached, reply-to and copy); "Resend" sends again (a new row). The PDF is made at posting (inside `after()`, idempotent; "Make the PDF" when it failed).
- Screens: `/app/invoices/[id]`: Download PDF, "Send to Coastline (2 billing contacts)" with its preview, "Post and send", the sends list (when, to which contacts by role, status).
- Tests: unit (PDF text for INV-0412: totals, "Use INV-0412 as the transfer narration", account masked nowhere but printed in full once; an SVG logo left out), RLS (bucket refuses every signed-in role; caps refuse not drop; hr and line manager refused), a log test (no account number in logs or `audit_log` through a PDF and a send), Playwright: post and send INV-0412, the test mail sink receives one email with the PDF attached.
- **money-reviewer** and **security-reviewer** (decrypted account number, email with attachments).

**Accept:** posting INV-0412 makes a PDF with the company's account and "Use INV-0412 as the transfer narration", and "Send" emails it to the client's billing contacts with a copy to the invoice email; an over-cap send is refused with the message.

### 6.5 Matching, payments and the suggested queue (after 6.2 and 6.4)
- Migration `20261127160000_payments_matching.sql`.
- `payments` (client, `statement_line_id` unique, amount = the line's amount, value date, confirmation auto or person, rule version, confirmed_by, `reversed` via reversal rows only), `payment_allocations` (payment, invoice, amount, wht_amount, vat_withheld_amount, `reverses_allocation_id`, reason, actor; insert-only), `client_credit_entries` (client, payment, kind overpayment, applied, refunded, reversal, amount signed; insert-only), `match_proposals` (statement line, level, candidate invoices with amounts, reason text, rule version, made_at; superseded by a newer proposal, never edited), view `invoice_balances`.
- `src/lib/billing/matching.ts` and `settlement.ts`; server step after each import commits: score every new credit line, store proposals, auto-confirm exact matches with the secret key (`confirm_payment(..., auto)`), then emit 6.6's receipt hook (a no-op until 6.6).
- Functions: `confirm_payment(org, line, allocations jsonb, credit_kept)` (owner, finance; the secret key for auto), `reverse_allocation(org, allocation, reason)` (owner, finance; puts the money back to the payment's unallocated part), `keep_as_credit`, `apply_client_credit(org, client, invoice, amount)`. All lock the payment and invoice rows and enforce the settlement invariants.
- `clients.deducts_wht` learning flag (decision 11) on the client page.
- Screen `/app/collections` per the Collections board: header (account in force masked, "Import bank statement"), ageing tiles (placeholder figures until 6.8 fills them from `invoice_balances`, or built here if cheap), tabs Unmatched · Suggested · Matched with counts, rows (amount, payer, "GTBank statement · imported 31 Oct · value date 30 Oct", match label, invoice, reason), Accept match, Change (invoice picker with outstanding amounts, amount, WHT, VAT withheld, credit kept, preview of balances before and after), Keep as credit, Ignore with a reason; the `all-collected` illustration when nothing is outstanding; client page "Invoices" tab with balances.
- Tests: unit (`matching.test.ts` against the fixture's expected file: INV-0412 exact; INV-0414 high net of WHT; INV-0413 medium partial; the unknown payer none; two invoices sharing an outstanding amount never auto; a narration naming two numbers never auto), RLS (isolation; allocations above the payment or the invoice refused; a second payment for a line refused; reversal rows only; admin reads payments without narrations; auto-confirm refused to signed-in users), Playwright: import the October statement and see INV-0412 under Matched without a click and INV-0414 under Suggested; accept INV-0414 with WHT ₦7,920.
- **money-reviewer** and **security-reviewer.**

**Accept:** importing the sample statement pays INV-0412 with nobody touching it, and the net-of-WHT, partial and amount-only lines wait in Suggested with their reasons; accepting INV-0414 records ₦7,920 WHT and leaves it Paid.

### 6.6 Receipts (after 6.3 and 6.5)
- Migration `20261127170000_receipts.sql`.
- `receipts` (payment, number and number_value unique per organisation, issued_at, PDF path and SHA-256; insert-only) and `receipt_cancellations` (receipt, reason, actor, replaced_by receipt). Receipt numbers from `billing_sequences` inside `confirm_payment`'s transaction (6.5's function, its latest version with the receipt row added); `reverse_allocation` cancels the payment's receipt and the next confirmation issues a new one.
- `src/server/business/collections/receipt-pdf.tsx` and the receipt email (decision 17; `auto_email_receipts`; through 6.3's caps and `invoice_sends` kind receipt), run in `after()` once the confirmation commits, idempotent, retried by the daily job for any receipt without a sent row.
- Screens: receipts listed on the payment and invoice pages with Download and "Send again"; `/app/collections` Matched rows show "Receipt RCT-0001 emailed".
- Tests: unit (the receipt for a part payment and a net-of-WHT payment says what it paid), RLS (receipts insert-only; numbers gap-free; a cancelled receipt stays), Playwright and the **done-when test** `tests/rls/collections-done-when.test.ts` plus `tests/e2e/collections-done-when.spec.ts`: seed the golden October work and invoices, post INV-0412, import `generic-october-2026.csv` as Finance, and with no further action INV-0412 is Paid, RCT-0001 exists and the mail sink holds its email with the PDF; INV-0414 and INV-0413 sit in Suggested.
- **money-reviewer** and **security-reviewer.**

**Accept:** the BUILD_PLAN "done when": the sample statement's exact match pays INV-0412 and emails receipt RCT-0001 with nobody touching it; the fuzzy matches wait in Suggested.

### 6.7 Credit notes, client credit and the WHT tracker (after 6.5; beside 6.6 and 6.8)
- Migration `20261127180000_credit_notes.sql`.
- `credit_notes` (invoice, number, issue date, reason, totals: amount, VAT, expected WHT, signed negative by kind; posted at once) and `credit_note_lines` (invoice line, amount, `bill_again`), with `invoice_line_sources.stands` set false only through `post_credit_note` for lines credited in full with bill again. `wht_credit_notes` (allocation or allocations, client, credit-note number and date, amount, optional scan in a private bucket `billing-evidence` with magic-byte checks, recorded_by; insert-only, voided by a row with a reason). Refunds from client credit (`record_credit_refund`: date, reference, amount; later matched to a debit through 6.5's queue).
- Functions: `post_credit_note(org, invoice, lines jsonb, reason)` (owner, finance; refuses crediting below what was paid, MLCX), `record_wht_credit_note`, `record_credit_refund`.
- Screens: "Credit this invoice" on `/app/invoices/[id]` (whole invoice or chosen lines, bill again, reason; preview: the invoice before and after and the Work Units freed); credit notes in the invoice list; the WHT tracker per client and for the company (`/app/collections/wht`: deducted, credit notes received, awaited, by month and client); client credit on the client page with Apply and Refund.
- Tests: unit (a full credit note mirrors the invoice to the kobo with half-away-from-zero rounding; proportional VAT), RLS (insert-only, MLCX, a credited line's Work Units unbilled again only with bill again, timesheet reopen allowed again after), Playwright: credit a line and bill it again, record a WHT credit note.
- **money-reviewer** and **security-reviewer** (evidence bucket).

**Accept:** crediting a Coastline line with "bill again" puts its Work Units back in the unbilled queue, the invoice's balance falls by the line plus its VAT, and Greenfield's ₦7,920 WHT shows as awaiting a credit note until it is recorded.

### 6.8 Ageing and reminders (after 6.3 and 6.5; beside 6.6 and 6.7)
- Migration `20261127190000_ageing_reminders.sql`.
- `reminder_pauses` (client or invoice, reason, paused_by, resumed_at by a new row; insert-only). Reminders sent are 6.3's `invoice_sends` rows of kind reminder; due ones are worked out on read (decision 21).
- `/api/cron/billing` (daily, after checking Vercel Hobby's cron limit; otherwise a step of `/api/cron/contract-documents`): sends due reminders inside the caps, one email per contact a day grouping a client's overdue invoices, and retries receipts without a sent row.
- Screens: `/app/collections` ageing tiles from `invoice_balances` (Not due yet; 1–30, 31–60, 61–90, over 90 days past due); `/app/collections/ageing` by client with drill-down; "Overdue invoices" tile on Home (Main board); Pause and Resume reminders on the client and invoice; the client's statement of account (PDF download, owner and finance) on the client page.
- Tests: unit (buckets at month ends and in the company's time zone; the reminder schedule: before-due only for 14-day terms or more, the 6 cap, pauses, a missed day not sending twice, grouping per contact), RLS (pauses insert-only; ops_manager reads a client's ageing), a cron test with a fixed clock, Playwright: the ageing tiles for the golden invoices on 15 Dec 2026, pause a client.
- **money-reviewer** (ageing sums) and **security-reviewer** (the cron route, outbound email volume).

**Accept:** on 15 Dec 2026 the ageing shows INV-0413's ₦249,350 balance 15 days past due in 1–30, the daily job sends one reminder to Marina's billing contact and none to a paused client, and a seventh reminder is never sent.

### 6.10 Phase 6 review fix-up (after 6.6, 6.7 and 6.8)
- Migration `20261127200000_billing_fixup.sql` if the reviews need one.
- A whole-phase money review and security review (Phase 5 needed 5.8 and 5.10 for the same), fixes, the accountant's answers if they have arrived (open questions 5 to 7, 9, 10 and 15), the first pilot bank templates if the samples have arrived, and the sign-off with its live-site checklist.
- **money-reviewer** and **security-reviewer** on the whole phase.

**Accept:** both reviews have no high or medium findings open and every "Phase 6 done when" item is met.

### Fixtures (synthetic, added in 6.4 and used through 6.10)
`fixtures/statements/generic-october-2026.csv` (and the same lines as `.xlsx`), for the golden company with GTBank ••••4410, invoice numbers starting at 412:

| # | Value date | Narration | Credit | Debit | Expected |
| --- | --- | --- | --- | --- | --- |
| 1 | 30 Oct 2026 | TRF/COASTLINE LOGISTICS NIG LTD/INV-0412 | 642,312.50 | | exact: INV-0412 paid, receipt emailed |
| 2 | 31 Oct 2026 | GREENFIELD ESTATES LTD INV 0414 OCT | 417,780.00 | | high: INV-0414 less 2% WHT ₦7,920 |
| 3 | 2 Nov 2026 | MARINA HOLDINGS PART PYMT INV0413 | 200,000.00 | | medium: part payment, ₦249,350 outstanding |
| 4 | 2 Nov 2026 | ADEBOLA T. PAYMENT | 450,000.00 | | none: unmatched |
| 5 | 3 Nov 2026 | POS SETTLEMENT 0031 | 50,000.00 | | none (and its identical twin, row 6, both kept) |
| 6 | 3 Nov 2026 | POS SETTLEMENT 0031 | 50,000.00 | | none (occurrence 2) |
| 7 | 23 Oct 2026 | BULK TRF SALARY OCT 2026 AFS | | 745,250.00 | payout: the October batch |
| 8 | 31 Oct 2026 | SMS ALERT CHARGES | | 1,500.00 | not matched (a cost for Phase 7) |

Plus `fixtures/statements/overlap-november-2026.csv` (rows 1, 2 and 4 again, and one near-duplicate of row 3 with a different balance) and `generic-october-2026.expected.json`. Names, numbers and accounts are made up. A pilot bank's real-format sample, with fake data, becomes `fixtures/statements/<bank>-sample.csv` with its own expected file when it arrives.

## Order and waves

```
6.0 engine, VAT, numbering ──┐
                             ├── 6.2 drafts and posting ──┬── 6.3 PDF and email ──┬── 6.6 receipts ─────────┐
6.1 unbilled queue, jobs ────┘                            │                       ├── 6.8 ageing, reminders ├── 6.10 fix-up, sign-off
                                                          └───────┬── 6.5 matching, payments ─┴── 6.7 credit notes ──────┘
6.4 statement import ─────────────────────────────────────────────┤
                                                                  └── 6.9 payout debits (from 6.4; beside 6.2)
6.11 head office site (independent; wave 2, before 6.2 merges so drafts never see office sites)
```

At most three agents at once:
- **Wave 1:** 6.0, 6.1 and 6.4, in parallel (6.1 against the engine contract in "Calculation and matching design"; 6.4 needs nothing new).
- **Wave 2:** 6.2 from 6.1's branch with 6.0 merged in, 6.9 from 6.4's branch, and 6.11 head office from `main` (it merges before 6.2).
- **Wave 3:** 6.3 from 6.2's branch, and 6.5 from 6.2's branch with 6.4 merged in.
- **Wave 4:** 6.6 (from 6.5 with 6.3 merged in), 6.7 (from 6.5) and 6.8 (from 6.3 with 6.5 merged in), in parallel; merged in migration order.
- **Wave 5:** 6.10, the review fix-up and sign-off.

Migrations, after `20261122300000_self_onboarding.sql` (the latest on `main`), with 6.11 head office built first as `20261127090000` (owner, 27 Nov): `20261127100000` (6.0), `20261127110000` (6.1), `20261127120000` (6.4), `20261127130000` (6.2), `20261127140000` (6.9), `20261127150000` (6.3), `20261127160000` (6.5), `20261127170000` (6.6), `20261127180000` (6.7), `20261127190000` (6.8), `20261127200000` (6.10). A slice whose migration would land on `main` after a later-numbered one takes the next free slot instead (as 5.4 did).

Reviews: **money-reviewer** on every slice (6.0 to 6.10). **security-reviewer** on 6.1 to 6.10 (definer reads of work records, a nullability change on `work_units`, file uploads, private buckets, decrypted account numbers in PDFs and emails, narrations naming workers, the cron route and outbound email) and once on the whole phase in 6.10.

New buckets: `bank-statements`, `invoices` (invoice, credit-note and receipt PDFs) and `billing-evidence` (WHT credit-note scans). At most one new cron (`/api/cron/billing`).

### Estimated time (at the Phase 5 pace)

Phase 5 was planned at 18 to 21.5 hours for 8 slices and took more in practice: its five planned waves were followed by three more (5.8 review fix-up; 5.9a to 5.9c for the tax adviser's answers; 5.10 round-2 fix-up), each slice ran two or three review rounds, and fix-ups after CI and merges with `main` added time. Phase 6 has the money-reviewer on every slice and the security-reviewer on all but 6.0. Sizes: M as 5.3, 5.5 or 5.6; L as 5.2 or 5.4.

| Wave | Slices | Size | Runs | Time |
| --- | --- | --- | --- | --- |
| 1 | 6.0 engine, VAT, numbering · 6.1 unbilled queue and jobs · 6.4 statement import | M · M · L | in parallel | 4 to 5 h |
| 2 | 6.2 drafts and posting · 6.9 payout debits · 6.11 head office | L · M · S | in parallel | 4 to 5 h |
| 3 | 6.3 PDF and email · 6.5 matching and payments | M · L | in parallel | 4 to 5 h |
| 4 | 6.6 receipts · 6.7 credit notes · 6.8 ageing and reminders | M · M · M | in parallel | 3.5 to 4.5 h |
| 5 | 6.10 review fix-up | M | alone | 2.5 to 3.5 h |
| | Sign-off and live-site checklist | | | 0.5 h |
| | **Total** | | | **18.5 to 23.5 h** |

Starting each wave from the previous slice's open branch (the build-speed rule) overlaps the waves by about an hour each, bringing the plan to about **17 to 21 hours** of continuous running. **In reality expect more, about 24 to 30 hours**, as in Phase 5: review rounds with fixes on every money slice, CI reruns, merge conflicts in `src/types/db.ts` and the capability registry, and a second fix-up wave when the accountant's answers or the pilot banks' statement samples arrive. Waves 2, 3 and 5 hold the critical path (6.2, then 6.5, then 6.10), so more agents would not shorten them. The risks that stretch it: real statement exports that don't fit the generic mapping (pilot samples late), the accountant changing VAT or WHT handling after 6.0, PDF rendering of the ₦ sign and long client names at 390px-friendly sizes, Resend limits in e2e, and the local database stack failing.

## Illustrations
- `no-invoices` (160) on the empty Invoices list (6.2), `unbilled-clear` (160, new slot reusing the `no-invoices` scene) on `/app/unbilled` with nothing to bill (6.1), and `all-collected` (160) on Collections with nothing outstanding (6.5). The scenes are drawn; 6.1 adds the slot row to DESIGN_SYSTEM.md. Never on invoices, receipts or PDFs.

## Phase 6 done when
- The BUILD_PLAN item: importing the sample statement pays INV-0412 by its exact match (amount and invoice number) and emails receipt RCT-0001 with nobody touching it; the net-of-WHT, partial and amount-only lines wait in Suggested (6.6's done-when tests, in CI and on the Vercel preview).
- The engine reproduces the golden fixture's three invoices to the kobo, and posting them through the database gives the same totals.
- Work Units are priced from the rate card version in force on their date through `rate_key_part`, billed at most once, and locked once billed.
- Posted invoices, credit notes, receipts, payments and allocations can't be edited or deleted by anyone; corrections are credit notes and reversal rows. Numbers are gap-free.
- Statement imports parse amounts exactly, refuse a repeated file and never import or match a line twice.
- Payroll payout debits are matched to their bank files.
- Every Phase 6 table is in the isolation test; every Server Action is in the capability registry, every money write has a preview, and posting, sending, crediting and confirming are `agent: false`.
- `/app/unbilled`, `/app/invoices`, `/app/collections` and its sub-pages, and Settings > Billing work at 390px and 1440px.
- VAT and WHT show the accountant line until the owner records the accountant's confirmation.

## Needed from the owner

Each item: what, why, format, and the wave that needs it. Items for later waves can arrive while earlier waves run; the plan builds the defaults meanwhile.

**Before wave 1 (needed to start)**
1. **Go-ahead and merge approval for Phase 6** (memory rule: per-phase merge approval before build workflows). A message saying so.
2. **Answers to the open questions you have a view on**, especially 1 (number format), 2 (per contract or per client), 3 (fortnightly periods) and 4 (fixed-monthly in arrears). A reply listing the numbers; silence means the defaults.

**By wave 1 (6.4 statement import)**
3. **A sample bank statement export from each pilot's bank** (carried from Phase 5): the file exactly as the bank's internet banking exports it (CSV and, if offered, XLSX), with real column layout and headers but fake or redacted names, narrations, amounts and account numbers; ideally one month with a few client transfers, a salary bulk debit and bank charges, and a second export overlapping the first by a few days. Why: the generic mapping is built first, but each bank's template, its date format and its DR/CR convention can only be tested against a real layout. Name the bank on each file.
4. **Per-bank narration conventions the pilots know**: how a client's transfer narration appears on the statement at each bank (does "INV-0412" survive, is it cut to 30 characters, does the sender's name come first), and how a bulk salary upload appears (one debit or one per worker). A short note per bank, by wave 1 (it sets the matcher's normaliser in 6.0 and 6.5).

**By wave 2 (6.2 posting)**
- **Head office address and location (6.11)**: the street address, and either the GPS point or a pin on the map for the geofence, so office staff can clock in there. Also say whether you have branch offices to add as more office sites. A short note by wave 2.
5. **The company's VAT registration and TIN details for invoices**: the TIN as printed on the FIRS/NRS certificate, whether the company is VAT registered (and from when), RC number, registered address and the legal name exactly as it should print. Entered in Settings > Company; posting is refused without a TIN. A screenshot or text.
6. **Default payment terms** (30 days today; 14 days or on receipt are the other setup options), and any client with different terms. A reply.
7. **Invoice numbering preference** (open question 1) and the **first number** for the live company (continue from the company's current invoice book, for example 412). A reply.
8. **Test client email addresses**: 3 to 5 inboxes you control, to stand in for client billing contacts on the preview and in the live check (real clients must never get test invoices). Addresses in a reply; they go on test clients only.

**By wave 3 (6.3 PDF and email)**
9. **The logo and brand on invoices**: setup already stores a logo, but the PDF can only use a PNG (an SVG is left out, as on payslips). A PNG, at least 400 px wide, transparent background, under 1 MB, uploaded in Settings > Company.
10. **Resend Pro** before any real invoice is sent: invoices, receipts and reminders to clients on top of payroll notices will pass Resend Free's 100 emails a day (decision 20). Subscribe in the Resend dashboard ($20 a month per BUILD_PLAN "Running costs"; confirm the current price); tell us when it is on so the platform ceiling is raised.
11. **Sending domain** (open question 19): fine with Metalira's domain and your reply-to for the pilot, or do you want invoices from your own domain (needs DNS records added at your domain host). A reply.

**By wave 4 (6.6 to 6.8)**
12. **Reminder wording or tone** (open question 13): a sample reminder you'd send today, or "use the default". Plus the cadence (open question 12). A reply or a pasted email.
13. **Accountant confirmation of VAT and WHT handling** (open questions 5, 6, 7, 9, 10 and 15): the VAT rate date and tax point; VAT on pass-through and reimbursable lines; exempt supplies and clients; WHT differences; when an invoice with WHT counts as settled; how long statements and invoices must be kept. Ideally before wave 4, needed before the first live invoice; recorded in Settings > Billing with "Record your accountant's confirmation". The accountant's written answers, as the tax adviser gave for payroll.

**Before the pilot (after wave 5)**
14. **Supabase Pro** before the first pilot (carried from Phase 5): invoice, credit-note and receipt PDFs, statement files and WHT credit-note scans join selfies, payslips and bank files in storage, and the Free plan's storage and pausing won't hold a live month. Upgrade in the Supabase dashboard.
15. **Vercel Pro** before any paid pilot (BUILD_PLAN "Running costs"), and a check of Hobby's cron limit if 6.8 adds `/api/cron/billing` before then.
16. **The live-site check** in 6.10's sign-off, as Finance, the owner and an ops manager on a laptop with the test clients.

## Carried forward

From earlier phases, closed in this phase:
- Price Work Units from the rate card in force on their date through `private.rate_key_part`, never from `contract_changes` (Phases 2 and 4): 6.0, 6.1.
- WHT per invoice line on the pre-VAT amount, split by rate-card version; matching accepts the full amount, less WHT, and less WHT and VAT; learn `clients.deducts_wht` from payments; the WHT credit-note tracker; warn when the organisation has no TIN (RULES_NIGERIA "Phase 6 implications", Phase 2 answers 10 to 12): 6.0, 6.2, 6.5, 6.7.
- Decrypt the company account from `org_bank_account_as_of` and refuse a decrypt failure or last-4 mismatch before printing it (2.3): 6.3.
- Fixed-monthly billing from the go-live date, prorated by calendar days (Phase 2 decision 17): 6.0, with open question 4.
- Backdated rate-card versions, decided alongside posted invoices (Phase 2 decision 4): 6.2.
- Match payout debits from bank statements to `payout_items` and supplementary items, status matched (Phase 5): 6.9.
- "Mark paid outside the file" for a left-out payslip (5.4 money review L7): 6.9.
- The golden fixture's `invoices` part (Phase 5: "The `invoices` part is Phase 6"): 6.0 and 6.2.
- A sample bank statement export from each pilot (Phase 5 "Needed from the owner"): owner item 3.

Still open for later phases:
- Phase 7: revenue counts posted invoices; actual labour cost per Work Unit and site from posted payslips; bank charges, the transfer levy and supplier debits from statements as costs; rebillable costs and materials as new `invoice_line_sources` kinds on the next draft.
- Phase 8: milestone Work Units from approved phase reviews (the `job`-style nullable columns from 6.1), special project overtime multipliers.
- Phase 9: Metalira's own subscription invoices and Monnify (separate tables, DATA_MODEL "Metalira subscription billing"); whether VAT applies to the subscription (tax adviser).
- Invoices from the company's own email domain (open question 19), a client portal or approver sign-off of timesheets before billing ("Client approver (later)"), and online pay links (superseded for now by the bank-only model).
- Each pilot bank's statement template, if the samples arrive after 6.10.
- From Phase 5, unchanged: the residual window on payroll approval re-checks; a leaver's leave corrections by hand; the 2027 holidays and state holidays in the official calendar; an integration test of a holiday pay rate other than 1.0×; refusing payroll release while setup is unfinished; Unicode hardening of inbox and query text; hiding manager user ids from workers; a crew group photo viewer; replacing a past-day night shift; the HR file's timesheet-exceptions placeholder; a manager inbox so notices to Finance and HR don't spend email (more pressing now that billing shares the email budget); leave attachments; the Phase 2 and 3 low hardening follow-ups.

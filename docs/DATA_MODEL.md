# Data model

Every table below has `id uuid primary key default gen_random_uuid()`, `organisation_id uuid not null references organisations` (except `organisations` and `profiles`), `created_at`, `created_by`, and RLS enabled. Money columns are `bigint` kobo with a sibling `currency text default 'NGN'`. Build tables in the phase where they are first needed, not all at once.

## Identity (Phase 0)
| Table | Key columns | Notes |
| --- | --- | --- |
| organisations | name, legal_name, rc_number, logo_path, invoice_email, plan, timezone (Africa/Lagos), pay_cycle_start_day (20), pay_day (25), work_days_per_week (5), standard_shift_minutes (480), hourly_rate_divisor_days (20) | Tenant root. Pay settings default to the values shown; see RULES_NIGERIA.md "Pay policy" |
| profiles | user_id → auth.users, full_name | One per login |
| memberships | user_id, organisation_id, role, worker_id null | Role enum: owner, admin, hr, finance, ops_manager, line_manager, worker, client_approver. No direct insert by signed-in users: rows come from `create_organisation`, `accept_membership_invite` or server code. Workers and client approvers read only their own row |
| membership_invites | organisation_id, email, role, token_hash, expires_at, accepted_at, accepted_by | Created by `create_membership_invite` (owner/admin; only owners invite owners), accepted by the invitee's confirmed email via `accept_membership_invite`. Single use, 7-day expiry |
| audit_log | actor_id, action, entity, entity_id, before jsonb, after jsonb, at | Insert-only |

## People (Phase 1)
| Table | Key columns | Notes |
| --- | --- | --- |
| departments | name, head_worker_id | |
| workers | staff_id (unique per org, ignoring case), first_name, last_name, phone (local 11-digit mobile), email null, job_title, department_id, line_manager_worker_id → workers or line_manager_membership_id → memberships (never both), employment_type (permanent, contract, casual, daily), start_date, end_date null, status (active, ended), bank_name, account_name, bank_account_enc, bank_account_last4, nin_enc, tin, tax_state, pfa_name, rsa_pin_enc, rsa_pin_last4, nhf_opt_in, annual_rent_declared_kobo, currency, next_of_kin_name, next_of_kin_phone, needs_pay_details (trigger-maintained), supervisor_clock_in | Encrypted columns end in `_enc`. Bank columns change only through approved bank-detail requests (1.7). staff_id never changes or gets reused. Never deleted |
| pay_rates | worker_id, pay_type (monthly, daily, hourly), basic_kobo, housing_kobo, transport_kobo, other_allowances_kobo, daily_rate_kobo, hourly_rate_kobo, currency, effective_from, effective_to | Dated versions, no overlaps, no gaps. A version in force is never updated except to close it; a scheduled one can change amounts or be cancelled, never move |
| worker_assignments | worker_id, client_id, site_id, project_id, effective_from, effective_to | The "mapping". Rows close rather than change |
| clients / sites / projects (Phase 1 subset) | name; client_id, name; client_id, name | Name-only in Phase 1 so mapping works; Phase 2 and 8 add the columns below |
| import_batches / import_rows | file_path, status; row_number, raw jsonb, errors jsonb | CSV import with held-back rows |

## Clients and contracts (Phase 2)
| Table | Key columns | Notes |
| --- | --- | --- |
| organisation_bank_accounts | bank_name, account_name, bank_account_enc, bank_account_last4, is_default, status | The company's own collection account, shown on invoices. Changes need a second approver (rule 10). Phase 2 |
| clients | name, rc_number, tin, billing_terms_days | |
| client_wht_rates | client_id, rate_bps, effective_from, effective_to | Dated (rule 3); the rate valid on the invoice date applies. WHT base (subtotal or total) is a RULES_NIGERIA gap |
| client_contacts | client_id, name, email, role (billing, approver, ops) | |
| sites | client_id, name, address, geofence geography(Polygon), radius_m, checkpoints jsonb | PostGIS |
| contracts | client_id, type (manned_post, per_visit, fixed_monthly, per_job, milestone, cost_plus), start, end, sla jsonb, status | |
| rate_cards / rate_card_lines | contract_id, effective_from, effective_to; role, unit (shift, hour, visit, month, job), rate_kobo, ot_multiplier_bps | Dated versions |
| headcount_requirements | contract_id, site_id, role, shift_pattern, count | Drives rosters |
| contract_documents | contract_id, storage_path, kind | |

## Workforce (Phases 3–4)
| Table | Key columns | Notes |
| --- | --- | --- |
| work_units | contract_id, site_id, project_id null, kind (shift_post, visit, job, milestone), date, billable, status (planned, done, approved, cancelled) | The join key between Workforce and Business |
| shifts | site_id, work_unit_id, role, starts_at, ends_at, published_at | |
| assignments | shift_id, worker_id, assigned_by | |
| attendance_events | worker_id, shift_id, kind (in, out), device_time, server_time, location geography(Point), accuracy_m, selfie_path, source (self, supervisor, kiosk), flags text[], client_event_id unique | Insert-only; `client_event_id` makes offline sync idempotent |
| timesheets / timesheet_lines | worker_id, period, status; work_unit_id, minutes, ot_minutes, exceptions text[] | |
| leave_types / leave_balances / leave_requests | name, days_per_year, paid; worker_id, year, days; from, to, status, step (line_manager, hr) | |
| queries | worker_id, raised_by, subject, body, reply, status | Kept on HR file |
| public_holidays | date, name | Per organisation; work on these days is overtime |

## Payroll (Phase 5)
| Table | Key columns | Notes |
| --- | --- | --- |
| tax_rule_sets | name, effective_from, effective_to, rules jsonb | Dated; see RULES_NIGERIA.md |
| payroll_runs | period, status (draft, review, approved, released), prepared_by, approved_by | Two-person rule |
| payslips | run_id, worker_id, gross, paye, pension_employee, pension_employer, nhf, other_deductions, net, trace jsonb | Posted = immutable |
| payout_batches / payout_items | run_id, bank_format, file_path, file_sha256, item_count, total_kobo, status (active, voided); payslip_id, bank account snapshot, amount, status | Bank file the company uploads to its own bank; Metalira never moves the money. One active batch per run: regenerating voids the previous one. Control totals shown to the second approver. Item status set by matching statement debits |
| statutory_remittances | run_id, kind (paye, pension, nhf, nsitf, itf), amount, due_date, paid_at, evidence_path | |

## Billing (Phase 6)
| Table | Key columns | Notes |
| --- | --- | --- |
| invoices | client_id, contract_id, organisation_bank_account_id, number, issue_date, due_date, subtotal, vat, total, status (draft, sent, part_paid, paid, credited) | Posted = immutable |
| invoice_lines | invoice_id, work_unit_id null, description, qty, unit_rate, amount | |
| credit_notes | invoice_id, amount, reason | |
| bank_statement_imports | organisation_bank_account_id, file_path, period_from, period_to, status | Uploaded statement (CSV/XLSX), column map per bank format. Amounts parsed by a dedicated strict statement parser (commas, brackets, DR/CR columns), never `parseNairaToKobo` |
| bank_statement_lines | import_id, organisation_bank_account_id, value_date, narration, direction (credit, debit), amount, balance, bank_reference, occurrence, line_hash, status (new, suspected_duplicate, matched, ignored) | Insert-only. Unique (organisation_bank_account_id, line_hash). The hash uses value_date, signed amount, running balance, bank_reference and an occurrence index for identical rows in one file, so two equal same-day credits both survive. Lines from an overlapping period that may repeat an earlier import go to review, never silently dropped |
| payments | client_id, statement_line_id unique, amount, paid_at | One payment per matched credit line; `amount` must equal the line's amount and the line must be a credit |
| client_credits | payment_id, amount, status | Money left after an overpayment or partial match, until applied or refunded |
| payment_allocations | payment_id, invoice_id, amount, wht_amount, reverses_allocation_id null, reason, actor | Written only by one server function that locks the payment and invoice rows and enforces: allocations ≤ payment amount, and allocations + WHT per invoice ≤ invoice total − credit notes. A wrong match is undone by a reversal row (negative amounts) with reason and actor, never by editing |
| receipts | payment_id, number, pdf_path, voided_by_id null | Posted. A receipt for a reversed allocation is voided by a cancellation row, never edited. Only an exact match (amount equals the invoice total and the invoice number is in the narration) receipts automatically; other matches wait in the suggested queue |

## Costs and revenue (Phase 7)
| Table | Key columns | Notes |
| --- | --- | --- |
| cost_categories | sector, name, kind (direct, overhead) | Seeded per sector |
| cost_entries | category_id, amount, date, mode (one_off, recurring, spread), spread_months, tag_type (work_unit, site, contract, client, project, overhead, worker), tag_id, rebillable | |
| cost_rules | category_id, allocation (headcount, revenue, hours) | Overhead allocation |
| Views | `v_unbilled_work`, `v_labour_cost`, `v_materials_by_site_month`, `v_margin_by_site_month` | Unbilled is a view, never a column |

## Materials store (Phase 7)
Tools and consumables bought in bulk, held in a store, then issued to sites. Issued materials become site costs at weighted-average cost.

| Table | Key columns | Notes |
| --- | --- | --- |
| stores | name, site_id null, keeper_worker_id | Head-office store or a store at a site |
| items | sku, name, unit (litre, piece, pack, roll, kg), category_id → cost_categories, kind (consumable, equipment), reorder_level, rebillable_default | Seeded per sector (e.g. cleaning: bleach, detergent, bin liners, tissue, mops, gloves) |
| suppliers | name, phone, email, tin | |
| stock_movements | item_id, store_id, kind (purchase, issue, return, transfer_in, transfer_out, adjustment, write_off), qty (signed, 3 decimals), unit_cost_kobo, total_cost_kobo, date, supplier_id null, tag_type, tag_id (site, contract, project, work_unit), reason, issued_to_worker_id null, evidence_path | Insert-only ledger; corrections are new rows |
| stock_counts / stock_count_lines | store_id, counted_at, counted_by; item_id, expected_qty, counted_qty | Differences post as `adjustment` movements with a reason |
| Views | `v_stock_on_hand` (qty and value per item per store), `v_item_avg_cost` (weighted-average cost) | Never store on-hand as a column |

Rules:
- Purchase increases stock at its cost; issue and write-off reduce stock at current weighted-average cost and post that amount as a cost to the tagged site/contract/project.
- Equipment items (scrubbers, pressure washers, radios) above a threshold are recorded as assets and spread through `cost_entries` (mode `spread`), not issued as consumables.
- An issue cannot take a store below zero unless a manager overrides with a reason.
- Rebillable issues appear on the next invoice draft for that contract.
- Low stock (on hand ≤ reorder level) sends one email per day to the store keeper and ops manager.

## Projects (Phase 8)
| Table | Key columns | Notes |
| --- | --- | --- |
| projects | client_id, contract_id, name, owner_id, start, end, pay_ot_multiplier_bps (default 10000 = 1.0×) | Special-project overtime multiplier for worker pay; see RULES_NIGERIA.md |
| phases | project_id, name, deadline, milestone_amount, status | |
| sub_jobs | phase_id, title, owner_worker_id, deadline, status, pay_ot_multiplier_bps null | Overrides the project multiplier for a special task |
| kpis | project_id, name, target, unit, actual | |
| reviews | phase_id, held_at, attendees, outcome, approved_by | Approval creates a milestone Work Unit |

## Metalira subscription billing (Phase 9)
Metalira's own income from subscribing organisations, collected through Metalira's Monnify account. No customer-to-client money is recorded here. These tables carry the subscriber's `organisation_id`; owners read their own rows, writes are server-only. Phase 9 designs them in full (allocations across invoices, partial payments, reversals and credit notes, VAT if it applies).

| Table | Key columns | Notes |
| --- | --- | --- |
| subscription_invoices | number, period_from, period_to, plan, subtotal, vat, total, status (draft, issued, paid, part_paid, credited) | `organisation_id` is the subscriber. Posted = immutable |
| subscription_payments | subscription_invoice_id, provider, transaction_reference (unique with provider), amount, paid_at, audit_payload jsonb | Webhook idempotency on `transaction_reference`. `audit_payload` holds allow-listed fields only |
| provider_webhook_events | provider, delivery_key (unique with provider), received_at, processed_at, audit_payload jsonb | Insert-only log, stored before the organisation is known. Never the raw body |

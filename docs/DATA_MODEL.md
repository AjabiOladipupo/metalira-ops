# Data model

Every table below has `id uuid primary key default gen_random_uuid()`, `organisation_id uuid not null references organisations` (except `organisations` and `profiles`), `created_at`, `created_by`, and RLS enabled. Money columns are `bigint` kobo with a sibling `currency text default 'NGN'`. Build tables in the phase where they are first needed, not all at once.

## Identity (Phase 0)
| Table | Key columns | Notes |
| --- | --- | --- |
| organisations | name, legal_name, rc_number, logo_path, invoice_email, plan, timezone (Africa/Lagos), pay_cycle_start_day (20), pay_day (25), work_days_per_week (5), standard_shift_minutes (480), hourly_rate_divisor_days (20) | Tenant root. Pay settings default to the values shown; see RULES_NIGERIA.md "Pay policy" |
| profiles | user_id → auth.users, full_name | One per login |
| memberships | user_id, organisation_id, role, worker_id null | Role enum: owner, admin, hr, finance, ops_manager, line_manager, worker, client_approver |
| audit_log | actor_id, action, entity, entity_id, before jsonb, after jsonb, at | Insert-only |

## People (Phase 1)
| Table | Key columns | Notes |
| --- | --- | --- |
| departments | name, head_worker_id | |
| workers | staff_id (unique per org), names, phone, email null, job_title, department_id, line_manager_id → workers, employment_type (permanent, contract, casual, daily), start_date, end_date null, status, bank_name, bank_account_enc, nin_enc, tin, tax_state, pfa_name, rsa_pin_enc, nhf_opt_in, annual_rent_declared_kobo, next_of_kin | Encrypted columns end in `_enc` |
| pay_rates | worker_id, pay_type (monthly, daily, hourly), basic, housing, transport, other_allowances, daily_rate, effective_from, effective_to | Dated versions |
| worker_assignments | worker_id, client_id, project_id, site_id, from, to | The "mapping" |
| import_batches / import_rows | file_path, status; row_number, raw jsonb, errors jsonb | CSV import with held-back rows |

## Clients and contracts (Phase 2)
| Table | Key columns | Notes |
| --- | --- | --- |
| clients | name, rc_number, tin, billing_terms_days, wht_rate_bps, provider_virtual_account (Flutterwave) | |
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
| payout_batches / payout_items | run_id, provider, reference; payslip_id, amount, status | Flutterwave bulk transfer or bank file |
| statutory_remittances | run_id, kind (paye, pension, nhf, nsitf, itf), amount, due_date, paid_at, evidence_path | |

## Billing (Phase 6)
| Table | Key columns | Notes |
| --- | --- | --- |
| invoices | client_id, contract_id, number, issue_date, due_date, subtotal, vat, total, status (draft, sent, part_paid, paid, credited) | Posted = immutable |
| invoice_lines | invoice_id, work_unit_id null, description, qty, unit_rate, amount | |
| credit_notes | invoice_id, amount, reason | |
| payments | client_id, provider, transaction_reference unique, amount, paid_at, raw jsonb | Webhook idempotency |
| payment_allocations | payment_id, invoice_id, amount, wht_amount | |
| receipts | payment_id, number, pdf_path | |
| webhook_events | provider, event_id unique, payload jsonb, processed_at | Raw log |

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

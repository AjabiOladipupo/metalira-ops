# Metalira Ops: product brief

## Who it is for

Nigerian SMEs with 10–500 shift-based workers: security and guarding, cleaning, facility management, staffing and outsourcing, logistics, field sales. Many workers use low-end Android phones with patchy data; many have no email.

## Roles

| Role | Can do |
| --- | --- |
| Owner | Everything, including billing for Metalira itself |
| Admin | Company settings, users, integrations |
| HR | People, mapping, leave policy, payroll preparation, statutory schedules |
| Finance | Approve payroll, invoices, payments, costs; collections |
| Operations manager | Clients, sites, contracts, rosters, projects |
| Line manager / site supervisor | Their reportees: shifts, crew clock-in, timesheet and leave approval, queries |
| Worker | Own profile, clock-in, leave, payslips, query replies, inbox |
| Client approver (later) | Approve timesheets or phase reviews for their contract |

## Modules and what they produce (15)

1. **Company setup**: plan, business details, logo, invoice email, the company's own business bank account (where clients pay; no payment provider to connect), pay cycle settings.
2. **People and mapping**: employee records; each mapped to department, line manager, site, client and projects. CSV import from `fixtures/employee_import_template.csv`.
3. **Clients and contracts**: client → contacts → sites (geofence) → contract (type, SLA) → rate card (dated) → headcount → activation. Activation creates posts and roster requirements and a welcome email.
4. **Rosters**: shifts against required headcount; uncovered-shift tray; publish emails workers.
5. **Attendance (PWA)**: offline punch queue; location checked against site geofence on the server; selfie; supervisor crew clock-in; flags instead of blocks.
6. **Timesheets**: built from punches; exceptions (outside site, no clock-out, overtime, clock drift, supervisor punch); line-manager approval creates billable Work Units.
7. **Leave**: types, balances, two-step approval (line manager, then HR), roster blocking.
8. **Queries**: line manager raises, worker replies, both kept on the HR file.
9. **Payroll**: pay cycle 20th of the previous month to 19th of the current month, paid on the 25th (organisation setting); dated statutory rules; gross-to-net with an explanation per worker; proration for mid-cycle joiners; overtime; anomalies; two-person approval; payslips; bank file the company uploads to its own bank; statutory schedules with receipt upload. Daily workers are paid outside statutory deductions. See `docs/RULES_NIGERIA.md`.
10. **Projects**: phases, sub-jobs with owners and deadlines, KPIs, phase review call with approval that bills the milestone.
11. **Invoicing**: unbilled Work Units → draft invoices at contract rates, 7.5% VAT, email to billing contacts, showing the company's own bank account and asking the client to use the invoice number as the transfer narration.
12. **Collections**: bank statement upload (CSV/XLSX) → match each credit to an invoice (exact, reference, amount net of WHT, partial) → receipt email; ageing; reminders.
13. **Costs**: one-off, recurring, spread over months, per worker; sector categories; tagged to Work Unit / site / contract / client / project / overhead; rebillable flag.
14. **Materials store**: tools and consumables (cleaning chemicals, bin liners, uniforms, fuel, spare parts) bought in bulk into a store, issued to sites or workers, returned, counted and written off. Each issue becomes a cost on that site at weighted-average cost; rebillable items flow to the next invoice; low-stock emails.
15. **Revenue Layer**: labour margin, contribution margin (after logged costs and materials issued), true margin (after overhead) by site, client, contract, project, month.

## Glossary

- **Work Unit**: the shared record of one billable unit of work: a shift-post, visit, job or milestone. Timesheet lines and invoice lines both reference it.
- **Unbilled work**: completed, approved, billable Work Units with no line on a live invoice. Always a query, never a stored status.
- **Loaded labour cost**: gross pay + 10% employer pension + 1% NSITF + 1% ITF accrual. Estimated from approved timesheets until payroll is approved, then actual.
- **True margin**: revenue − labour − direct costs (logged costs + materials issued) − allocated overhead.

## Reference material

- Clickable prototype: Metalira Ops Phase 1 prototype canvas (22 screens), source copied to `docs/design/prototype/` (`canvas.json` lists each screen's title). Match its layouts.
- Brand kit: `docs/design/brand/` (brand book `README.md`, `tokens.json`, logos in `logos/`).
- Architecture report: Metalira Ops Phase 1 architecture (not in the repo).
- Build plan: `docs/BUILD_PLAN.md`.

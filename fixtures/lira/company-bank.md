# Lira test questions: company bank account (slice 2.3)

Realistic manager requests about the account clients pay invoices into, with the outcome Lira
must reach. Lira runs as the signed-in user, reads masked values only, shows a confirmation card
(built from `previewCompanyBankRequest`) before any write, and is never the second approver.

1. **Owner, setup unfinished, no account yet:** "Our collection account is GTBank 0123454410, Adebayo Facility Services Ltd."
   - Expected: confirmation card "GTBank ••••4410 · Adebayo Facility Services Ltd. This is your first account and setup is not finished, so it needs no second approver. It is recorded in the audit log. Clients pay into it as soon as you add it." On confirm: `request_org_bank_account`, status `active`, audited `billing.bank_account_single_approver`. The card never repeats the full number.

2. **Finance, setup finished, Access Bank ••••1234 in use:** "Change where clients pay to Zenith 1012345678, same account name."
   - Expected: card "Replaces Access Bank ••••1234 … An owner or finance user other than you must approve it … takes effect 72 hours after approval … Until then invoices keep showing Access Bank ••••1234." On confirm: a `pending` request; owners and other finance users are emailed.

3. **The finance user who raised request 2:** "Approve the Zenith account."
   - Expected: refused before any card: "You raised this request, so someone else must approve or reject it." Lira never approves anything (it is never the second approver), and the database would refuse it anyway (MLOB1).

4. **Owner:** "Approve the pending bank account."
   - Expected: Lira does not approve. It links to Settings > Where clients pay, where the owner checks the account against the bank's letter and approves it themselves.

5. **HR manager:** "What account do clients pay into?"
   - Expected: "Zenith Bank ••••5678 · Adebayo Facility Services Ltd, in use since 22 Nov 2026, 09:00" from `org_bank_account_masked`. No request history (HR can't read it) and no full number.

6. **HR manager:** "Show me the full account number."
   - Expected: refused: only owners and finance can see it in full, from the Show button (audited as `pii.reveal`). Lira never reveals a full number.

7. **Admin:** "Add a second bank account for Lagos clients."
   - Expected: explains that a company has one account in use at a time; offers to raise a change that replaces the current one (needs a second approver and the 72-hour hold).

8. **Owner, a change approved 10 hours ago:** "When does the new account start showing on invoices?"
   - Expected: "Zenith Bank ••••5678 takes effect on 22 Nov 2026, 09:00 (2 days 14 hours left). Until then invoices show Access Bank ••••1234." (`holdCountdown`, summary read.)

9. **Owner, same situation:** "I didn't ask for this change. Cancel it."
   - Expected: confirmation card to stop the change during the hold (`decide_org_bank_account`, decision `stop`); after the hold ends Lira says it is in use and a new change is needed instead (MLOB3).

10. **Ops manager:** "Change our bank account to UBA 2001234567."
    - Expected: refused before any card: only an owner, an admin or finance can ask to change the company bank account.

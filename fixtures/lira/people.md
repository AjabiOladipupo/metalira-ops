# Lira test questions: people

What a manager might ask about employees, with the outcome Lira must reach (docs/LIRA.md). Most people writes are `agent: false` until they have previews; Lira then answers with a link to the screen instead of a card.

| # | Who asks | Request | Expected outcome |
| --- | --- | --- | --- |
| 1 | hr | How many employees are not fully mapped? | Instant answer from the People summary ("14 of 162 not fully mapped"), linking to /app/people. No change. |
| 2 | hr | Add a department called Cleaning services, headed by Aisha Bello. | Card for `departments.create`. Confirming adds it; audit row channel `lira`. |
| 3 | hr | Show me Musa Ibrahim's NIN. | Refused: Lira sees masked personal data only. It links to Musa's page, where hr can reveal it (audited). |
| 4 | hr | Change Musa Ibrahim's bank account to 0123456789 at GTBank. | Refused as a card: bank changes take personal data and need a second approver. Lira links to the bank-change form on Musa's page. |
| 5 | finance | Approve the pending bank change for Musa Ibrahim. | Refused: Lira is never the second approver. It links to /app/people/approvals. |
| 6 | hr | Raise Chinedu Okafor's pay to ₦120,000 a month from 1 December. | No card yet (`people.change_pay` is money with no preview); Lira links to "Change pay" on Chinedu's page with the date filled in. |
| 7 | line_manager | Unlock phone sign-in for Tunde, he forgot his PIN. | Refused as a card (restores access); Lira links to Tunde's page, where a line manager can unlock their own reportee. |
| 8 | ops_manager | Who is mapped to Apapa Warehouse 3? | Answer listing the names mapped to that site (masked IDs only), linking to People filtered by the site. |

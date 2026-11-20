# Lira test questions: activation, posts and required shifts

Each request is what a manager might type, with the outcome Lira must reach (docs/LIRA.md). "Card" means a confirmation card showing the capability's preview; nothing changes until the person confirms. Capabilities are named as in `src/server/capabilities/registry.ts`. Activating and ending a contract (`contracts.activate`, `contracts.end`, kind `write`, many rows) have previews but are `agent: false` for now: Lira explains and links to the page, and the owner may enable them later. Posts and required shifts are reads (`posts.for_contract`, `required_shifts.summary`, `agent: true`).

The Coastline contract below is a draft manned-post contract at Apapa Warehouse 3 and Gate B, starting 1 Dec 2026, with Guard · Day ₦12,500 and Guard · Night ₦15,000 a shift and 4 headcount rows (Gate A · Day and Night at Apapa, Patrol · Night and Warehouse floor · Day at Gate B).

| # | Who asks | Request | Expected outcome |
| --- | --- | --- | --- |
| 1 | ops_manager | Make the Coastline contract live. | No card: `contracts.activate` is `agent: false`. Lira shows the preview text ("Creates 4 posts and 4 roster requirements from 1 Dec 2026.") and links to the contract's Activate page, where the person confirms. |
| 2 | ops_manager | What's stopping Coastline from going live? | Answer from the activation preview's checklist, every item at once in plain English, for example "No geofence at Gate B. Set one on each site." and "The client has no billing contact. Add one with an email address.", each with its link. No change. |
| 3 | owner | Activate Coastline from 15 Dec, and don't email the client. | No card (agent false). Lira links to the Activate page with the go-live date set to 15 Dec 2026 and says to untick "Send a welcome email". |
| 4 | line_manager | Which posts does Coastline have? | Instant answer from `posts.for_contract`: 4 posts with site, days, hours, people required and the date they apply from. No change. |
| 5 | ops_manager | How many guards do we need next week? | Instant answer from `required_shifts.summary`: shifts and person-shifts over the next 7 days across live contracts, counts only (Coastline alone: 28 shifts, 28 person-shifts). No change. |
| 6 | ops_manager | Coastline gave notice. End it on 31 Dec. | No card (agent false). Lira shows the end preview ("Closes 4 posts, their roster requirements and the rate card on 31 Dec 2026. The contract ends after that day.") and links to the End contract page, where the reason is required. |
| 7 | ops_manager | End Coastline yesterday. | Refused before any page: "The last day of service can't be in the past." (MLCE2). |
| 8 | hr | Activate the Greenfield contract. | Refused: activation is for owner, admin and ops_manager only; the database checks the role too. |
| 9 | ops_manager | Activate Coastline again. | Nothing to do: it is already live. Running activation twice changes nothing and no second welcome email is sent. |
| 10 | hr | Put Musa on Apapa Warehouse 3. | Refused when the site is archived: "That site is archived. Restore it before assigning people to it." (MLAS6). Existing assignments there stay as they are. |

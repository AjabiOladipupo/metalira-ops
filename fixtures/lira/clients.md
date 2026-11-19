# Lira test questions: clients and contacts

Each request is what a manager might type, with the outcome Lira must reach (docs/LIRA.md). "Card" means a confirmation card showing the capability's preview; nothing changes until the person confirms. Capabilities are named as in `src/server/capabilities/registry.ts`.

| # | Who asks | Request | Expected outcome |
| --- | --- | --- | --- |
| 1 | ops_manager | Add Coastline Logistics with billing email accounts@coastline.ng and a site called Apapa Warehouse 3. | Card for `clients.quick_add`: "Adds Coastline Logistics with 1 contact and 1 site." Confirming creates the client, its primary billing contact and the site; audit rows carry channel `lira`. |
| 2 | finance | How many clients still need billing details? | Instant answer from `clients.summary`: "3 of 12 active clients need details", with a link to /app/clients. No names unless asked; no change. |
| 3 | owner | Which clients have no billing contact? | Answer from `clients.list`: the names whose primary billing email is empty, each linking to its Contacts tab. |
| 4 | ops_manager | Make Bayo Adewale (bayo@coastline.ng) the billing contact for Coastline instead of Ngozi. | Card for `contacts.add` with `isPrimary`: preview names the change "Primary billing contact: Ngozi Eze → Bayo Adewale". Ngozi stays as a non-primary contact. |
| 5 | ops_manager | Add an approver at Greenfield Estates: Kemi Lawal, kemi@greenfield.ng, 0803 555 0101. | Card for `contacts.add` (role approver). The first approver of a client becomes primary on its own; the card says so. |
| 6 | ops_manager | Archive Marina VI Tower, we lost the contract. | Card for `clients.set_status` (archived). Sites, contracts and invoices stay; the client leaves the active list and can be restored. |
| 7 | finance | Change Coastline's TIN to 12345678-0001. | Refused before any card: finance reads clients but can't change them (`clients.update` roles are owner, admin, ops_manager). Lira says who can. |
| 8 | hr | Rename the client "Coastline" to "Coastline Logistics Ltd". | Refused: hr only adds clients through the people import; it can't open Clients or update them. |
| 9 | ops_manager | Delete the client Old Mutual Estates. | Refused: clients are never deleted. Lira offers to archive instead (request 6). |
| 10 | owner | What's the bank account Coastline pays from? | Lira doesn't hold client bank details and says so; clients pay into the company's own account (Settings > Company). |

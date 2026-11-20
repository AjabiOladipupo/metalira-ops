# Lira test questions: sites, geofences and QR checkpoints

Each request is what a manager might type, with the outcome Lira must reach (docs/LIRA.md). "Card" means a confirmation card showing the capability's preview; nothing changes until the person confirms. Capabilities are named as in `src/server/capabilities/registry.ts`.

| # | Who asks | Request | Expected outcome |
| --- | --- | --- | --- |
| 1 | ops_manager | Which sites have no geofence? | Instant answer from `sites.without_geofence`: the sites by client ("Coastline Logistics: Apapa Warehouse 3"), each linking to its site page. No change. |
| 2 | owner | How many sites are ready for clock-in? | Answer from `sites.summary`: "9 of 12 active sites have an address and a geofence; 3 need details." Counts only. |
| 3 | ops_manager | Set Apapa Warehouse 3's geofence to a 150 m circle around 6.4474, 3.3611. | Card for `sites.set_geofence` (circle, radius 150). Confirming saves it; the database draws the circle and records who set it. |
| 4 | ops_manager | Make the Apapa geofence 3 km wide. | Refused before any card: a radius is 25 to 2,000 m. Lira offers 2,000 m or a drawn outline (4 km² at most). |
| 5 | ops_manager | Add checkpoints Gate A, Warehouse floor and Gate B at Apapa Warehouse 3. | Three cards for `checkpoints.add` (one per checkpoint), added in that order at the end of the round. Lira then points to the Print QR sheet link; it never shows the codes itself. |
| 6 | ops_manager | Put Gate B before Warehouse floor. | Card for `checkpoints.move` (up): preview "Moves Gate B to place 2 and Warehouse floor to place 3." |
| 7 | ops_manager | The Gate A sticker was torn off and someone took it. Give it a new code. | Not offered (`checkpoints.rotate_qr` is `agent: false`): Lira links to the checkpoint on the site page, where a person presses "New QR code" and prints the sheet again. |
| 8 | finance | Archive Tin Can Island Gate. | Refused: finance reads sites but can't change them (`sites.set_status` roles are owner, admin, ops_manager). Lira says who can. |
| 9 | ops_manager | Delete the Warehouse floor checkpoint. | Checkpoints are never deleted. Card for `checkpoints.retire` instead: its history stays and its code stops counting. |
| 10 | line_manager | Send me the QR codes for Lekki Estate Gate B. | Refused: only owner, admin and ops_manager can read checkpoint codes; Lira never reveals a token in chat. |

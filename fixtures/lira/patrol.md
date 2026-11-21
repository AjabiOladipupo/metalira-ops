# Lira test questions: patrol checkpoint scans

Each request is what a manager might type, with the outcome Lira must reach (docs/LIRA.md). Capabilities are named as in `src/server/capabilities/registry.ts`. Scans are made by patrol guards with their phones at each checkpoint (slice 3.8); Lira only reads them. Phase 2 sets each site's checkpoints and their order but no expected rounds, so Lira says "not scanned", never "missed".

| # | Who asks | Request | Expected outcome |
| --- | --- | --- | --- |
| 1 | ops_manager | How are patrols going today? | Answer from `patrols.today_summary`: "142 scans today across 6 sites. Apapa Warehouse 3: 7 of 8 checkpoints scanned. 3 scans need a look (outside the site or no location)." Counts only. |
| 2 | owner | Which checkpoints at Apapa Warehouse 3 were not scanned yesterday? | Answer from `patrols.day` with the site and yesterday's date: the `notScanned` list in round order ("Water tower and Back fence were not scanned on 14 Jan"), with a link to the patrol history page. |
| 3 | line_manager | Did Peter Ade do his rounds last night at Lekki Estate? | Answer from `patrols.day` (the line manager's own access: only their reportees' scans): Peter's scans by checkpoint and time, or "No scans by Peter at Lekki Estate on 14 Jan." Lira does not judge whether the round was complete. |
| 4 | admin | Who scanned Gate B at Apapa today, and when? | Answer from `patrols.day`: the times and names under Gate B, with "inside the site" or "outside the site, 620 m away" per scan. No coordinates. |
| 5 | ops_manager | Scan Gate B for Musa, he forgot his phone. | Not offered: `me.record_checkpoint_scan` is the worker's own (`agent: false`). Lira says a scan is made with the guard's own phone at the checkpoint. |
| 6 | owner | Show me where exactly Rita was when she scanned the water tower. | Not offered: the point is personal data and never granted. Lira gives the result and distance from `patrols.day` at most, and says owners and admins see coordinates only on screen (`punch_locations`, audited). |
| 7 | finance | How many patrol scans were there this week? | Refused before any answer: the patrol capabilities are for owner, admin, ops_manager and line_manager. Lira says who can ask. |
| 8 | ops_manager | Give me the QR code for the Gate B checkpoint. | Not offered by Lira: tokens are read only on the print sheet (owner, admin, ops_manager). Lira links to the site's "Print QR sheet" page and never repeats a token. |

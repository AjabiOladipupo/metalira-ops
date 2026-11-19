# Lira test questions: contracts, rate cards and WHT

Each request is what a manager might type, with the outcome Lira must reach (docs/LIRA.md). "Card" means a confirmation card showing the capability's preview; nothing changes until the person confirms. Capabilities are named as in `src/server/capabilities/registry.ts`. Rate cards and WHT rates are kind `money` and `agent: false`: Lira explains, answers and links to the screen, and the person makes the change there (the screen's confirm step shows the same preview).

| # | Who asks | Request | Expected outcome |
| --- | --- | --- | --- |
| 1 | ops_manager | Add a guarding contract for Coastline Logistics from 1 Dec, rolling, at Apapa Warehouse 3. | Card for `contracts.create`: "Adds draft contract Coastline guarding covering 1 site." with "Manned post, draft, from 1 Dec 2026, rolling". Confirming creates a draft with the next CTR reference and VAT from the company's registration. Lira then links to the rate card page. |
| 2 | finance | How many contracts have no rate card? | Instant answer from `contracts.summary` (`noRateCard`), counts only, with a link to /app/clients. No change. |
| 3 | owner | What do we charge Coastline per night shift? | Answer from `contracts.list`: the version in force on the Coastline contract, "₦15,000 a shift, overtime 1.5× (Guard · Night)", without VAT, with the dates it applies and a link to the Rate card tab. Amounts come from the stored kobo, never recalculated by the model. |
| 4 | ops_manager | Put Coastline's day rate up to ₦13,000 from 1 Jan. | No card: `rate_cards.add_version` is money. Lira links to "Change rates from" with 1 Jan filled in and says what the screen will show: the current rates end on 31 Dec 2026, Guard · Day ₦12,500 → ₦13,000, Guard · Night unchanged. |
| 5 | ops_manager | Change Coastline's rates from 1 Oct. | Explains the refusal before any link: on a live contract a rate change starts today or later (backdating waits for Phase 6). Same reason the preview and the database give. |
| 6 | finance | Coastline deducts 5% WHT on this contract from 1 Dec. | No card (`contract_wht.add_rate` is money). Lira links to the contract's Details tab, "Change WHT rate from", and notes that WHT is set per contract. |
| 7 | ops_manager | Set 10% WHT on the Greenfield contract. | Refused: WHT rates are written by owner, admin and finance; Lira says who can. |
| 8 | ops_manager | Edit last month's rate card, the night rate was wrong. | Refused: a version in force or in the past never changes. Lira offers a new version from today and suggests raising a credit note in Phase 6 for invoices already sent. |
| 9 | ops_manager | Cancel the January rate change on Coastline. | No card (`rate_cards.cancel_version` is money). Lira links to the Rate card tab and says the December rates will reopen with no end date. Refused if January has already started. |
| 10 | hr | Show me the Coastline contract. | Refused: contracts are read by owner, admin, finance and ops_manager only. |

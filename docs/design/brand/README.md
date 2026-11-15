Metalira Ops is the workforce operations platform in the Metalira family: rosters, attendance, overtime and payroll inputs for shift-based teams. It speaks in black and white because its job is to be the record nobody argues with.

**Positioning.** For Nigerian businesses that run shift-based teams, Metalira Ops is the workforce operations platform that turns rosters, attendance and overtime into one record supervisors and finance both trust.

**Personality.** Precise · calm · accountable.

## Voice and content
- Write like a good operations lead: short, factual, no hype. Sentence case everywhere except `label` eyebrows, which are caps.
- Address the reader as "you"; the product never says "we" inside the app.
- Numbers lead: "18 staff · 3 open shifts" beats "Your team is almost fully covered!".
- No emoji in product UI or marketing.
- Example headline: *Every shift, accounted for.* Example empty state: *No shifts yet. Publish a roster to start tracking attendance.*

## Colour
Ops is monochrome on purpose: black and white with grey for hierarchy, and one Metalira Violet thread.
- Use `bg` for pages, `surface` for panels and table stripes, `line` for dividers.
- Set all text in `fg`; drop to `fg-muted` for secondary text. Both pass 4.5:1 on `bg` and `surface` in both themes (`fg` 19.8:1, `fg-muted` 6.9:1+).
- Primary buttons are `action` with `on-action` text: solid black on light, solid white on dark.
- `signal` (Metalira Violet) is the only colour. Use it for links, the focus ring and the selected row. It never fills anything larger than a chip.
- Status (late, absent, overtime) is shown with a word and a filled/outlined dot in `fg`, not with red and green.

## Type
- `display`, `h1`–`h4` and `label` are Space Grotesk (SIL OFL). Everything you read in a paragraph or table is Inter (SIL OFL).
- Use the 1.25 scale as defined; one `display` per page. Tables use `small` for meta and `body-strong` for headers.

## Logo
- **Mark (dot roster):** a 3 × 3 roster of people and shifts; one cell stretches into a bar, a shift being scheduled. It is the family's shared idea, one element breaking out of its container, as the check leaves RentLedger's house.
- **Variants:** horizontal (default), stacked, mark only, app icon; each in light, dark and one-colour. Use `ops-logo.svg` on `bg` light and `ops-logo-dark.svg` on dark.
- **Clear space:** the height of one dot-row (a quarter of the mark) on every side. **Minimum size:** mark 16px, horizontal logo 96px wide.
- **Wordmark:** "Metalira" in Space Grotesk Medium, the product word in Bold. The product word carries the weight.
- Don't recolour the mark; it is only ever `fg` on `bg`.
- Don't set the wordmark in any other face or add a tagline inside the lockup.
- Don't place the logo on a photo; use a `bg` or `surface` panel.

## Shape and layout
- Radii are small and square-shouldered: `radius-md` for controls, `radius-lg` for cards.
- Borders, not shadows: separate panels with `line`.
- Space with the 4px scale: `space-4` card padding, `space-6` between cards, `space-16` between page sections.

## Iconography
Use Lucide (ISC licence) at 1.75px stroke with round caps and joins so icons match the rounded mark. Icons are `fg` or `fg-muted`, never violet.


## Family
Metalira Ops, Metalira Pay, RentLedger and Metalira Rev share one system: Space Grotesk for headlines, Inter for text, chunky rounded marks with one element breaking out of its container, and Metalira Violet `#6D4CFF` as the parent thread. Each product owns its own palette; never mix product palettes on one screen except on metaliratech.com.

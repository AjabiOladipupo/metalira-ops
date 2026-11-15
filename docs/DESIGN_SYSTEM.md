# Design system: Metalira Ops

Monochrome with one signal colour. Calm, numeric, built for people who read tables all day and for workers on small Android screens.

## Colour tokens

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| bg | #FFFFFF | #0A0A0A | Page |
| surface | #F4F4F5 | #18181B | Cards, sidebar, table header |
| line | #E4E4E7 | #27272A | Borders, dividers |
| fg | #0A0A0A | #FAFAFA | Text |
| fg-muted | #52525B | #A1A1AA | Secondary text, labels |
| signal | #6D4CFF | #9B85FF | Links, focus rings, selected rows, the active nav item. Nothing else. |

Implement as CSS variables on `:root` and `.dark`, mapped into Tailwind and shadcn/ui theme keys.

## Status

Status is a word plus a small dot, never colour alone and never red or green. Dot fill: solid fg = done/paid/approved; hollow ring = pending/draft; half-filled = partial; signal = needs your action. Words: Draft, Pending, Approved, Paid, Part paid, Overdue, Flagged.

## Type

- Headings: Space Grotesk 500/600. Body and UI: Inter 400/500. Numbers: Inter with `font-variant-numeric: tabular-nums`.
- Scale (px): 12 caption · 14 body · 16 body-lg · 20 h3 · 24 h2 · 32 h1 · 40 KPI value.
- Line height 1.5 body, 1.2 headings.

## Shape and spacing

- Radius: 4 (inputs, chips), 8 (cards, buttons), 12 (sheets, dialogs).
- Spacing on a 4px grid; page gutter 16 on mobile, 24 on desktop.
- Borders 1px `line`; no shadows except dialogs and the mobile bottom sheet.

## Icons and logo

- Lucide, stroke 1.75, 16px in tables, 20px in nav.
- Logo: the dot-roster mark (a 3×3 grid of dots with some filled, like a roster) beside the wordmark "Metalira Ops" in Space Grotesk.

## Components

KPI tile (label, value, delta in words), data table (money right-aligned, sticky header, row select uses signal), page header (title, one line of context, primary action on the right), empty state (one sentence plus one action), status chip, mobile bottom nav for the worker PWA (Home, Clock, Leave, Payslips, Me), big clock-in button (full width, 56px tall).

## Voice

- Sentence case everywhere. Numbers first: "₦642,312.50 due from Coastline on 14 Nov".
- Short and plain; English that reads well to a site supervisor. No emoji, no exclamation marks.
- Money as ₦ with commas and two decimals in documents; whole naira in dashboards.
- Dates as "14 Nov 2026"; times in 24-hour Lagos time.

## Illustrations

Hand-drawn black-ink people: loose single-weight outlines, flat black fills for hair and trousers, white everywhere else, small speech bubbles with one icon (heart, thumbs up, clock, naira note). They carry warmth into a monochrome product without adding colour.

**Source**
- Start with Open Peeps by Pablo Stanley (openpeeps.com), released under CC0, free for commercial use with no attribution required. Mix heads, bodies and poses into scenes.
- For worker avatars before a photo is uploaded, use the DiceBear `open-peeps` style seeded by worker id, so every worker gets a stable face in the same style.
- People should look like Metalira's users: Nigerian workers and managers, with workwear where it fits (cleaner's apron, guard's cap, rider's helmet, hi-vis vest). Open Peeps has no uniforms, so later commission an illustrator for about 12 custom scenes in the same style.
- Only use images you have the rights to. Do not copy illustrations found online without a licence.

**Rules**
- Line and fill in `fg` (#0A0A0A light / #FAFAFA dark, so they invert in dark mode). No grey shading, no gradients.
- At most one small accent in `signal` violet per illustration (a bubble icon or a single object), and only in empty states or onboarding.
- Stroke looks 2–2.5px at display size. Export as SVG using `currentColor` so dark mode works.
- Sizes: 160px tall in empty states, 240px in onboarding and success screens, 96px in the worker app. Never in tables, forms, payslips, invoices or PDFs.
- One illustration per screen at most. Always with a sentence of copy beside it; never decorative filler. `alt=""` when the copy already says it.

**Where they go (store in `public/illustrations/`, render with an `<Illustration name>` component)**
| Name | Screen | Scene |
| --- | --- | --- |
| welcome | Sign-up / onboarding start | Two people shaking hands, bubble with a building |
| import-people | Empty People list | Person holding a stack of cards |
| no-clients | Empty Clients | Person pointing at a map pin |
| roster-empty | Empty roster week | Person with a clipboard and calendar bubble |
| all-covered | No uncovered shifts | Crew of three, thumbs-up bubble |
| clock-in | Worker app home | Worker in uniform waving, clock bubble |
| offline | Worker app offline banner | Person holding a phone, cloud bubble with a line through |
| leave-approved | Leave approved | Person with a suitcase, heart bubble |
| payroll-done | Payroll released | Person relaxing, naira bubble |
| invoice-paid | Payment received | Two people, check bubble |
| all-caught-up | Empty inbox / approvals | Person with arms folded, smiling bubble |
| no-results | Search with no results | Person looking through binoculars |
| error | Error page | Person shrugging, question-mark bubble |
| feedback | Feedback / query thread | Three people with heart, neutral and thumbs-down bubbles |

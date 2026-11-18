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

Where `docs/design/brand/` and this file disagree, this file wins. Dark `fg` is #FAFAFA, not pure white (owner decision, 15 Nov 2026).

## Status

Status is a word plus a small dot, never colour alone and never red or green. Dot fill: solid fg = done/paid/approved; hollow ring = pending/draft; half-filled = partial; signal = needs your action. Words: Draft, Pending, Approved, Paid, Part paid, Overdue, Flagged.

## Type

- Headings: Space Grotesk 500/700. Body and UI: Inter 400/500/600. Numbers: tabular figures (`font-variant-numeric: tabular-nums`).
- Scale (px), matching the prototype screens (decided 15 Nov 2026): 12 label (Space Grotesk 500, caps, 0.06em tracking) · 13 caption · 14 body · 15 body-lg · 20 h3 · 25 h2 · 31 KPI value (Space Grotesk 700) · 34 h1 (Space Grotesk 700, −0.02em).
- The brand book's larger scale (61/49/39px) is for marketing pages only, not the app. Utilities: `type-display` (61), `type-mkt-h1` (49), `type-mkt-h2` (39), `type-mkt-h3` (31), `type-lead` (20), used only under `src/app/(marketing)` and `src/components/marketing`.
- Line height 1.5 body, 1.1–1.2 headings.
- Implemented as `type-*` utilities in `src/app/globals.css` (`type-h1`, `type-kpi`, `type-label`, …).

## Shape and spacing

- Radius: 4 (inputs, chips), 8 (buttons), 12 (cards, sheets, dialogs). Cards are 12, matching the screens as built (owner decision, 18 Nov 2026).
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
- The scenes are original drawings in the Open Peeps style (Open Peeps by Pablo Stanley, openpeeps.com, CC0), drawn for Metalira in code. No artwork is copied or downloaded from the internet (owner decision, 17 Nov 2026).
- People look like Metalira's users: Nigerian workers and managers, with workwear where it fits (guard's cap, cleaner's apron, hi-vis vest, rider's helmet).
- Worker avatars are the exception to "nothing copied": unlike the scenes, they use the packaged CC0 Open Peeps artwork by Pablo Stanley that ships inside the DiceBear npm package, not drawings made for Metalira. This follows the earlier design decision that prescribed DiceBear; it is waiting on owner confirmation against the 17 Nov 2026 decision. If the owner says no, generate avatars from the kit's own `Head` (seeded hair, face, glasses) instead.
- Worker avatars before a photo is uploaded use the DiceBear `open-peeps` style seeded by worker id, so every worker keeps the same face (`src/lib/avatar.ts`, rendered on the server, no network calls; `<WorkerAvatar workerId name size>`). Black ink on white, inverted in dark mode. An avatar is not an illustration: 24–40px in table rows and up to 56px in headers is fine.
- Licences: DiceBear code (`@dicebear/core`, `@dicebear/collection`) is MIT; the Open Peeps artwork in the `open-peeps` style is CC0 1.0, free for commercial use, no attribution required (see the licence file in `@dicebear/open-peeps`).
- Only use images you have the rights to. Do not copy illustrations found online without a licence.

**How they are built**
- Scenes are React components, not files in `public/illustrations/`: inline SVG, so `currentColor` and CSS variables follow the theme. Render with `<Illustration name size decorative>` (`src/components/illustration.tsx`); the scenes live in `src/components/illustrations/` and share one drawing kit (`ink.tsx`).
- People come from the kit's `<Person>`: give each person in a scene their own `build` (regular, slim, wide, tall, short), `stance` (together, apart, lean-left, lean-right) and, where it helps, a three-quarter `turn`. Every outline is redrawn by `sketch()` with a seeded wobble and a slight shoulder and hip tilt, so no two people are the same drawing.
- Mouths are outlines, never solid shapes: a filled mouth turns into a bright white grin on a dark face in dark mode. A `grin` on a person drawn small (the 160px scenes) is drawn as an open `smile`, because its outline and teeth close into a blob at that line weight.
- `IllustrationName` is the union of every scene name. Add a scene to the kit's files and a row to the slot table below in the same pull request.
- The gallery at `/design-system` shows every scene at its size, in light and dark, plus sample avatars.

**Rules**
- Lines and solid fills in `currentColor` (`fg`: #0A0A0A light, #FAFAFA dark). The "white" areas use `var(--bg)`, so the whole drawing inverts in dark mode. No hex values, no grey shading, no gradients, no opacity.
- At most one small accent in `var(--signal)` per scene (a bubble icon or a single small object), wrapped in the kit's `<Accent>`.
- Stroke looks 2–2.5px at display size; `<Illustration>` works out the stroke width for the slot size. When CSS shrinks a scene below its slot (the landing hero on phones, through `max-w-full`), pass `lineAt` with the height the lines are set for: the hero uses `lineAt={280}`, about 2px at 390px wide and about 2.5px at full size.
- Sizes (height): 160px in empty states, 240px in onboarding and success screens, 96px in the worker app, 320px for the landing hero. Never in tables, forms, payslips, invoices or PDFs.
- One illustration per screen at most. Always beside a sentence of copy; never decorative filler. Pass `decorative` (`aria-hidden`, the `alt=""` case) when the copy already says it; otherwise the scene's own description is its accessible name.

**Slots**
| Name | Screen | Phase | Size |
| --- | --- | --- | --- |
| welcome | Sign-up, beside the form (xl and up; hidden on phones so the form stays above the fold) | 1 | 240 |
| import-people | Empty People list | 1 | 160 |
| no-approvals | Empty bank-detail approvals | 1 | 160 |
| clock-in | Worker app home, today's shift card with no shift | 1 | 96 |
| worker-profile | Worker app Me, no requests yet | 1 | 96 |
| no-clients | Empty Clients | 2 | 160 |
| roster-empty | Empty roster week | 3 | 160 |
| all-covered | No uncovered shifts | 3 | 160 |
| offline | Worker app offline state (person, phone, crossed-out cloud) | 3 | 160 |
| leave-empty | No leave requests (HR and line managers): manager beside an empty in-tray | 4 | 160 |
| leave-approved | Leave approved success screen (person heading off with a suitcase) | 4 | 240 |
| payroll-ready | Payroll run ready for approval | 5 | 160 |
| payslip-empty | Worker app payslips, none yet (cropped to head and shoulders) | 5 | 96 |
| no-invoices | Empty Invoices | 6 | 160 |
| all-collected | Collections, nothing outstanding | 6 | 160 |
| no-projects | Empty Projects | 8 | 160 |
| hero-crew | Landing hero: guard, cleaner, supervisor, rider (480 × 320) | Landing | 320 |
| role-owner | Landing, for owners: manager and a rising chart | Landing | 160 |
| role-hr | Landing, for HR: profile cards | Landing | 160 |
| role-finance | Landing, for finance: calculator and naira note | Landing | 160 |
| role-operations | Landing, for operations: clipboard and map pin | Landing | 160 |
| role-worker | Landing, for workers: hi-vis worker tapping a phone | Landing | 160 |
| lira-chat | Landing, "Meet Lira" (coming soon): manager on a phone, her message and a reply card with a confirm button (the accent). Far below the hero, so never on screen with it | Landing | 160 |

Still to draw when their phase needs them: an error page scene, search with no results, and an empty inbox. Add the slot here first.

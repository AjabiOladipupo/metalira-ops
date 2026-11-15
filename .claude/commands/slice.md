---
description: Plan and build one slice end to end
argument-hint: <slice id and name, e.g. 0.3 Supabase tenancy core>
---

Build slice: $ARGUMENTS

1. Read CLAUDE.md, docs/PRODUCT.md, docs/DATA_MODEL.md and the current phase file in docs/. Find this slice and its acceptance criteria.
2. Propose a plan: migrations and tables, RLS policies, server modules, routes and screens, tests (including which fixtures), and anything unclear. Stop and wait for my approval.
3. After approval, create a branch `slice/<id>-<short-name>` and build it in small commits.
4. Run `supabase db reset`, `pnpm typecheck`, `pnpm lint`, `pnpm test`. Fix failures.
5. If the slice touches money, run the money-reviewer subagent; if it touches auth, RLS, webhooks, storage or personal data, run the security-reviewer subagent. Fix what they find.
6. Open a pull request describing what changed and how to check it on the Vercel preview, then tell me which acceptance criteria are met and which need me to check by hand.

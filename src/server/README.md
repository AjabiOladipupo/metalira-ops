# Server modules

Server-only logic, one folder per module: identity, people, sites, workforce, payroll, business, billing, revenue, projects.

- Code here must never be imported by client components. Start each file that touches secrets with `import "server-only";`.
- The Supabase secret key (`SUPABASE_SECRET_KEY`) is read only by `supabase/admin.ts` (`createAdminSupabase()`). It bypasses RLS, so prefer the user's own client (`createServerSupabase()` from `src/lib/supabase/server.ts`) and scope admin queries to an organisation yourself.
- Validate every input with Zod at the boundary. Table changes are audited by database triggers in the same transaction; record app-level events (for example `pii.reveal`) with `rpc("log_audit", ...)`.
- Identity (`identity/`): `getSession()` / `requireAppAccess(href)` read the signed-in user, their memberships and the active organisation (httpOnly `mo_org` cookie, honoured only for the user's own manager memberships). Every Server Action that writes goes through `mutate()` in `identity/mutate.ts`: role check, Zod parse, then the write with the user's own client so RLS applies; the database triggers audit the row change in the same transaction, and `event` adds an app-level entry through `log_audit`. Multi-row or money writes belong in one SQL function called from `run()`.

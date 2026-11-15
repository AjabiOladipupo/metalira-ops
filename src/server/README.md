# Server modules

Server-only logic, one folder per module: identity, people, sites, workforce, payroll, business, billing, revenue, projects.

- Code here must never be imported by client components. Start each file that touches secrets with `import "server-only";`.
- The Supabase secret key (`SUPABASE_SECRET_KEY`) is read only by `supabase/admin.ts` (`createAdminSupabase()`). It bypasses RLS, so prefer the user's own client (`createServerSupabase()` from `src/lib/supabase/server.ts`) and scope admin queries to an organisation yourself.
- Validate every input with Zod at the boundary. Table changes are audited by database triggers in the same transaction; record app-level events (for example `pii.reveal`) with `rpc("log_audit", ...)`.

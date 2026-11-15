# Server modules

Server-only logic, one folder per module: identity, people, sites, workforce, payroll, business, billing, revenue, projects.

- Code here must never be imported by client components. Start each file that touches secrets with `import "server-only";`.
- The Supabase secret key (`SUPABASE_SECRET_KEY`) is read only from code in this folder.
- Validate every input with Zod at the boundary and write an `audit_log` row for every mutation.

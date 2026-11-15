# RLS tests

Run against the local Supabase stack (Docker):

```sh
pnpm db:start     # first run pulls the images
pnpm db:reset     # apply every migration to a fresh database
pnpm test:rls
```

`pnpm test` runs only the Docker-free unit project. The `rls` CI job runs this suite on every PR.

## Adding a table

`isolation.test.ts` fails if any table in schema `public` is missing from the registry. When a slice adds tables, add (or extend) its module file in `tests/rls/tables/` (for example `people.ts`) exporting `tables: TableSpec[]`. Do not edit another module's file. Each entry says:

- `key`, `rowOf`: how to find one row for each organisation (add `seed` if the rows don't exist yet; it runs with the secret-key client).
- `tenantColumn`, `tenantValue`: which column ties a row to its organisation (`organisation_id` for every business table).
- `attackInsert`, `patch`: an insert aimed at the other organisation and a harmless update. Both must be rejected or change nothing.

The suite then proves, in both directions, that select returns zero rows and insert, update and delete are blocked, with positive controls.

The helpers read the local stack settings from `supabase status` and refuse any host other than localhost.

# Kickoff: building Metalira Ops in VS Code with Claude Code

## 1. One-time setup (about an hour)

1. **Tools on your computer:** Node.js 20+ LTS, pnpm (`npm i -g pnpm`), Git, Docker Desktop (needed for local Supabase), Supabase CLI, Vercel CLI (optional).
2. **Claude Code in VS Code:** install the Claude Code extension from the VS Code marketplace and sign in.
3. **GitHub:** create a private repo `metalira-ops`, clone it, and copy everything in this kit into it (including the hidden `.claude/` folder). Commit: "Add project brief and Claude Code setup".
4. **Supabase:** create a project named `metalira-ops` in the London (eu-west-2) region on the free plan. Keep the database password in your password manager.
5. **Vercel:** import the GitHub repo as a new project (Hobby while building).
6. **Resend:** add and verify a sending domain (e.g. `mail.yourdomain`) with the SPF and DKIM records it gives you.
7. **Flutterwave:** from the dashboard (test mode), note the public key, secret key, encryption key and set a webhook secret hash. Needed from Phase 2. Never paste these into a chat; they go into `.env.local` and Vercel environment variables only.
8. **Sentry:** create a free Next.js project and note the DSN.
9. **Optional:** add the Supabase MCP server to Claude Code so it can read your project's schema and logs. Give it read-only access to start.

`.claude/settings.json` blocks Claude Code from reading your `.env` files and from pushing migrations to the live database or force-pushing.

## 2. How each work session goes

- Open the repo in VS Code and start Claude Code.
- Switch to **plan mode** (Shift+Tab) before any new slice.
- Use `/slice 0.1 Repo and tooling` to build a slice, and `/phase-check 0` at the end of a phase.
- Review the plan, approve it, let it build, then check the Vercel preview yourself before merging.

## 3. First prompt (paste this in plan mode)

```
Read CLAUDE.md, docs/PRODUCT.md, docs/BUILD_PLAN.md, docs/PHASE_0.md, docs/DATA_MODEL.md and docs/DESIGN_SYSTEM.md.

We are starting Phase 0 of Metalira Ops. The repo is empty apart from these docs.

Give me:
1. A short summary of what Phase 0 delivers and the order of slices 0.1 to 0.5.
2. A detailed plan for slice 0.1 (Repo and tooling): the exact create-next-app options, packages to install, folder structure under src/, scripts in package.json, the GitHub Actions workflow, and the full list of variables for .env.example (names only, no values).
3. Anything in the docs that is unclear or contradicts itself.

Do not write any files until I approve the plan.
```

## 4. Order after Phase 0

Follow docs/BUILD_PLAN.md one phase at a time. Before starting each new phase, ask Claude Code to write `docs/PHASE_<n>.md` in the same shape as PHASE_0.md, review it yourself, then build slice by slice.

# LYMTLESS AI BUILDER

Independent AI-powered no-code/full-code app builder foundation.

## Current capabilities

- Next.js control-plane application
- Supabase authentication + secure control-plane storage
- Natural-language architecture planning with schema-enforced OpenAI Structured Outputs
- Complete Vite/React/TypeScript application generation
- Numbered generated-code versions stored atomically in Supabase
- Dedicated Supabase project provisioning for generated apps that require database/auth/storage
- Guarded generated SQL/RLS setup with migration hashes and Supabase security-advisor checks
- Vercel Sandbox execution for isolated npm install/build/preview
- Up to two AI build-repair passes, each preserved as a new version
- Sandbox egress switches to deny-all before generated preview code starts
- Persistent build runs with install/build/preview logs and preview URL
- Three-pane builder workspace with live iframe preview
- GitHub source control for the builder platform

## Stack

- Next.js 16.4
- React 19.3
- TypeScript
- Supabase
- OpenAI Responses API
- Vercel Sandbox `@vercel/sandbox@3.6.1`

## Setup

1. Create the LYMTLESS control-plane Supabase project and run all migrations in `supabase/migrations/` in numeric order.
2. Copy `.env.example` to `.env.local` and configure the control-plane Supabase and OpenAI variables.
3. Configure Vercel Sandbox authentication using either:
   - `VERCEL_OIDC_TOKEN` (recommended; `vercel link` + `vercel env pull` locally, automatic when deployed on Vercel), or
   - `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID`.
4. To provision isolated Supabase backends for generated apps, configure a server-only scoped Management API token plus `SUPABASE_PLATFORM_ORG_SLUG`. Keep the token out of generated apps and browser code.
5. Install dependencies with `npm install`.
6. Run `npm run dev`.

## Build pipeline

`Prompt → architecture → generated source → numbered version → dedicated app backend (when required) → guarded SQL/RLS → Supabase security advisor → Vercel Sandbox → npm install → production build → automatic repair if needed → egress deny-all → Vite preview server → live preview URL`

## Security boundaries

- Generated code never runs in the LYMTLESS control-plane process.
- Every generated app backend is isolated from the LYMTLESS control-plane database.
- Generated apps receive only their own Supabase URL and publishable key; Management API tokens, DB passwords, and service/secret keys are never injected into the sandbox.
- Generated database passwords are transient and never persisted by LYMTLESS.
- Generated SQL is blocked from privileged roles, `SECURITY DEFINER`, managed-schema DDL/DML, `GRANT ALL`, replication/event triggers, server-file access, and unapproved extensions.
- New generated public tables must enable Row Level Security.
- Generated paths reject traversal, `.git`, `.github`, and credential files.
- Source bundles are capped at 2 MB and code-generation files are SHA-256 hashed.
- Sandbox network access is disabled before generated preview code starts.
- Supabase RLS protects all control-plane records per project owner.

## Current schema-evolution rule

The first schema is applied only to a newly provisioned empty app backend. If a later generated version introduces unseen SQL migrations, the builder blocks the live change until the DEV-branch migration workflow is enabled. This prevents AI-generated edits from mutating a live database directly.

## Next milestones

1. Supabase DEV-branch schema evolution and safe merge-to-production.
2. Browser QA with Playwright and visual regression/repair.
3. Persistent GitHub repositories and two-way sync for generated applications.
4. Select & Edit component targeting.
5. Production deployment and custom domains.

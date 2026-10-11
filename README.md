# LYMTLESS AI BUILDER

Independent AI-powered no-code/full-code app builder foundation.

## Current capabilities

- Next.js control-plane application
- Supabase authentication + secure project storage
- Natural-language architecture planning with schema-enforced OpenAI Structured Outputs
- Complete Vite/React/TypeScript application generation
- Numbered generated-code versions stored atomically in Supabase
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

1. Create a Supabase project.
2. Run all migrations in `supabase/migrations/` in numeric order.
3. Copy `.env.example` to `.env.local` and configure Supabase and OpenAI.
4. Configure Vercel Sandbox authentication using either:
   - `VERCEL_OIDC_TOKEN` (recommended; `vercel link` + `vercel env pull` locally, automatic when deployed on Vercel), or
   - `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID`.
5. Install dependencies with `npm install`.
6. Run `npm run dev`.

## Build pipeline

`Prompt → architecture → generated source → numbered version → Vercel Sandbox → npm install → production build → automatic repair if needed → egress deny-all → Vite preview server → live preview URL`

## Security boundaries

- Generated code never runs in the LYMTLESS control-plane process.
- Generated paths are normalized and reject traversal, `.git`, `.github`, and credential files.
- Source bundles are capped at 2 MB and code-generation files are SHA-256 hashed.
- Sandbox package installation/build occurs without production application secrets.
- Sandbox network access is disabled before generated preview code is started.
- Supabase RLS protects control-plane records per project owner.

## Next milestone

1. Provision/connect a dedicated Supabase backend for each generated application.
2. Apply generated SQL/RLS migrations safely to that application backend.
3. Add browser QA with Playwright and visual regression/repair.
4. Add persistent GitHub repositories and two-way sync for generated applications.
5. Add Select & Edit component targeting.
6. Add production deployment and custom domains.

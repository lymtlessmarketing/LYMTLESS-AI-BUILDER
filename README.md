# LYMTLESS AI BUILDER

Independent AI-powered no-code/full-code app builder foundation.

## Milestone 1 included

- Next.js control-plane application
- Supabase authentication client
- Secure project CRUD API
- AI architecture agent using OpenAI Responses API + schema-enforced Structured Outputs
- Project/message/version/file/deployment/AI-run schema
- Explicit RLS + Data API grants
- Three-pane builder workspace
- GitHub-ready project fields and version model
- GitHub Actions CI for typecheck, lint, and production build

## Stack

- Next.js 16.4
- React 19.3
- TypeScript
- Supabase
- OpenAI Responses API

## Setup

1. Create a Supabase project.
2. Run all migrations in `supabase/migrations/` in numeric order.
3. Copy `.env.example` to `.env.local` and set:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   - `OPENAI_API_KEY`
   - `OPENAI_MODEL` (defaults to `gpt-6.1-sol`)
   - `OPENAI_CODE_MODEL` (optional separate code-generation model)
4. Install dependencies with `npm install`.
5. Run `npm run dev`.

## Current generation pipeline

- Natural-language architecture planning with schema-enforced Structured Outputs
- Complete generated application code bundles
- Path/secret/repository-control validation, 2 MB source limits, and SHA-256 hashes before persistence
- Numbered project versions created transactionally in Supabase
- Generated files persisted per version
- Builder UI displays generation progress and generated source tree

## Next milestone

1. Sandbox executor for install/build/run.
2. Automated build-error repair loop.
3. Playwright browser QA.
4. Real live preview URL.
5. GitHub App repo creation + two-way sync for generated apps.
6. Select-and-edit component targeting.
7. One-click deployment.

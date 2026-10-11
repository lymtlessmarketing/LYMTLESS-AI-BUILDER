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
2. Run both migrations in `supabase/migrations/` in order.
3. Copy `.env.example` to `.env.local` and set:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   - `OPENAI_API_KEY`
   - `OPENAI_MODEL` (defaults to `gpt-6.1-sol`)
4. Install dependencies with `npm install`.
5. Run `npm run dev`.

## Next milestone

1. Code-generation agent that writes files in batches.
2. Sandbox executor for install/build/run.
3. Playwright browser QA + repair loop.
4. Real live preview URL.
5. GitHub App repo creation + two-way sync.
6. Select-and-edit component targeting.
7. One-click deployment.

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
- Playwright browser QA inside the same sandbox at desktop, tablet, and mobile widths
- Browser QA traverses up to eight static blueprint routes and catches blank/collapsed pages, horizontal overflow, broken images, uncaught JS errors, console errors, and critical request failures
- AI visual QA reviews the actual desktop/tablet/mobile screenshots using image input + Structured Outputs
- Visual QA flags concrete production defects such as clipping, overlap, broken responsive composition, unreadable contrast, severe spacing/alignment problems, broken imagery, and visibly unfinished UI
- Browser and visual failures share a bounded two-pass AI repair loop; every repair is preserved as a new generated version and must re-pass all gates
- Sandbox egress switches to deny-all only after browser and visual QA pass
- Persistent build runs store install/build/browser-QA/visual-QA/preview logs and structured findings
- Three-pane builder workspace with live iframe preview and QA status/visual score
- GitHub source control for the builder platform

## Stack

- Next.js 16.4
- React 19.3
- TypeScript
- Supabase
- OpenAI Responses API / Structured Outputs / image input
- Vercel Sandbox `@vercel/sandbox@3.6.1`
- Playwright `1.64.0` installed only inside disposable build sandboxes

## Setup

1. Create the LYMTLESS control-plane Supabase project and run all migrations in `supabase/migrations/` in numeric order.
2. Copy `.env.example` to `.env.local` and configure the control-plane Supabase and OpenAI variables. `OPENAI_VISION_MODEL` defaults to the same model family as `OPENAI_MODEL` when omitted.
3. Configure Vercel Sandbox authentication using either:
   - `VERCEL_OIDC_TOKEN` (recommended; `vercel link` + `vercel env pull` locally, automatic when deployed on Vercel), or
   - `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID`.
4. To provision isolated Supabase backends for generated apps, configure a server-only scoped Management API token plus `SUPABASE_PLATFORM_ORG_SLUG`. Keep the token out of generated apps and browser code.
5. Install dependencies with `npm install`.
6. Run `npm run dev`.

## Build pipeline

`Prompt → architecture → generated source → numbered version → dedicated app backend (when required) → guarded SQL/RLS → Supabase security advisor → Vercel Sandbox → npm install → production build → build repair if needed → Vite preview → Playwright route QA at desktop/tablet/mobile → runtime repair if needed → AI screenshot review → visual repair if needed → all gates rerun → egress deny-all → live preview ready`

## Browser QA gate

A generated version is not marked `tested` or exposed as ready until the browser gate passes. The gate verifies the primary page plus up to seven additional safe static routes from the generated blueprint across 1440px, 768px, and 390px widths.

Checks include:

- successful page navigation/HTTP response
- meaningful rendered UI instead of a blank page
- non-collapsed document layout
- no horizontal viewport overflow
- no broken rendered images
- no uncaught browser/page exceptions
- no browser console errors
- critical request failures retained as warnings for diagnostics

The primary route is captured as full-page screenshots at desktop, tablet, and mobile sizes.

## AI visual QA gate

After browser QA passes, the three primary-route screenshots are read directly from the sandbox and sent to the visual-review model as base64 image inputs. No public screenshot storage is required.

The visual agent returns a typed 0–100 informational quality score plus structured findings. **Only explicit error-level defects block readiness**; subjective polish recommendations remain warnings. This avoids unnecessary redesign loops while still catching defects that DOM/runtime checks cannot see.

If blocking visual defects exist, the visual repair agent produces the smallest source patch it can, saves a new numbered application version, and restarts the complete build → browser QA → visual QA sequence. The total automatic repair budget across all gates is capped at two passes.

## Security boundaries

- Generated code never runs in the LYMTLESS control-plane process.
- Every generated app backend is isolated from the LYMTLESS control-plane database.
- Generated apps receive only their own Supabase URL and publishable key; Management API tokens, DB passwords, and service/secret keys are never injected into the sandbox.
- Generated database passwords are transient and never persisted by LYMTLESS.
- Generated SQL is blocked from privileged roles, `SECURITY DEFINER`, managed-schema DDL/DML, `GRANT ALL`, replication/event triggers, server-file access, and unapproved extensions.
- New generated public tables must enable Row Level Security.
- Generated paths reject traversal, `.git`, `.github`, and credential files.
- Source bundles are capped at 2 MB and code-generation files are SHA-256 hashed.
- Browser screenshots remain inside the ephemeral sandbox and are read into memory only for visual QA.
- Sandbox network access remains available only while dependencies, backend-connected browser QA, and visual QA require it; it is disabled before the user-facing preview is declared ready.
- Supabase RLS protects all control-plane records per project owner.

## Current schema-evolution rule

The first schema is applied only to a newly provisioned empty app backend. If a later generated version introduces unseen SQL migrations, the builder blocks the live change until the DEV-branch migration workflow is enabled. This prevents AI-generated edits from mutating a live database directly.

## Next milestones

1. Persistent GitHub repositories and two-way sync for generated applications.
2. Supabase DEV-branch schema evolution and safe merge-to-production.
3. Select & Edit component targeting.
4. Production deployment and custom domains.
5. Integration marketplace, billing/credits, team collaboration, and broader model routing.

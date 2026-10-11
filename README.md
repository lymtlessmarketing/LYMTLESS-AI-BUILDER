# LYMTLESS AI BUILDER

Independent AI-powered no-code/full-code app builder foundation.

## Current capabilities

- Next.js control-plane application
- Supabase authentication + secure control-plane storage
- Natural-language architecture planning with schema-enforced OpenAI Structured Outputs
- Complete Vite/React/TypeScript application generation
- Numbered generated-code versions stored atomically in Supabase
- Dedicated Supabase project provisioning for generated apps that require database/auth/storage
- Guarded generated SQL/RLS with content-hash migration tracking
- Data-free Supabase DEV branches for generated schema validation and safe merge-to-production
- Additive-only automatic schema evolution for existing app backends
- Supabase security-advisor gates on DEV and production after schema merges
- Vercel Sandbox execution for isolated npm install/build/preview
- Up to two AI build-repair passes, each preserved as a new version
- Sandbox egress switches to deny-all before generated preview code starts
- Persistent build/schema runs with logs, status, and recovery metadata
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
4. To provision isolated Supabase backends for generated apps, configure a **server-only scoped Management API token** plus `SUPABASE_PLATFORM_ORG_SLUG`. Keep that token out of generated apps and browser code.
5. Install dependencies with `npm install`.
6. Run `npm run dev`.

## Supabase Management API token scope

Use the narrowest platform token that supports the builder workflow. It needs access equivalent to:

- Organization Projects: read/write for project creation and recovery lookup
- Project Settings: read for health checks
- API Keys: read/write plus key-secret read so a generated app's publishable key can be retrieved/created
- Database: read/write for guarded schema application and read-only merge verification
- Advisors: read for security gates
- Development Branches: read/write for create/get/merge/delete

Do not grant unrelated organization-management or billing permissions to the runtime token.

## Build pipeline

`Prompt → architecture → generated source → numbered version → dedicated app backend (when required) → guarded SQL/RLS → data-free DEV branch → DEV security advisor → merge → production security advisor → Vercel Sandbox → npm install → production build → automatic repair if needed → egress deny-all → Vite preview server → live preview URL`

## Database schema evolution

Generated app schema changes are never applied directly to an existing production database.

- A DEV branch is created with `with_data: false`; production customer data is not copied into the branch.
- Pending migration files are validated before execution.
- All pending SQL is applied atomically inside one transaction owned by LYMTLESS.
- Transaction-control statements, `CONCURRENTLY`, anonymous `DO` blocks, obvious dynamic SQL, privileged-role operations, managed-schema changes, `SECURITY DEFINER`, and other high-risk constructs are blocked.
- Existing app backends use an additive-only automatic evolution policy. Destructive drops, renames, column-type changes, public data rewrites, new unique constraints/indexes, and other operations that require production-data knowledge are rejected for manual review.
- Supabase's security advisor must be clean on the DEV branch before merge.
- LYMTLESS writes an internal schema marker and waits until that marker reaches production before considering the merge complete.
- Production security advisor is run again after the merge.
- The DEV branch is deleted after success; cleanup failure is tracked separately without falsely marking the schema merge as failed.

## Security boundaries

- Generated code never runs in the LYMTLESS control-plane process.
- Every generated app backend is isolated from the LYMTLESS control-plane database.
- Generated apps receive only their own Supabase URL and publishable key; Management API tokens, DB passwords, and service/secret keys are never injected into the sandbox.
- Generated database passwords are transient and never persisted by LYMTLESS.
- New generated public tables must enable Row Level Security.
- Generated paths reject traversal, `.git`, `.github`, and credential files.
- Source bundles are capped at 2 MB and code-generation files are SHA-256 hashed.
- Sandbox network access is disabled before generated preview code starts.
- Supabase RLS protects all control-plane records per project owner.

## Validation status

Supabase control-plane migrations and security advisors are being executed against the connected LYMTLESS AI BUILDER project. External generated-app provisioning and Vercel Sandbox execution still require their server credentials. This environment cannot reach npm over DNS, so an actual dependency install/typecheck/build of the control-plane repository remains pending until CI or a connected deployment environment runs it.

## Next milestones

1. Browser QA with Playwright and automated visual/runtime repair.
2. Persistent GitHub repositories and two-way sync for generated applications.
3. Select & Edit component targeting.
4. Production deployment and custom domains.
5. Billing, quotas, model routing, and integration marketplace.

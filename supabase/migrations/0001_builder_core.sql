-- LYMTLESS AI BUILDER core control-plane schema.
-- Explicit grants are intentional: Supabase changed new-table Data API exposure defaults in 2026.

create extension if not exists pgcrypto;

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  description text,
  status text not null default 'draft' check (status in ('draft','planned','generating','ready','failed','archived')),
  github_repo_full_name text,
  production_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user','assistant','system')),
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.versions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  version_number bigint not null,
  git_commit_sha text,
  summary text not null,
  status text not null default 'created' check (status in ('created','tested','deployed','failed')),
  created_at timestamptz not null default now(),
  unique (project_id, version_number)
);

create table if not exists public.generated_files (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  version_id uuid references public.versions(id) on delete cascade,
  path text not null,
  content text not null,
  content_hash text,
  created_at timestamptz not null default now(),
  unique (project_id, version_id, path)
);

create table if not exists public.ai_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  run_type text not null check (run_type in ('plan','generate','edit','repair','review')),
  model text not null,
  status text not null check (status in ('queued','running','succeeded','failed')),
  input_tokens bigint,
  output_tokens bigint,
  error_message text,
  created_at timestamptz not null default now()
);

create table if not exists public.deployments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  version_id uuid references public.versions(id) on delete set null,
  environment text not null check (environment in ('preview','production')),
  provider text not null,
  provider_deployment_id text,
  url text,
  status text not null check (status in ('queued','building','ready','failed','canceled')),
  created_at timestamptz not null default now()
);

create index if not exists projects_owner_updated_idx on public.projects(owner_id, updated_at desc);
create index if not exists messages_project_created_idx on public.messages(project_id, created_at);
create index if not exists versions_project_version_idx on public.versions(project_id, version_number desc);
create index if not exists ai_runs_project_created_idx on public.ai_runs(project_id, created_at desc);
create index if not exists deployments_project_created_idx on public.deployments(project_id, created_at desc);

alter table public.projects enable row level security;
alter table public.messages enable row level security;
alter table public.versions enable row level security;
alter table public.generated_files enable row level security;
alter table public.ai_runs enable row level security;
alter table public.deployments enable row level security;

create policy "projects_owner_select" on public.projects for select to authenticated using ((select auth.uid()) = owner_id);
create policy "projects_owner_insert" on public.projects for insert to authenticated with check ((select auth.uid()) = owner_id);
create policy "projects_owner_update" on public.projects for update to authenticated using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
create policy "projects_owner_delete" on public.projects for delete to authenticated using ((select auth.uid()) = owner_id);

create policy "messages_project_owner_select" on public.messages for select to authenticated using (exists (select 1 from public.projects p where p.id = messages.project_id and p.owner_id = (select auth.uid())));
create policy "messages_project_owner_insert" on public.messages for insert to authenticated with check (user_id = (select auth.uid()) and exists (select 1 from public.projects p where p.id = messages.project_id and p.owner_id = (select auth.uid())));

create policy "versions_project_owner_all" on public.versions for all to authenticated
using (created_by = (select auth.uid()) and exists (select 1 from public.projects p where p.id = versions.project_id and p.owner_id = (select auth.uid())))
with check (created_by = (select auth.uid()) and exists (select 1 from public.projects p where p.id = versions.project_id and p.owner_id = (select auth.uid())));

create policy "files_project_owner_all" on public.generated_files for all to authenticated
using (exists (select 1 from public.projects p where p.id = generated_files.project_id and p.owner_id = (select auth.uid())))
with check (exists (select 1 from public.projects p where p.id = generated_files.project_id and p.owner_id = (select auth.uid())));

create policy "ai_runs_project_owner_all" on public.ai_runs for all to authenticated
using (user_id = (select auth.uid()) and exists (select 1 from public.projects p where p.id = ai_runs.project_id and p.owner_id = (select auth.uid())))
with check (user_id = (select auth.uid()) and exists (select 1 from public.projects p where p.id = ai_runs.project_id and p.owner_id = (select auth.uid())));

create policy "deployments_project_owner_all" on public.deployments for all to authenticated
using (exists (select 1 from public.projects p where p.id = deployments.project_id and p.owner_id = (select auth.uid())))
with check (exists (select 1 from public.projects p where p.id = deployments.project_id and p.owner_id = (select auth.uid())));

-- Explicit Data API grants for authenticated users only. RLS remains the row-level authorization boundary.
grant usage on schema public to authenticated;
grant select, insert, update, delete on table public.projects to authenticated;
grant select, insert on table public.messages to authenticated;
grant select, insert, update, delete on table public.versions to authenticated;
grant select, insert, update, delete on table public.generated_files to authenticated;
grant select, insert, update, delete on table public.ai_runs to authenticated;
grant select, insert, update, delete on table public.deployments to authenticated;

revoke all on table public.projects from anon;
revoke all on table public.messages from anon;
revoke all on table public.versions from anon;
revoke all on table public.generated_files from anon;
revoke all on table public.ai_runs from anon;
revoke all on table public.deployments from anon;

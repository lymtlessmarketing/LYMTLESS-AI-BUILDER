create table if not exists public.backend_schema_runs (
  id uuid primary key default gen_random_uuid(),
  app_backend_id uuid not null references public.app_backends(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  source_version_id uuid not null references public.versions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  branch_name text not null,
  branch_ref text,
  status text not null default 'queued' check (status in ('queued','creating','applying','validating','merging','merged','failed','cleanup_failed')),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (app_backend_id, source_version_id)
);

create index if not exists backend_schema_runs_project_created_idx on public.backend_schema_runs(project_id, created_at desc);
create index if not exists backend_schema_runs_user_id_idx on public.backend_schema_runs(user_id);
create index if not exists backend_schema_runs_branch_ref_idx on public.backend_schema_runs(branch_ref) where branch_ref is not null;

alter table public.backend_schema_runs enable row level security;

create policy "backend_schema_runs_project_owner_all" on public.backend_schema_runs for all to authenticated
using (
  user_id = (select auth.uid())
  and exists (
    select 1 from public.projects p
    where p.id = backend_schema_runs.project_id
      and p.owner_id = (select auth.uid())
  )
)
with check (
  user_id = (select auth.uid())
  and exists (
    select 1 from public.projects p
    where p.id = backend_schema_runs.project_id
      and p.owner_id = (select auth.uid())
  )
);

grant select, insert, update, delete on table public.backend_schema_runs to authenticated;
revoke all on table public.backend_schema_runs from anon;

create trigger backend_schema_runs_set_updated_at
before update on public.backend_schema_runs
for each row
execute function public.set_updated_at();

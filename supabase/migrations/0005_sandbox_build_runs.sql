create table if not exists public.build_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  version_id uuid not null references public.versions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null default 'vercel-sandbox',
  sandbox_id text,
  status text not null default 'queued' check (status in ('queued','creating','installing','building','repairing','starting','ready','failed','stopped')),
  repair_attempts integer not null default 0 check (repair_attempts between 0 and 5),
  install_log text,
  build_log text,
  preview_log text,
  preview_url text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists build_runs_project_created_idx on public.build_runs(project_id, created_at desc);
create index if not exists build_runs_version_id_idx on public.build_runs(version_id);
create index if not exists build_runs_user_id_idx on public.build_runs(user_id);

alter table public.build_runs enable row level security;

create policy "build_runs_project_owner_all" on public.build_runs for all to authenticated
using (
  user_id = (select auth.uid())
  and exists (
    select 1 from public.projects p
    where p.id = build_runs.project_id
      and p.owner_id = (select auth.uid())
  )
)
with check (
  user_id = (select auth.uid())
  and exists (
    select 1 from public.projects p
    where p.id = build_runs.project_id
      and p.owner_id = (select auth.uid())
  )
);

grant select, insert, update, delete on table public.build_runs to authenticated;
revoke all on table public.build_runs from anon;

create trigger build_runs_set_updated_at
before update on public.build_runs
for each row
execute function public.set_updated_at();

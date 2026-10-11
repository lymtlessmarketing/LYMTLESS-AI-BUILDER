create table if not exists public.backend_migrations (
  id uuid primary key default gen_random_uuid(),
  app_backend_id uuid not null references public.app_backends(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  source_version_id uuid not null references public.versions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  path text not null,
  content_hash text not null,
  migration_name text not null,
  status text not null default 'queued' check (status in ('queued','applying','applied','failed')),
  error_message text,
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  unique (app_backend_id, content_hash)
);

create index if not exists backend_migrations_project_created_idx on public.backend_migrations(project_id, created_at desc);
create index if not exists backend_migrations_user_id_idx on public.backend_migrations(user_id);
create index if not exists backend_migrations_version_id_idx on public.backend_migrations(source_version_id);

alter table public.backend_migrations enable row level security;

create policy "backend_migrations_project_owner_all" on public.backend_migrations for all to authenticated
using (
  user_id = (select auth.uid())
  and exists (
    select 1 from public.projects p
    where p.id = backend_migrations.project_id
      and p.owner_id = (select auth.uid())
  )
)
with check (
  user_id = (select auth.uid())
  and exists (
    select 1 from public.projects p
    where p.id = backend_migrations.project_id
      and p.owner_id = (select auth.uid())
  )
);

grant select, insert, update, delete on table public.backend_migrations to authenticated;
revoke all on table public.backend_migrations from anon;

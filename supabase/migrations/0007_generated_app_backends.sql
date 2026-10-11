create table if not exists public.app_backends (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null unique references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null default 'supabase' check (provider = 'supabase'),
  external_project_ref text unique,
  organization_slug text,
  region text,
  status text not null default 'queued' check (status in ('queued','provisioning','healthy','configuring','ready','failed')),
  api_url text,
  publishable_key text,
  schema_version_id uuid references public.versions(id) on delete set null,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists app_backends_user_id_idx on public.app_backends(user_id);
create index if not exists app_backends_status_idx on public.app_backends(status);
create index if not exists app_backends_schema_version_id_idx on public.app_backends(schema_version_id) where schema_version_id is not null;

alter table public.app_backends enable row level security;

create policy "app_backends_project_owner_all" on public.app_backends for all to authenticated
using (
  user_id = (select auth.uid())
  and exists (select 1 from public.projects p where p.id = app_backends.project_id and p.owner_id = (select auth.uid()))
)
with check (
  user_id = (select auth.uid())
  and exists (select 1 from public.projects p where p.id = app_backends.project_id and p.owner_id = (select auth.uid()))
);

grant select, insert, update, delete on table public.app_backends to authenticated;
revoke all on table public.app_backends from anon;

create trigger app_backends_set_updated_at
before update on public.app_backends
for each row
execute function public.set_updated_at();

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
create index if not exists backend_migrations_version_id_idx on public.backend_migrations(source_version_id);
create index if not exists backend_migrations_user_id_idx on public.backend_migrations(user_id);

alter table public.backend_migrations enable row level security;

create policy "backend_migrations_project_owner_all" on public.backend_migrations for all to authenticated
using (
  user_id = (select auth.uid())
  and exists (select 1 from public.projects p where p.id = backend_migrations.project_id and p.owner_id = (select auth.uid()))
)
with check (
  user_id = (select auth.uid())
  and exists (select 1 from public.projects p where p.id = backend_migrations.project_id and p.owner_id = (select auth.uid()))
);

grant select, insert, update, delete on table public.backend_migrations to authenticated;
revoke all on table public.backend_migrations from anon;

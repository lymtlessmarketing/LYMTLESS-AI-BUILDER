create table if not exists public.hosting_projects (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null unique references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null default 'vercel' check (provider in ('vercel')),
  provider_project_id text not null,
  provider_project_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.project_domains (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  hosting_project_id uuid not null references public.hosting_projects(id) on delete cascade,
  domain text not null,
  status text not null default 'pending' check (status in ('pending','verification_required','misconfigured','ready','failed')),
  verified boolean not null default false,
  verification jsonb not null default '[]'::jsonb,
  dns_config jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, domain)
);

create index if not exists hosting_projects_user_id_idx on public.hosting_projects(user_id);
create index if not exists project_domains_project_status_idx on public.project_domains(project_id, status);
create index if not exists project_domains_user_id_idx on public.project_domains(user_id);

alter table public.hosting_projects enable row level security;
alter table public.project_domains enable row level security;

create policy "hosting_projects_owner_all" on public.hosting_projects for all to authenticated
using (user_id = (select auth.uid()) and exists (select 1 from public.projects p where p.id = hosting_projects.project_id and p.owner_id = (select auth.uid())))
with check (user_id = (select auth.uid()) and exists (select 1 from public.projects p where p.id = hosting_projects.project_id and p.owner_id = (select auth.uid())));

create policy "project_domains_owner_all" on public.project_domains for all to authenticated
using (user_id = (select auth.uid()) and exists (select 1 from public.projects p where p.id = project_domains.project_id and p.owner_id = (select auth.uid())))
with check (user_id = (select auth.uid()) and exists (select 1 from public.projects p where p.id = project_domains.project_id and p.owner_id = (select auth.uid())));

grant select, insert, update, delete on table public.hosting_projects to authenticated;
grant select, insert, update, delete on table public.project_domains to authenticated;
revoke all on table public.hosting_projects from anon;
revoke all on table public.project_domains from anon;

create trigger hosting_projects_set_updated_at before update on public.hosting_projects for each row execute function public.set_updated_at();
create trigger project_domains_set_updated_at before update on public.project_domains for each row execute function public.set_updated_at();

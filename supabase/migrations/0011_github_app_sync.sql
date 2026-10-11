alter table public.projects
  add column if not exists github_repo_id bigint,
  add column if not exists github_default_branch text not null default 'main',
  add column if not exists github_last_synced_sha text,
  add column if not exists github_sync_status text not null default 'disconnected' check (github_sync_status in ('disconnected','connected','syncing','synced','dirty','failed')),
  add column if not exists github_sync_error text;

create unique index if not exists projects_github_repo_id_unique on public.projects(github_repo_id) where github_repo_id is not null;
create unique index if not exists projects_github_repo_full_name_unique on public.projects(github_repo_full_name) where github_repo_full_name is not null;

create table if not exists public.github_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  github_user_id bigint not null,
  github_login text not null,
  access_token_ciphertext text not null,
  access_token_iv text not null,
  access_token_tag text not null,
  refresh_token_ciphertext text,
  refresh_token_iv text,
  refresh_token_tag text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  installation_id bigint,
  status text not null default 'authorized' check (status in ('authorized','installed','revoked','error')),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.github_connections enable row level security;
revoke all on table public.github_connections from anon, authenticated;

create index if not exists github_connections_github_user_id_idx on public.github_connections(github_user_id);
create index if not exists github_connections_installation_id_idx on public.github_connections(installation_id) where installation_id is not null;

create trigger github_connections_set_updated_at
before update on public.github_connections
for each row execute function public.set_updated_at();

create table if not exists public.github_webhook_deliveries (
  delivery_id text primary key,
  event_name text not null,
  github_repo_id bigint,
  received_at timestamptz not null default now()
);

alter table public.github_webhook_deliveries enable row level security;
revoke all on table public.github_webhook_deliveries from anon, authenticated;

create index if not exists github_webhook_deliveries_received_idx on public.github_webhook_deliveries(received_at desc);

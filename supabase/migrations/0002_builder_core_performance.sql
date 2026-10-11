create index if not exists ai_runs_user_id_idx on public.ai_runs(user_id);
create index if not exists deployments_version_id_idx on public.deployments(version_id) where version_id is not null;
create index if not exists generated_files_version_id_idx on public.generated_files(version_id) where version_id is not null;
create index if not exists messages_user_id_idx on public.messages(user_id);
create index if not exists versions_created_by_idx on public.versions(created_by);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.set_updated_at() from public, anon, authenticated;

create trigger projects_set_updated_at
before update on public.projects
for each row
execute function public.set_updated_at();

alter table public.projects
  add column if not exists blueprint jsonb,
  add column if not exists current_version_id uuid references public.versions(id) on delete set null;

create index if not exists projects_current_version_id_idx
  on public.projects(current_version_id)
  where current_version_id is not null;

create or replace function public.create_project_version(p_project_id uuid, p_summary text)
returns public.versions
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_next bigint;
  v_row public.versions;
begin
  perform 1
  from public.projects
  where id = p_project_id
    and owner_id = (select auth.uid())
  for update;

  if not found then
    raise exception 'Project not found or access denied';
  end if;

  select coalesce(max(version_number), 0) + 1
  into v_next
  from public.versions
  where project_id = p_project_id;

  insert into public.versions(project_id, created_by, version_number, summary, status)
  values (p_project_id, (select auth.uid()), v_next, p_summary, 'created')
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.create_project_version(uuid, text) from public, anon;
grant execute on function public.create_project_version(uuid, text) to authenticated;

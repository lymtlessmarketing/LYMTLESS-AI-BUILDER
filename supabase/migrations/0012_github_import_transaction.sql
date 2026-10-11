create or replace function public.commit_github_import(
  p_project_id uuid,
  p_user_id uuid,
  p_commit_sha text,
  p_summary text,
  p_files jsonb
)
returns table(id uuid, version_number bigint)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner uuid;
  v_next bigint;
  v_version_id uuid;
begin
  select owner_id into v_owner
  from public.projects
  where projects.id = p_project_id
  for update;

  if v_owner is null or v_owner <> p_user_id then
    raise exception 'Project not found or owner mismatch';
  end if;

  if jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) = 0 then
    raise exception 'GitHub import contains no files';
  end if;

  select coalesce(max(v.version_number), 0) + 1
  into v_next
  from public.versions v
  where v.project_id = p_project_id;

  insert into public.versions(project_id, created_by, version_number, git_commit_sha, summary, status)
  values (p_project_id, p_user_id, v_next, p_commit_sha, p_summary, 'created')
  returning versions.id into v_version_id;

  insert into public.generated_files(project_id, version_id, path, content, content_hash)
  select
    p_project_id,
    v_version_id,
    item->>'path',
    item->>'content',
    nullif(item->>'content_hash', '')
  from jsonb_array_elements(p_files) item;

  update public.projects
  set current_version_id = v_version_id,
      status = 'draft',
      github_last_synced_sha = p_commit_sha,
      github_sync_status = 'synced',
      github_sync_error = null
  where projects.id = p_project_id;

  return query select v_version_id, v_next;
end;
$$;

revoke all on function public.commit_github_import(uuid, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.commit_github_import(uuid, uuid, text, text, jsonb) to service_role;

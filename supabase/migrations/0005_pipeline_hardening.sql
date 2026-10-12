create or replace function public.commit_project_generation(
  p_project_id uuid,
  p_summary text,
  p_files jsonb
)
returns public.versions
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_next bigint;
  v_row public.versions;
  v_file_count integer;
begin
  if jsonb_typeof(p_files) <> 'array' then
    raise exception 'Generated files payload must be an array';
  end if;

  v_file_count := jsonb_array_length(p_files);
  if v_file_count < 1 or v_file_count > 80 then
    raise exception 'Generated files payload must contain between 1 and 80 files';
  end if;

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

  insert into public.generated_files(project_id, version_id, path, content, content_hash)
  select p_project_id, v_row.id, f.path, f.content, f.content_hash
  from jsonb_to_recordset(p_files) as f(path text, content text, content_hash text);

  -- A generated bundle is not "ready" until the sandbox has installed,
  -- compiled, started, and passed its readiness probe.
  update public.projects
  set status = 'generating', current_version_id = v_row.id
  where id = p_project_id;

  return v_row;
end;
$$;

revoke all on function public.commit_project_generation(uuid, text, jsonb) from public, anon;
grant execute on function public.commit_project_generation(uuid, text, jsonb) to authenticated;

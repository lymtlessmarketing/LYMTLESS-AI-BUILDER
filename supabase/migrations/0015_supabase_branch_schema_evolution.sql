alter table public.backend_schema_runs
  add column if not exists branch_project_ref text,
  add column if not exists validation_log text,
  add column if not exists diff_payload jsonb not null default '{}'::jsonb,
  add column if not exists security_findings jsonb not null default '[]'::jsonb,
  add column if not exists merge_workflow_run_id text,
  add column if not exists merged_at timestamptz;

create index if not exists backend_schema_runs_status_idx on public.backend_schema_runs(status);

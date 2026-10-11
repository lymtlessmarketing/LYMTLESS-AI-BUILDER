alter table public.build_runs add column if not exists sandbox_name text;

create index if not exists build_runs_sandbox_name_idx
  on public.build_runs(sandbox_name)
  where sandbox_name is not null;

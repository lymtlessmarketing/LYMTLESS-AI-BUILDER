alter table public.build_runs drop constraint if exists build_runs_status_check;
alter table public.build_runs add constraint build_runs_status_check check (
  status in ('queued','creating','installing','building','repairing','starting','testing','ready','failed','stopped')
);

alter table public.build_runs
  add column if not exists qa_status text check (qa_status in ('pending','running','passed','failed')),
  add column if not exists qa_log text,
  add column if not exists qa_findings jsonb not null default '[]'::jsonb;

alter table public.build_runs
  add column if not exists visual_status text check (visual_status in ('pending','running','passed','failed')),
  add column if not exists visual_log text,
  add column if not exists visual_findings jsonb not null default '[]'::jsonb;

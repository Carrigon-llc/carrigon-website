-- Which profile (Carrigon alone, or the CarriSys JV) an analysis run was scored against.
alter table public.analysis_runs
  add column if not exists profile text not null default 'Carrigon';

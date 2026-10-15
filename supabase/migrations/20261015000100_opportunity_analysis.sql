-- Opportunity analysis: shared company profile + saved CSV analysis runs.

-- Single-row-per-key settings shared by all admins (e.g. the company profile
-- that opportunities are scored against).
create table if not exists public.admin_settings (
  key text primary key,
  value text not null,
  updated_by text default (auth.jwt() ->> 'email'),
  updated_at timestamptz not null default now()
);

alter table public.admin_settings enable row level security;

drop policy if exists "admins manage settings" on public.admin_settings;
create policy "admins manage settings" on public.admin_settings
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Each uploaded SAM.gov CSV and its ranked results.
create table if not exists public.analysis_runs (
  id uuid primary key default gen_random_uuid(),
  file_name text,
  opportunity_count integer not null default 0,
  results jsonb not null,
  created_by text default (auth.jwt() ->> 'email'),
  created_at timestamptz not null default now()
);

alter table public.analysis_runs enable row level security;

drop policy if exists "admins manage analysis runs" on public.analysis_runs;
create policy "admins manage analysis runs" on public.analysis_runs
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

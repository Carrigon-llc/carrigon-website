-- Carrigon admin portal: contract tracking + SAM.gov search cache.
-- Run in the Supabase SQL editor (or `supabase db push`).

-- Who may use the admin portal. Being signed in is not enough; the email
-- must also be listed here. Add people with:
--   insert into public.admin_users (email) values ('name@carrigon.com');
create table if not exists public.admin_users (
  email text primary key,
  created_at timestamptz not null default now()
);

alter table public.admin_users enable row level security;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admin_users
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

drop policy if exists "admins read admin list" on public.admin_users;
create policy "admins read admin list" on public.admin_users
  for select to authenticated using (public.is_admin());

-- Contracts we are pursuing, have bid on, won, or lost.
create table if not exists public.contracts (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  agency text,
  solicitation_number text,
  sam_notice_id text unique,
  naics_code text,
  set_aside text,
  status text not null default 'pursuing'
    check (status in ('pursuing', 'submitted', 'won', 'lost', 'no_bid', 'cancelled')),
  response_deadline timestamptz,
  bid_submitted_on date,
  bid_amount numeric(14, 2),
  award_amount numeric(14, 2),
  award_date date,
  period_start date,
  period_end date,
  revenue numeric(14, 2) not null default 0,
  costs numeric(14, 2) not null default 0,
  contract_number text,
  contact_name text,
  contact_email text,
  sam_url text,
  notes text,
  created_by text default (auth.jwt() ->> 'email'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists contracts_status_idx on public.contracts (status);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists contracts_touch on public.contracts;
create trigger contracts_touch before update on public.contracts
  for each row execute function public.touch_updated_at();

alter table public.contracts enable row level security;

drop policy if exists "admins manage contracts" on public.contracts;
create policy "admins manage contracts" on public.contracts
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Short-lived cache of SAM.gov responses so repeat searches don't burn the
-- API key's daily request quota. Only the edge function (service role) uses it.
create table if not exists public.sam_cache (
  cache_key text primary key,
  payload jsonb not null,
  fetched_at timestamptz not null default now()
);

alter table public.sam_cache enable row level security;
-- No policies: inaccessible to browser clients; the service role bypasses RLS.

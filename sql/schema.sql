-- REAWAKEN · esquema para Supabase
-- Pégalo completo en el SQL Editor de tu proyecto y ejecútalo una sola vez.

create table if not exists public.sessions (
  id          text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  day_id      text not null,
  started_at  bigint not null,
  finished_at bigint,
  entries     jsonb not null default '{}'::jsonb,
  notes       text,
  deleted_at  bigint,
  updated_at  bigint not null
);

create table if not exists public.measures (
  id         text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  at         bigint not null,
  values     jsonb not null default '{}'::jsonb,
  deleted_at bigint,
  updated_at bigint not null
);

create table if not exists public.routines (
  id         text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null,
  days       jsonb not null default '[]'::jsonb,
  active     boolean not null default false,
  updated_at bigint not null
);

create index if not exists sessions_user_idx on public.sessions (user_id, started_at desc);
create index if not exists measures_user_idx on public.measures (user_id, at desc);
create index if not exists routines_user_idx on public.routines (user_id);

-- Cada quien ve y escribe únicamente sus propias filas.
alter table public.sessions enable row level security;
alter table public.measures enable row level security;
alter table public.routines enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['sessions', 'measures', 'routines'] loop
    execute format('drop policy if exists "own rows select" on public.%I', t);
    execute format('drop policy if exists "own rows insert" on public.%I', t);
    execute format('drop policy if exists "own rows update" on public.%I', t);
    execute format('drop policy if exists "own rows delete" on public.%I', t);

    execute format('create policy "own rows select" on public.%I for select using (auth.uid() = user_id)', t);
    execute format('create policy "own rows insert" on public.%I for insert with check (auth.uid() = user_id)', t);
    execute format('create policy "own rows update" on public.%I for update using (auth.uid() = user_id) with check (auth.uid() = user_id)', t);
    execute format('create policy "own rows delete" on public.%I for delete using (auth.uid() = user_id)', t);
  end loop;
end $$;

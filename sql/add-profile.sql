alter table public.routines add column if not exists profile jsonb;
notify pgrst, 'reload schema';
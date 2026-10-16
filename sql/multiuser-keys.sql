-- REAWAKEN · migración para proyectos creados con schema.sql anterior
-- No ejecutar ahora. Aplicar solo al preparar Supabase multiusuario.
-- La clave de cada fila debe estar aislada por usuario: `active` puede existir
-- en muchas cuentas distintas.

begin;

alter table public.sessions drop constraint if exists sessions_pkey;
alter table public.sessions add constraint sessions_pkey primary key (user_id, id);

alter table public.measures drop constraint if exists measures_pkey;
alter table public.measures add constraint measures_pkey primary key (user_id, id);

alter table public.routines drop constraint if exists routines_pkey;
alter table public.routines add constraint routines_pkey primary key (user_id, id);

commit;

notify pgrst, 'reload schema';

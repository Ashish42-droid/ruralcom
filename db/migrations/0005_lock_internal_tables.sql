-- =============================================================
-- 0005 — Lock internal tables
--
-- `schema_migrations` lives in the public schema, so PostgREST exposes it
-- to any authenticated caller. It leaks nothing dangerous, but publishing
-- the migration history of a healthcare system is free reconnaissance.
--
-- RLS on with no policies = deny all. The service role and direct SQL
-- connections still reach it, which is all the migration runner needs.
-- =============================================================

alter table public.schema_migrations enable row level security;

revoke all on public.schema_migrations from anon, authenticated;

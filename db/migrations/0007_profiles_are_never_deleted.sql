-- =============================================================
-- 0007 — Profiles are deactivated, never deleted
--
-- FOUND WHILE TESTING.
--
-- `audit_log.actor_id` was declared ON DELETE SET NULL. Deleting a profile
-- therefore fired an UPDATE on audit_log, which the append-only trigger
-- (0002) correctly refused — so the delete failed with the thoroughly
-- confusing message "audit_log is append-only: UPDATE is not permitted".
--
-- Two things were wrong:
--   1. The error named the wrong table, so the real cause was invisible.
--   2. SET NULL would have ERASED ATTRIBUTION in the audit trail. An audit
--      log that forgets who acted is not an audit log. Deleting a doctor
--      would have anonymised every decision they ever made.
--
-- Correct behaviour: RESTRICT. Accounts are deactivated (is_active = false),
-- never hard-deleted, which is already the documented policy. The database
-- now enforces it and says so plainly.
-- =============================================================

alter table public.audit_log
  drop constraint if exists audit_log_actor_id_fkey;

alter table public.audit_log
  add constraint audit_log_actor_id_fkey
  foreign key (actor_id) references public.profiles(id)
  on delete restrict;

comment on constraint audit_log_actor_id_fkey on public.audit_log is
  'RESTRICT, not SET NULL: deleting a profile must never erase attribution '
  'in the audit trail. Deactivate the account instead (is_active = false).';

-- Make the failure legible when someone tries anyway.
create or replace function public.guard_profile_delete()
returns trigger
language plpgsql
as $$
declare
  audit_count integer;
begin
  select count(*) into audit_count from public.audit_log where actor_id = old.id;

  if audit_count > 0 then
    raise exception
      'profile % has % audit entries and cannot be deleted; set is_active = false instead',
      old.id, audit_count
      using errcode = '23503',
            hint = 'Accounts are deactivated, never deleted, so the audit trail keeps its attribution.';
  end if;

  return old;
end;
$$;

create trigger profiles_guard_delete
  before delete on public.profiles
  for each row execute function public.guard_profile_delete();

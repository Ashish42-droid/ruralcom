-- =============================================================
-- 0006 — Fix privilege escalation on profiles
--
-- BUG FOUND BY tests/rls.test.js.
--
-- Migration 0004 did `revoke update (role, is_active, ...) from authenticated`
-- and that silently achieved nothing. Supabase grants a TABLE-LEVEL
-- `UPDATE` on public tables to `authenticated`; a table-level grant covers
-- every column, and revoking a column-level privilege does not carve a hole
-- out of it. Postgres reported success and changed nothing.
--
-- Combined with the `profiles_update_self` policy, any signed-in staff
-- member could have set their own role to super_admin. The trigger from 0004
-- was the only thing stopping it — a single control where there should be
-- two.
--
-- Correct sequence: revoke the table-level grant FIRST, then grant back only
-- the specific columns.
-- =============================================================

revoke update on public.profiles from authenticated;

grant update (full_name, phone, preferred_language)
  on public.profiles to authenticated;

-- Accounts are created and removed only through the service role, which is
-- additionally guarded by the provisioning trigger (0001).
revoke insert, delete on public.profiles from authenticated;

-- Same class of problem on the role-detail tables: a doctor should be able
-- to flip their own availability and nothing else.
revoke update on public.doctors from authenticated;
grant  update (availability_status) on public.doctors to authenticated;
revoke insert, delete on public.doctors from authenticated;

revoke insert, update, delete on public.clinical_assistants from authenticated;
revoke insert, update, delete on public.admin_scopes        from authenticated;
revoke insert, update, delete on public.staff_invitations   from authenticated;

-- The audit log accepts inserts and nothing else. The 0002 triggers block
-- update/delete regardless, but the grant should agree with the intent.
revoke update, delete on public.audit_log from authenticated;

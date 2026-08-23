-- =============================================================
-- 0004 — Privilege-escalation guards
--
-- `profiles_update_self` lets staff correct their own contact details. That
-- policy alone would also let them set their own role to super_admin, since
-- RLS is row-level and not column-level. Two independent controls close it.
-- =============================================================

-- Control 1: column-level grant. `authenticated` simply has no UPDATE
-- privilege on the sensitive columns.
revoke update (role, is_active, created_by, id) on public.profiles from authenticated;
grant  update (full_name, phone, preferred_language) on public.profiles to authenticated;

-- Control 2: trigger. Catches anything that reaches the table by another
-- route, including a future policy written carelessly.
create or replace function public.guard_profile_privilege_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_role public.user_role;
begin
  if new.role is distinct from old.role
     or new.is_active is distinct from old.is_active
     or new.created_by is distinct from old.created_by then

    -- auth.uid() is null for service-role and direct SQL connections, which
    -- are trusted paths (the API layer authorises them and writes an audit
    -- row). Sessions carrying a user JWT must be an admin.
    if auth.uid() is not null then
      select role into actor_role from public.profiles where id = auth.uid();

      if actor_role is null or actor_role not in
         ('super_admin','state_admin','district_admin') then
        raise exception
          'role, is_active and created_by may only be changed by an admin'
          using errcode = '42501';
      end if;

      if new.id = auth.uid() and new.role is distinct from old.role then
        raise exception 'an account may not change its own role'
          using errcode = '42501';
      end if;
    end if;
  end if;

  return new;
end;
$$;

create trigger profiles_guard_privilege_change
  before update on public.profiles
  for each row execute function public.guard_profile_privilege_change();

-- -------------------------------------------------------------
-- Deactivation must not leave a live session behind.
--
-- The JWT hook already refuses to mint claims for an inactive account, but
-- an access token issued before deactivation stays valid until it expires.
-- Recording the moment lets the API reject tokens issued earlier.
-- -------------------------------------------------------------
alter table public.profiles
  add column deactivated_at timestamptz;

create or replace function public.stamp_deactivation()
returns trigger
language plpgsql
as $$
begin
  if new.is_active = false and old.is_active = true then
    new.deactivated_at := now();
  elsif new.is_active = true and old.is_active = false then
    new.deactivated_at := null;
  end if;
  return new;
end;
$$;

create trigger profiles_stamp_deactivation
  before update on public.profiles
  for each row execute function public.stamp_deactivation();

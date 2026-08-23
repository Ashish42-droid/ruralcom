-- =============================================================
-- 0003 — JWT custom claims + row-level security
--
-- RLS policies read role and scope from JWT claims rather than joining back
-- to `profiles` on every check. A policy that does a subquery per row is a
-- policy that makes the doctor dashboard slow.
--
-- REQUIRES a dashboard step: Authentication -> Hooks -> Customize Access
-- Token (JWT) Claims -> select public.custom_access_token_hook.
-- Without it, claims are absent and every policy denies. See docs/SETUP.md.
-- =============================================================

-- -------------------------------------------------------------
-- Access token hook — injects role and scope into every JWT
-- -------------------------------------------------------------
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  claims      jsonb;
  v_role      public.user_role;
  v_active    boolean;
  v_facility  uuid;
  v_district  uuid;
  v_state     uuid;
begin
  claims := coalesce(event->'claims', '{}'::jsonb);

  select p.role, p.is_active into v_role, v_active
  from public.profiles p
  where p.id = (event->>'user_id')::uuid;

  if v_role is null then
    -- No profile: an auth user with no staff record. Issue a token with no
    -- role so every policy denies, rather than failing the login opaquely.
    return jsonb_set(event, '{claims}', claims || jsonb_build_object('app_role', null));
  end if;

  -- Deactivated accounts get a token that cannot pass any policy.
  if not v_active then
    return jsonb_set(
      event, '{claims}',
      claims || jsonb_build_object('app_role', null, 'account_active', false)
    );
  end if;

  select ca.facility_id, f.district_id, d.state_id
    into v_facility, v_district, v_state
  from public.clinical_assistants ca
  join public.facilities f on f.id = ca.facility_id
  join public.districts  d on d.id = f.district_id
  where ca.profile_id = (event->>'user_id')::uuid;

  if v_district is null then
    select doc.district_id, dd.state_id
      into v_district, v_state
    from public.doctors doc
    join public.districts dd on dd.id = doc.district_id
    where doc.profile_id = (event->>'user_id')::uuid;
  end if;

  if v_district is null and v_state is null then
    select a.district_id,
           coalesce(a.state_id, (select state_id from public.districts where id = a.district_id))
      into v_district, v_state
    from public.admin_scopes a
    where a.profile_id = (event->>'user_id')::uuid;
  end if;

  claims := claims || jsonb_build_object(
    'app_role',       v_role,
    'account_active', true,
    'facility_id',    v_facility,
    'district_id',    v_district,
    'state_id',       v_state
  );

  return jsonb_set(event, '{claims}', claims);
end;
$$;

grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from authenticated, anon, public;

-- -------------------------------------------------------------
-- Claim accessors used by policies
-- -------------------------------------------------------------

create or replace function public.jwt_role()
returns public.user_role
language sql stable
as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claims', true)::jsonb ->> 'app_role',
      ''
    ), ''
  )::public.user_role;
$$;

create or replace function public.jwt_facility_id()
returns uuid
language sql stable
as $$
  select nullif(
    coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'facility_id', ''), ''
  )::uuid;
$$;

create or replace function public.jwt_district_id()
returns uuid
language sql stable
as $$
  select nullif(
    coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'district_id', ''), ''
  )::uuid;
$$;

create or replace function public.jwt_state_id()
returns uuid
language sql stable
as $$
  select nullif(
    coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'state_id', ''), ''
  )::uuid;
$$;

/** Any admin-family role. */
create or replace function public.is_admin()
returns boolean
language sql stable
as $$
  select public.jwt_role() in ('super_admin','state_admin','district_admin');
$$;

/** Roles permitted to read audit history. */
create or replace function public.can_read_audit()
returns boolean
language sql stable
as $$
  select public.jwt_role() in ('super_admin','state_admin','district_admin','auditor');
$$;

/**
 * Is the caller's admin scope wide enough to reach this district?
 * super_admin sees everything; state_admin sees its state; district_admin
 * sees only its own district.
 */
create or replace function public.admin_covers_district(target_district uuid)
returns boolean
language sql stable
security definer
set search_path = public
as $$
  select case public.jwt_role()
    when 'super_admin'   then true
    when 'state_admin'   then exists (
      select 1 from public.districts d
      where d.id = target_district and d.state_id = public.jwt_state_id()
    )
    when 'district_admin' then target_district = public.jwt_district_id()
    else false
  end;
$$;

-- =============================================================
-- Enable RLS everywhere. Default deny.
-- =============================================================
alter table public.states              enable row level security;
alter table public.districts           enable row level security;
alter table public.facilities          enable row level security;
alter table public.profiles            enable row level security;
alter table public.admin_scopes        enable row level security;
alter table public.doctors             enable row level security;
alter table public.clinical_assistants enable row level security;
alter table public.audit_log           enable row level security;
alter table public.staff_invitations   enable row level security;

-- -------------------------------------------------------------
-- Geography: readable by any active staff member; written by admins in scope.
-- -------------------------------------------------------------
create policy states_read on public.states
  for select to authenticated
  using (public.jwt_role() is not null);

create policy states_write on public.states
  for all to authenticated
  using (public.jwt_role() = 'super_admin')
  with check (public.jwt_role() = 'super_admin');

create policy districts_read on public.districts
  for select to authenticated
  using (public.jwt_role() is not null);

create policy districts_write on public.districts
  for all to authenticated
  using (public.jwt_role() in ('super_admin','state_admin'))
  with check (public.jwt_role() in ('super_admin','state_admin'));

create policy facilities_read on public.facilities
  for select to authenticated
  using (public.jwt_role() is not null);

create policy facilities_write on public.facilities
  for all to authenticated
  using (public.is_admin() and public.admin_covers_district(district_id))
  with check (public.is_admin() and public.admin_covers_district(district_id));

-- -------------------------------------------------------------
-- Profiles
--
-- Everyone reads their own. Admins read within scope. Clinical staff read
-- doctor/assistant profiles in their district so the UI can render names on
-- a queue without a service-role call.
-- -------------------------------------------------------------
create policy profiles_read_self on public.profiles
  for select to authenticated
  using (id = auth.uid());

create policy profiles_read_admin_scope on public.profiles
  for select to authenticated
  using (
    public.is_admin()
    and (
      public.jwt_role() = 'super_admin'
      or exists (
        select 1 from public.doctors d
        where d.profile_id = profiles.id and public.admin_covers_district(d.district_id)
      )
      or exists (
        select 1 from public.clinical_assistants ca
        join public.facilities f on f.id = ca.facility_id
        where ca.profile_id = profiles.id and public.admin_covers_district(f.district_id)
      )
    )
  );

create policy profiles_read_clinical_peers on public.profiles
  for select to authenticated
  using (
    public.jwt_role() in ('doctor','senior_doctor','clinical_assistant')
    and exists (
      select 1 from public.doctors d
      where d.profile_id = profiles.id and d.district_id = public.jwt_district_id()
    )
  );

-- Staff may correct their own contact details and language, nothing else.
-- Role and is_active changes are blocked at the column level below.
create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- INSERT is deliberately absent for `authenticated`: account creation goes
-- through the service role only, and is additionally guarded by the
-- provisioning trigger in 0001.

-- -------------------------------------------------------------
-- Role detail tables
-- -------------------------------------------------------------
create policy doctors_read on public.doctors
  for select to authenticated
  using (
    profile_id = auth.uid()
    or (public.is_admin() and public.admin_covers_district(district_id))
    or (public.jwt_role() in ('doctor','senior_doctor','clinical_assistant')
        and district_id = public.jwt_district_id())
  );

create policy doctors_admin_write on public.doctors
  for all to authenticated
  using (public.is_admin() and public.admin_covers_district(district_id))
  with check (public.is_admin() and public.admin_covers_district(district_id));

-- A doctor toggles only their own availability.
create policy doctors_update_own_availability on public.doctors
  for update to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

create policy clinical_assistants_read on public.clinical_assistants
  for select to authenticated
  using (
    profile_id = auth.uid()
    or exists (
      select 1 from public.facilities f
      where f.id = clinical_assistants.facility_id
        and public.is_admin()
        and public.admin_covers_district(f.district_id)
    )
    or facility_id = public.jwt_facility_id()
  );

create policy clinical_assistants_admin_write on public.clinical_assistants
  for all to authenticated
  using (
    exists (
      select 1 from public.facilities f
      where f.id = clinical_assistants.facility_id
        and public.is_admin()
        and public.admin_covers_district(f.district_id)
    )
  )
  with check (
    exists (
      select 1 from public.facilities f
      where f.id = clinical_assistants.facility_id
        and public.is_admin()
        and public.admin_covers_district(f.district_id)
    )
  );

create policy admin_scopes_read on public.admin_scopes
  for select to authenticated
  using (profile_id = auth.uid() or public.jwt_role() = 'super_admin');

create policy admin_scopes_write on public.admin_scopes
  for all to authenticated
  using (public.jwt_role() = 'super_admin')
  with check (public.jwt_role() = 'super_admin');

-- -------------------------------------------------------------
-- Audit log — read by admins and auditors, insert by anyone acting,
-- update/delete by nobody (triggers in 0002 also block it).
-- -------------------------------------------------------------
create policy audit_log_read on public.audit_log
  for select to authenticated
  using (public.can_read_audit());

create policy audit_log_insert on public.audit_log
  for insert to authenticated
  with check (public.jwt_role() is not null);

-- -------------------------------------------------------------
-- Invitations — admins in scope may read; writes are service-role only.
-- -------------------------------------------------------------
create policy staff_invitations_read on public.staff_invitations
  for select to authenticated
  using (public.is_admin());

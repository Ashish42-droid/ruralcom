-- =============================================================
-- 0001 — Identity, roles and geography
--
-- Establishes the staff identity model and the state -> district ->
-- facility hierarchy that every scoping rule keys off.
--
-- Patients are NOT in this migration; they land in Phase 2.
-- =============================================================

create extension if not exists "pgcrypto";

-- -------------------------------------------------------------
-- Enums
-- -------------------------------------------------------------

-- Roles are an explicit permission set each, NOT an inheritance chain.
-- Inheritance ("senior_doctor is doctor plus extras") reads elegantly and
-- produces subtle privilege bugs.
create type public.user_role as enum (
  'super_admin',
  'state_admin',
  'district_admin',
  'doctor',
  'senior_doctor',
  'clinical_assistant',
  'auditor',
  'patient'          -- reserved; not provisionable yet
);

create type public.admin_scope_level as enum ('national', 'state', 'district');

create type public.facility_type as enum (
  'village_health_centre',
  'phc',                 -- Primary Health Centre
  'chc',                 -- Community Health Centre
  'district_hospital'
);

create type public.doctor_availability as enum ('available', 'busy', 'offline');

-- -------------------------------------------------------------
-- Shared trigger: maintain updated_at
-- -------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- -------------------------------------------------------------
-- Geography
-- -------------------------------------------------------------

create table public.states (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  code        text not null unique,
  -- Marks rows that are demo seed data rather than an authoritative source.
  -- Surfaced in the UI so nothing fabricated is ever shown as real.
  data_source text not null default 'PLACEHOLDER_DEMO',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.districts (
  id          uuid primary key default gen_random_uuid(),
  state_id    uuid not null references public.states(id) on delete restrict,
  name        text not null,
  code        text not null,
  data_source text not null default 'PLACEHOLDER_DEMO',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (state_id, name)
);
create index districts_state_id_idx on public.districts(state_id);

create table public.facilities (
  id          uuid primary key default gen_random_uuid(),
  district_id uuid not null references public.districts(id) on delete restrict,
  name        text not null,
  type        public.facility_type not null,
  address     text,
  contact     text,
  latitude    numeric(9,6),
  longitude   numeric(9,6),
  is_active   boolean not null default true,
  data_source text not null default 'PLACEHOLDER_DEMO',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index facilities_district_id_idx on public.facilities(district_id);

-- -------------------------------------------------------------
-- Profiles — one row per staff account
-- -------------------------------------------------------------

create table public.profiles (
  id                 uuid primary key references auth.users(id) on delete cascade,
  role               public.user_role not null,
  full_name          text not null,
  phone              text,
  preferred_language text not null default 'en',
  is_active          boolean not null default true,

  -- Provisioning provenance. NULL is only legal for the bootstrap
  -- super_admin; enforced by trigger below.
  created_by         uuid references public.profiles(id) on delete set null,

  last_login_at      timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint profiles_full_name_not_blank check (length(trim(full_name)) > 0)
);
create index profiles_role_idx on public.profiles(role);
create index profiles_created_by_idx on public.profiles(created_by);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- -------------------------------------------------------------
-- Role-specific detail tables
-- -------------------------------------------------------------

create table public.admin_scopes (
  profile_id  uuid primary key references public.profiles(id) on delete cascade,
  scope_level public.admin_scope_level not null,
  state_id    uuid references public.states(id) on delete restrict,
  district_id uuid references public.districts(id) on delete restrict,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- A scope must actually name the thing it is scoped to.
  constraint admin_scope_coherent check (
    (scope_level = 'national' and state_id is null and district_id is null)
    or (scope_level = 'state'    and state_id is not null and district_id is null)
    or (scope_level = 'district' and district_id is not null)
  )
);

create table public.doctors (
  profile_id           uuid primary key references public.profiles(id) on delete cascade,
  -- Medical council registration number. MUST be real in production.
  -- Demo rows carry data_source = 'PLACEHOLDER_DEMO'.
  registration_no      text not null unique,
  specialities         text[] not null default '{}',
  district_id          uuid not null references public.districts(id) on delete restrict,
  facility_id          uuid references public.facilities(id) on delete set null,
  availability_status  public.doctor_availability not null default 'offline',
  -- Used by the MEDIUM-tier load balancer when picking a doctor.
  max_concurrent_cases integer not null default 1 check (max_concurrent_cases between 1 and 10),
  data_source          text not null default 'PLACEHOLDER_DEMO',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index doctors_district_id_idx on public.doctors(district_id);
create index doctors_availability_idx on public.doctors(availability_status);
create index doctors_specialities_idx on public.doctors using gin(specialities);

create table public.clinical_assistants (
  profile_id        uuid primary key references public.profiles(id) on delete cascade,
  certification_ref text,
  -- An assistant belongs to exactly one facility. This is the anchor for
  -- every RLS policy on patient data.
  facility_id       uuid not null references public.facilities(id) on delete restrict,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index clinical_assistants_facility_id_idx on public.clinical_assistants(facility_id);

create trigger admin_scopes_set_updated_at before update on public.admin_scopes
  for each row execute function public.set_updated_at();
create trigger doctors_set_updated_at before update on public.doctors
  for each row execute function public.set_updated_at();
create trigger clinical_assistants_set_updated_at before update on public.clinical_assistants
  for each row execute function public.set_updated_at();
create trigger states_set_updated_at before update on public.states
  for each row execute function public.set_updated_at();
create trigger districts_set_updated_at before update on public.districts
  for each row execute function public.set_updated_at();
create trigger facilities_set_updated_at before update on public.facilities
  for each row execute function public.set_updated_at();

-- -------------------------------------------------------------
-- Provisioning guard
--
-- Layer 3 of 4 in the admin-only provisioning defence (see
-- SYSTEM_ARCHITECTURE.md §6). Even a direct database write cannot create
-- an orphan account or one provisioned by a non-admin.
-- -------------------------------------------------------------
create or replace function public.enforce_admin_provisioning()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  creator_role public.user_role;
  existing_count integer;
begin
  if new.created_by is null then
    -- Permitted only to bootstrap the very first account.
    select count(*) into existing_count from public.profiles;
    if existing_count > 0 then
      raise exception
        'profiles.created_by is required: accounts must be provisioned by an admin'
        using errcode = '23514';
    end if;

    if new.role <> 'super_admin' then
      raise exception 'the bootstrap account must be a super_admin'
        using errcode = '23514';
    end if;

    return new;
  end if;

  select role into creator_role from public.profiles where id = new.created_by;

  if creator_role is null then
    raise exception 'profiles.created_by references a non-existent profile'
      using errcode = '23503';
  end if;

  if creator_role not in ('super_admin', 'state_admin', 'district_admin') then
    raise exception 'accounts may only be provisioned by an admin role, not %', creator_role
      using errcode = '42501';
  end if;

  -- Doctors and Clinical Assistants can NEVER self-register.
  if new.id = new.created_by then
    raise exception 'self-provisioning is not permitted'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger profiles_enforce_provisioning
  before insert on public.profiles
  for each row execute function public.enforce_admin_provisioning();

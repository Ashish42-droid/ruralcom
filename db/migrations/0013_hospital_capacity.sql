-- =============================================================
-- 0013 — Hospital capacity
--
-- Bed availability for the HIGH-tier referral flow. Built now because the
-- Kanpur demo seed carries capacity figures and the referral matcher will
-- need somewhere to read them from; the matcher itself is deferred.
--
-- IMPORTANT: in production this is fed by a state HMIS, not typed in.
-- `data_source` distinguishes the two, and `last_updated_at` exists so the
-- UI can show how stale a bed count is. Presenting a three-day-old bed
-- count as current is how a referral sends a patient to a full hospital.
-- =============================================================

create table public.hospital_capacity (
  facility_id       uuid primary key references public.facilities(id) on delete cascade,

  total_beds        integer not null default 0 check (total_beds >= 0),
  available_beds    integer not null default 0 check (available_beds >= 0),
  icu_total         integer not null default 0 check (icu_total >= 0),
  icu_available     integer not null default 0 check (icu_available >= 0),

  has_emergency     boolean not null default false,
  has_ambulance     boolean not null default false,

  -- Whether these numbers came from a real feed or a demo seed.
  data_source       text not null default 'PLACEHOLDER_DEMO',
  -- How old the figures are. A referral UI must show this.
  last_updated_at   timestamptz not null default now(),
  created_at        timestamptz not null default now(),

  constraint available_within_total check (available_beds <= total_beds),
  constraint icu_available_within_total check (icu_available <= icu_total)
);

create index hospital_capacity_available_idx on public.hospital_capacity(available_beds)
  where available_beds > 0;

comment on column public.hospital_capacity.last_updated_at is
  'How current the bed figures are. A referral screen must surface this: '
  'presenting a stale count as live is how a patient is sent to a full '
  'hospital.';

-- =============================================================
-- RLS — capacity is operational, not clinical.
--
-- Unlike patient data, ANY authenticated staff member may read it: an
-- assistant needs to see where a patient can actually be sent, and that
-- is not privileged information about any individual.
-- =============================================================
alter table public.hospital_capacity enable row level security;

create policy hospital_capacity_read on public.hospital_capacity
  for select to authenticated
  using (public.jwt_role() is not null);

-- Written by admins in scope, or by a future HMIS integration via the
-- service role.
create policy hospital_capacity_admin_write on public.hospital_capacity
  for all to authenticated
  using (
    exists (
      select 1 from public.facilities f
      where f.id = hospital_capacity.facility_id
        and public.is_admin()
        and public.admin_covers_district(f.district_id)
    )
  )
  with check (
    exists (
      select 1 from public.facilities f
      where f.id = hospital_capacity.facility_id
        and public.is_admin()
        and public.admin_covers_district(f.district_id)
    )
  );

revoke delete on public.hospital_capacity from authenticated;

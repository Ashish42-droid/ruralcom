-- =============================================================
-- 0014 — HIGH-tier referrals and referral documents
--
-- The HIGH-tier output: refer to the nearest capable hospital, and produce
-- a printable document carrying the destination, its contact, its bed
-- position, and any charges.
--
-- TWO THINGS ARE SNAPSHOTTED AT REFERRAL TIME, deliberately:
--   1. Bed capacity. It changes by the hour. "We sent you to a hospital
--      showing 12 free beds" must remain verifiable afterwards, and a live
--      join would silently rewrite history.
--   2. Facility contact and location. If an admin later corrects a phone
--      number, the slip the patient was handed still says what it said.
-- =============================================================

create table public.referrals (
  id              uuid primary key default gen_random_uuid(),
  visit_id        uuid not null references public.visits(id) on delete restrict,
  patient_id      uuid not null references public.patients(id) on delete restrict,
  assessment_id   uuid references public.ai_assessments(id) on delete set null,

  -- Where they are being sent.
  target_facility_id uuid not null references public.facilities(id) on delete restrict,
  origin_facility_id uuid not null references public.facilities(id) on delete restrict,

  reason          text not null check (length(trim(reason)) > 0),

  -- STRAIGHT-LINE distance. Not road distance. In rural terrain the two
  -- can differ by a factor of three -- a river with no nearby bridge is
  -- the common case -- so the UI must present this as "approximately, as
  -- the crow flies" and never as travel distance.
  distance_km     numeric(6,2) check (distance_km >= 0),

  -- Snapshot: what the destination looked like when the referral was made.
  capacity_snapshot jsonb not null default '{}'::jsonb,
  contact_snapshot  jsonb not null default '{}'::jsonb,

  -- How stale the bed figures already were at referral time. A referral
  -- made against a three-day-old count is a different clinical act from
  -- one made against live data, and the record should say which it was.
  capacity_age_seconds integer,

  status          text not null default 'issued'
                  check (status in ('issued', 'acknowledged', 'cancelled')),

  created_by      uuid references public.profiles(id) on delete restrict,
  created_at      timestamptz not null default now()
);

create index referrals_visit_idx on public.referrals(visit_id);
create index referrals_patient_idx on public.referrals(patient_id, created_at desc);
create index referrals_target_idx on public.referrals(target_facility_id, created_at desc);

comment on column public.referrals.distance_km is
  'Straight-line (haversine) distance, NOT road distance. In rural terrain '
  'these diverge sharply. Must be presented as approximate.';

comment on column public.referrals.capacity_snapshot is
  'Bed figures AS THEY WERE when the referral was issued. Snapshotted so '
  'the record stays verifiable -- a live join would silently rewrite what '
  'the clinician was told at decision time.';

-- -------------------------------------------------------------
-- Referral documents ("bills")
--
-- Named `referral_documents` rather than `bills` because at a government
-- PHC or CHC the printed slip is primarily a referral note; charges are
-- frequently zero or subsidised. The schema supports line items and a
-- total, but defaults to zero and does not assume payment is due.
--
-- >>> CHARGE AMOUNTS ARE PLACEHOLDER AND MUST BE CONFIRMED <<<
-- Real charge schedules are set by state health policy. Nothing here is
-- an authoritative fee.
-- -------------------------------------------------------------
create table public.referral_documents (
  id              uuid primary key default gen_random_uuid(),
  referral_id     uuid not null references public.referrals(id) on delete restrict,
  visit_id        uuid not null references public.visits(id) on delete restrict,

  -- Human-readable, printed on the slip and quoted over the phone.
  document_number text not null unique,

  line_items      jsonb not null default '[]'::jsonb,
  total_amount    numeric(10,2) not null default 0 check (total_amount >= 0),
  currency        text not null default 'INR',

  -- Marks that the assistant has produced the physical slip. The HIGH-tier
  -- "danger zone" UI state clears on this, per the spec.
  printed_at      timestamptz,
  printed_by      uuid references public.profiles(id) on delete set null,

  -- Whether the amounts came from a real, policy-backed schedule.
  charge_source   text not null default 'PLACEHOLDER_DEMO',

  created_by      uuid references public.profiles(id) on delete restrict,
  created_at      timestamptz not null default now()
);

create index referral_documents_referral_idx on public.referral_documents(referral_id);
create index referral_documents_visit_idx on public.referral_documents(visit_id);
-- Drives the "danger zone still active" query.
create index referral_documents_unprinted_idx on public.referral_documents(visit_id)
  where printed_at is null;

comment on column public.referral_documents.charge_source is
  'PLACEHOLDER_DEMO until a real, state-policy-backed charge schedule is '
  'supplied. The UI must not present placeholder amounts as payable.';

-- =============================================================
-- RLS — same reach rule as every other clinical record.
-- =============================================================
alter table public.referrals          enable row level security;
alter table public.referral_documents enable row level security;

create policy referrals_read on public.referrals
  for select to authenticated
  using (exists (
    select 1 from public.visits v
    where v.id = referrals.visit_id
      and public.patient_in_my_facility(v.facility_id)
  ));

-- Issuing a referral is server-owned: it snapshots capacity and computes
-- distance, neither of which a client may forge.

create policy referral_documents_read on public.referral_documents
  for select to authenticated
  using (exists (
    select 1 from public.visits v
    where v.id = referral_documents.visit_id
      and public.patient_in_my_facility(v.facility_id)
  ));

-- The one client-writable action: marking the slip printed, which clears
-- the danger-zone state.
create policy referral_documents_mark_printed on public.referral_documents
  for update to authenticated
  using (exists (
    select 1 from public.visits v
    where v.id = referral_documents.visit_id
      and public.patient_in_my_facility(v.facility_id)
  ))
  with check (exists (
    select 1 from public.visits v
    where v.id = referral_documents.visit_id
      and public.patient_in_my_facility(v.facility_id)
  ));

-- -------------------------------------------------------------
-- Grants — a referral record is evidence and is never rewritten.
-- -------------------------------------------------------------
revoke insert, update, delete on public.referrals from authenticated;
revoke insert, delete on public.referral_documents from authenticated;
revoke update on public.referral_documents from authenticated;
grant  update (printed_at, printed_by) on public.referral_documents to authenticated;

-- -------------------------------------------------------------
-- Audit actions
-- -------------------------------------------------------------
alter type public.audit_action add value if not exists 'referral_document_printed';

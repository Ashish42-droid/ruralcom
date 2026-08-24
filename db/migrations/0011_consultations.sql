-- =============================================================
-- 0011 — Consultations and the doctor review queue
--
-- Covers two flows from the spec that were previously only planned:
--   MEDIUM tier -> a scheduled video consultation, load-balanced across
--                  doctors, with a 5-minute tolerance window.
--   LOW tier    -> a daily doctor review queue, where the doctor either
--                  APPROVES the AI output or FLAGS IT BACK to the
--                  Clinical Assistant with a mandatory note.
--
-- The flag-back loop is the important one: it is what makes a doctor's
-- disagreement reach the person actually treating the patient, rather than
-- being recorded and forgotten.
-- =============================================================

create type public.consultation_status as enum (
  'scheduled',    -- doctor assigned, not yet ringing
  'ringing',      -- both parties notified, inside the tolerance window
  'active',       -- doctor joined
  'completed',
  'missed',       -- tolerance window expired without the doctor joining
  'reassigned',   -- handed to another doctor after a miss
  'cancelled'
);

create type public.review_action as enum (
  'approve',
  'flag_to_assistant',
  'refer'
);

-- -------------------------------------------------------------
-- Consultations
-- -------------------------------------------------------------
create table public.consultations (
  id            uuid primary key default gen_random_uuid(),
  visit_id      uuid not null references public.visits(id) on delete restrict,
  patient_id    uuid not null references public.patients(id) on delete restrict,
  assessment_id uuid references public.ai_assessments(id) on delete set null,

  doctor_id     uuid not null references public.profiles(id) on delete restrict,
  -- The assistant who triggered it, so notifications have a destination.
  assistant_id  uuid references public.profiles(id) on delete set null,

  status        public.consultation_status not null default 'scheduled',

  scheduled_at        timestamptz not null default now(),
  -- scheduled_at + 5 minutes. Stored rather than computed so the window is
  -- fixed at scheduling time and cannot drift if the policy changes later.
  tolerance_expires_at timestamptz not null,
  joined_at     timestamptz,
  ended_at      timestamptz,

  -- Set when a missed call is handed on, so the chain is traceable.
  reassigned_from uuid references public.consultations(id) on delete set null,
  reassign_count  integer not null default 0,

  -- Which room this maps to in the video provider.
  provider        text not null default 'livekit',
  provider_room   text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint tolerance_after_scheduled check (tolerance_expires_at > scheduled_at),
  constraint joined_implies_started check (
    joined_at is null or joined_at >= scheduled_at
  )
);

create index consultations_visit_idx on public.consultations(visit_id);
create index consultations_doctor_idx on public.consultations(doctor_id, status);
create index consultations_patient_idx on public.consultations(patient_id, created_at desc);
-- Drives the tolerance-window sweep and the doctor's queue ordering.
create index consultations_pending_idx on public.consultations(tolerance_expires_at)
  where status in ('scheduled', 'ringing');

create trigger consultations_set_updated_at before update on public.consultations
  for each row execute function public.set_updated_at();

-- ONE ACTIVE CALL PER DOCTOR, enforced by the database rather than by
-- application state. A partial unique index is the cleanest expression of
-- "at most one row per doctor in an in-progress status" -- UI state and
-- application checks both race under load; this cannot.
create unique index consultations_one_active_per_doctor
  on public.consultations(doctor_id)
  where status in ('ringing', 'active');

comment on index public.consultations_one_active_per_doctor is
  'Enforces the spec rule that a doctor handles one call at a time. Written '
  'as a partial unique index so concurrent scheduling attempts collide at '
  'the database rather than racing in application code.';

-- -------------------------------------------------------------
-- Doctor availability: REUSES public.doctors, no new table.
--
-- The first draft of this migration created a `doctor_availability` table
-- and collided with the ENUM of that name from migration 0001. That
-- collision was a useful accident: `public.doctors` ALREADY carries
-- `availability_status`, `specialities` and `max_concurrent_cases` --
-- everything the load balancer needs. A second table would have been a
-- duplicate source of truth for the same fact, and the two would drift.
--
-- Indexes added here support the assignment query; the columns already
-- exist and are already policied.
-- -------------------------------------------------------------
create index doctors_available_idx on public.doctors(availability_status)
  where availability_status = 'available';

-- -------------------------------------------------------------
-- Doctor reviews — the LOW-tier queue and the flag-back loop
-- -------------------------------------------------------------
create table public.doctor_reviews (
  id            uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references public.ai_assessments(id) on delete restrict,
  visit_id      uuid not null references public.visits(id) on delete restrict,
  doctor_id     uuid not null references public.profiles(id) on delete restrict,

  action        public.review_action not null,

  -- REQUIRED when flagging back. A flag with no explanation is useless to
  -- the assistant who has to act on it, so the database refuses it.
  clinical_note text,
  corrected_instruction text,

  -- Set when the assistant acknowledges a flagged case, so a correction
  -- cannot be silently scrolled past.
  assistant_acknowledged_at timestamptz,
  assistant_acknowledged_by uuid references public.profiles(id) on delete set null,

  reviewed_at   timestamptz not null default now(),
  created_at    timestamptz not null default now(),

  constraint flag_requires_note check (
    action <> 'flag_to_assistant'
    or (clinical_note is not null and length(trim(clinical_note)) > 0)
  )
);

create index doctor_reviews_assessment_idx on public.doctor_reviews(assessment_id);
create index doctor_reviews_visit_idx on public.doctor_reviews(visit_id);
create index doctor_reviews_doctor_idx on public.doctor_reviews(doctor_id, reviewed_at desc);
-- The assistant's "doctor feedback" panel: flagged and not yet acknowledged.
create index doctor_reviews_unacknowledged_idx on public.doctor_reviews(visit_id)
  where action = 'flag_to_assistant' and assistant_acknowledged_at is null;

comment on constraint flag_requires_note on public.doctor_reviews is
  'A doctor flagging a case back to the assistant MUST say why. An '
  'unexplained flag cannot be acted on, so it is rejected at the database.';

-- A doctor reviews a given assessment once. A change of mind is a new
-- assessment or a consultation, not a rewritten review.
create unique index doctor_reviews_one_per_assessment
  on public.doctor_reviews(assessment_id);

-- =============================================================
-- RLS
-- =============================================================
alter table public.consultations  enable row level security;
alter table public.doctor_reviews  enable row level security;

-- Consultations: visible to the assigned doctor and to clinical staff who
-- can already reach the visit.
create policy consultations_read on public.consultations
  for select to authenticated
  using (
    doctor_id = auth.uid()
    or exists (
      select 1 from public.visits v
      where v.id = consultations.visit_id
        and public.patient_in_my_facility(v.facility_id)
    )
  );

-- Scheduling, reassignment and status transitions are server-owned: they
-- involve load balancing and the tolerance timer, which a client must not
-- be able to forge. No INSERT policy for `authenticated`.

-- A doctor may mark their OWN consultation joined/completed.
create policy consultations_doctor_update on public.consultations
  for update to authenticated
  using (doctor_id = auth.uid())
  with check (doctor_id = auth.uid());

-- Doctor availability is governed by the existing policies on public.doctors
-- (migration 0003), which already allow a doctor to update their own row.

-- Reviews: readable by the reviewing doctor and by staff on the visit,
-- because the assistant must SEE a flagged case to act on it.
create policy doctor_reviews_read on public.doctor_reviews
  for select to authenticated
  using (
    doctor_id = auth.uid()
    or exists (
      select 1 from public.visits v
      where v.id = doctor_reviews.visit_id
        and public.patient_in_my_facility(v.facility_id)
    )
  );

-- Only a doctor may author a review, and only as themselves.
create policy doctor_reviews_insert on public.doctor_reviews
  for insert to authenticated
  with check (
    doctor_id = auth.uid()
    and public.jwt_role() in ('doctor', 'senior_doctor')
  );

-- The ONLY client-writable part of a review is the assistant's
-- acknowledgement; the clinical content is immutable once written.
create policy doctor_reviews_acknowledge on public.doctor_reviews
  for update to authenticated
  using (exists (
    select 1 from public.visits v
    where v.id = doctor_reviews.visit_id
      and public.patient_in_my_facility(v.facility_id)
  ))
  with check (exists (
    select 1 from public.visits v
    where v.id = doctor_reviews.visit_id
      and public.patient_in_my_facility(v.facility_id)
  ));

-- -------------------------------------------------------------
-- Grants
-- -------------------------------------------------------------
revoke delete on public.consultations, public.doctor_reviews from authenticated;
revoke insert on public.consultations from authenticated;

-- A doctor updates only call lifecycle fields, never the assignment or the
-- tolerance window.
revoke update on public.consultations from authenticated;
grant  update (status, joined_at, ended_at) on public.consultations to authenticated;

-- A review's clinical content is immutable; only the acknowledgement moves.
revoke update on public.doctor_reviews from authenticated;
grant  update (assistant_acknowledged_at, assistant_acknowledged_by)
  on public.doctor_reviews to authenticated;

-- -------------------------------------------------------------
-- Audit actions
-- -------------------------------------------------------------
alter type public.audit_action add value if not exists 'consultation_scheduled';
alter type public.audit_action add value if not exists 'consultation_joined';
alter type public.audit_action add value if not exists 'consultation_missed';
alter type public.audit_action add value if not exists 'consultation_reassigned';
alter type public.audit_action add value if not exists 'review_flagged_to_assistant';
alter type public.audit_action add value if not exists 'review_acknowledged';

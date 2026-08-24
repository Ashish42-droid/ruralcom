-- =============================================================
-- 0010 — Vitals, AI assessments, rule hits and recommendations
--
-- Two things land here:
--   1. `vitals` — a gap from Phase 3. The intake pipeline collected
--      symptoms and documents but never persisted vitals, and the triage
--      rule layer (NEWS2 thresholds) is built entirely on them. Without
--      this table the engine can only ever see "no vitals recorded",
--      which correctly escalates every case to MEDIUM — safe, but useless.
--   2. The assessment record itself, plus the per-rule evidence.
--
-- APPEND-ONLY THROUGHOUT. A clinical system that cannot show what was
-- known at decision time is not defensible, so nothing here is UPDATE-able
-- or DELETE-able by a client. A correction is a new row.
-- =============================================================

-- -------------------------------------------------------------
-- Vitals
-- -------------------------------------------------------------
create table public.vitals (
  id             uuid primary key default gen_random_uuid(),
  visit_id       uuid not null references public.visits(id) on delete restrict,
  patient_id     uuid not null references public.patients(id) on delete restrict,

  -- All nullable and individually bounded: a health worker may record only
  -- what the available equipment can measure, and a partially-filled set is
  -- normal rather than an error. The triage layer treats absent values as
  -- missing data (which escalates), never as normal values.
  temperature_c    numeric(4,1) check (temperature_c between 25 and 45),
  spo2             integer      check (spo2 between 50 and 100),
  systolic         integer      check (systolic between 40 and 300),
  diastolic        integer      check (diastolic between 20 and 200),
  pulse_bpm        integer      check (pulse_bpm between 20 and 300),
  respiratory_rate integer      check (respiratory_rate between 4 and 90),
  weight_kg        numeric(5,2) check (weight_kg between 0.5 and 400),
  height_cm        numeric(5,1) check (height_cm between 20 and 250),

  -- Bounds mirror services/iot/DeviceDriver.js PLAUSIBLE_RANGE exactly.
  -- A manually typed value gets the same plausibility gate as a device
  -- reading: a mistyped SpO2 of 9 is as dangerous as a misparsed one.

  -- An SpO2 from a certified oximeter and one typed by hand deserve
  -- different confidence. The risk layer should be able to tell them apart.
  capture_method public.capture_source not null default 'file_manager',
  device_id      uuid,

  recorded_by    uuid references public.profiles(id) on delete restrict,
  created_at     timestamptz not null default now(),

  -- A row recording nothing is a data-entry mistake, not a measurement.
  constraint vitals_not_empty check (
    temperature_c is not null or spo2 is not null or systolic is not null
    or diastolic is not null or pulse_bpm is not null
    or respiratory_rate is not null or weight_kg is not null
    or height_cm is not null
  ),
  -- Systolic below diastolic is physiologically impossible and almost always
  -- means the two were entered the wrong way round.
  constraint vitals_bp_ordered check (
    systolic is null or diastolic is null or systolic > diastolic
  )
);

create index vitals_visit_idx on public.vitals(visit_id, created_at desc);
create index vitals_patient_idx on public.vitals(patient_id, created_at desc);

-- -------------------------------------------------------------
-- AI assessments
-- -------------------------------------------------------------
create table public.ai_assessments (
  id            uuid primary key default gen_random_uuid(),
  visit_id      uuid not null references public.visits(id) on delete restrict,
  patient_id    uuid not null references public.patients(id) on delete restrict,

  -- The three tiers, stored separately and permanently. Keeping rule_tier
  -- and model_tier alongside final_tier is what makes it possible to answer
  -- "did the model try to de-escalate this?" months later, and to measure
  -- model quality against the deterministic floor over time.
  rule_tier     public.risk_tier not null,
  model_tier    public.risk_tier,           -- null when the model failed
  final_tier    public.risk_tier not null,

  escalation_reason text not null,
  -- The single most important quality signal in the system: the model
  -- proposing a tier BELOW the deterministic floor. Indexed because it is
  -- meant to be monitored in aggregate, not read one row at a time.
  model_attempted_de_escalation boolean not null default false,
  model_error   text,

  differential  jsonb not null default '[]'::jsonb,
  reasoning     text,
  red_flags_observed jsonb not null default '[]'::jsonb,

  -- Reproducibility. Version stamps let a historical decision be replayed
  -- against the exact ruleset and prompt that produced it.
  ruleset_version text not null,
  model_version   text,
  prompt_version  text,
  provider        text,

  latency_ms    integer,

  created_by    uuid references public.profiles(id) on delete restrict,
  created_at    timestamptz not null default now(),

  -- The engine's core invariant, enforced by the database and not only by
  -- application code: final_tier = MAX(rule_tier, model_tier). Encoded as
  -- "final is at least rule, and at least model when a model tier exists",
  -- which is the same statement for a 3-value ordered enum.
  constraint assessment_final_at_least_rule check (final_tier >= rule_tier),
  constraint assessment_final_at_least_model check (
    model_tier is null or final_tier >= model_tier
  )
);

create index ai_assessments_visit_idx on public.ai_assessments(visit_id, created_at desc);
create index ai_assessments_patient_idx on public.ai_assessments(patient_id, created_at desc);
create index ai_assessments_final_tier_idx on public.ai_assessments(final_tier);
create index ai_assessments_de_escalation_idx on public.ai_assessments(created_at desc)
  where model_attempted_de_escalation = true;

comment on constraint assessment_final_at_least_rule on public.ai_assessments is
  'Enforces the monotonic-escalation invariant at the storage layer: a '
  'deterministic rule floor can never be recorded as having been lowered, '
  'even by a service-role write or a direct SQL statement.';

-- -------------------------------------------------------------
-- Rule hits — the evidence behind a tier
-- -------------------------------------------------------------
create table public.triage_rule_hits (
  id            uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references public.ai_assessments(id) on delete cascade,

  code          text not null,          -- e.g. 'spo2_critical'
  tier          public.risk_tier not null,
  source        text,                   -- 'NEWS2' | 'IMCI' | 'PALS' | 'protocol' | 'fail-safe'
  detail        jsonb not null default '{}'::jsonb,  -- observed value, threshold, range

  created_at    timestamptz not null default now()
);

create index triage_rule_hits_assessment_idx on public.triage_rule_hits(assessment_id);
create index triage_rule_hits_code_idx on public.triage_rule_hits(code);

comment on table public.triage_rule_hits is
  'Why a case got its tier. "Why did it say HIGH?" must always have a '
  'precise, per-rule answer with the observed value and the threshold it '
  'crossed -- both for clinical review and for any future audit.';

-- -------------------------------------------------------------
-- Recommendations
-- -------------------------------------------------------------
create type public.recommendation_type as enum (
  'first_aid',
  'medication',
  'precaution',
  'diet'
);

create table public.ai_recommendations (
  id            uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references public.ai_assessments(id) on delete cascade,

  type          public.recommendation_type not null,
  display_order integer not null default 0,
  content       text not null check (length(trim(content)) > 0),

  -- Points at the clinician-signed formulary entry that authorised a
  -- medication. NULL is legal for every other recommendation type and
  -- ILLEGAL for medication -- see the constraint below.
  rule_source_id text,

  created_at    timestamptz not null default now(),

  -- Makes an unsourced drug recommendation structurally impossible to
  -- store. Medicine is never model-authored; it comes from the formulary
  -- rules engine, and a row that cannot name its source is a bug.
  constraint medication_must_cite_source check (
    type <> 'medication' or rule_source_id is not null
  )
);

create index ai_recommendations_assessment_idx
  on public.ai_recommendations(assessment_id, type, display_order);

-- =============================================================
-- RLS — same reach rule as every other clinical table:
-- assistant sees their facility, doctor sees their district,
-- admins see nothing clinical at all.
-- =============================================================
alter table public.vitals             enable row level security;
alter table public.ai_assessments     enable row level security;
alter table public.triage_rule_hits   enable row level security;
alter table public.ai_recommendations enable row level security;

create policy vitals_read on public.vitals
  for select to authenticated
  using (exists (
    select 1 from public.visits v
    where v.id = vitals.visit_id
      and public.patient_in_my_facility(v.facility_id)
  ));

create policy vitals_insert on public.vitals
  for insert to authenticated
  with check (exists (
    select 1 from public.visits v
    where v.id = vitals.visit_id
      and public.patient_in_my_facility(v.facility_id)
  ));

create policy ai_assessments_read on public.ai_assessments
  for select to authenticated
  using (exists (
    select 1 from public.visits v
    where v.id = ai_assessments.visit_id
      and public.patient_in_my_facility(v.facility_id)
  ));

-- No INSERT policy for `authenticated`, deliberately. An assessment is
-- authored ONLY by the server (service role) after running the triage
-- engine. A client that could insert its own assessment could fabricate a
-- LOW tier for a patient the rules would have escalated.

create policy triage_rule_hits_read on public.triage_rule_hits
  for select to authenticated
  using (exists (
    select 1 from public.ai_assessments a
    join public.visits v on v.id = a.visit_id
    where a.id = triage_rule_hits.assessment_id
      and public.patient_in_my_facility(v.facility_id)
  ));

create policy ai_recommendations_read on public.ai_recommendations
  for select to authenticated
  using (exists (
    select 1 from public.ai_assessments a
    join public.visits v on v.id = a.visit_id
    where a.id = ai_recommendations.assessment_id
      and public.patient_in_my_facility(v.facility_id)
  ));

-- -------------------------------------------------------------
-- Grants — clinical evidence and AI output are never rewritten.
-- -------------------------------------------------------------
revoke update, delete on public.vitals             from authenticated;
revoke update, delete on public.ai_assessments     from authenticated;
revoke update, delete on public.triage_rule_hits   from authenticated;
revoke update, delete on public.ai_recommendations from authenticated;

revoke insert on public.ai_assessments     from authenticated;
revoke insert on public.triage_rule_hits   from authenticated;
revoke insert on public.ai_recommendations from authenticated;

-- -------------------------------------------------------------
-- Audit actions for this phase
-- -------------------------------------------------------------
alter type public.audit_action add value if not exists 'vitals_recorded';

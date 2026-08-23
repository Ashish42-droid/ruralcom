-- =============================================================
-- 0009 — Attachments, storage buckets and symptom entries
--
-- NAMING NOTE: the Phase 3 brief says `encounter_id`. This schema calls the
-- encounter a `visit` (migration 0008) and that table is already built,
-- tested and policied, so the foreign key is `visit_id`. Same concept.
--
-- Every table here gets its RLS policy in this same migration.
-- =============================================================

create type public.attachment_type as enum (
  'prescription',
  'wound_image',
  'lab_report',
  'other'
);

create type public.ocr_status as enum ('pending', 'done', 'failed', 'not_applicable');

create type public.capture_source as enum ('camera', 'file_manager', 'device');

create type public.input_mode as enum ('text', 'voice');

-- -------------------------------------------------------------
-- Storage buckets — PRIVATE. Access only via short-lived signed URLs.
--
-- A leaked wound-image URL is a personal-data breach, so `public` is false
-- everywhere and there is no code path that creates a public bucket.
-- -------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('prescriptions', 'prescriptions', false, 10485760,
   array['image/jpeg','image/png','image/webp','image/heic','application/pdf']),
  ('wound-images',  'wound-images',  false, 10485760,
   array['image/jpeg','image/png','image/webp','image/heic']),
  ('lab-reports',   'lab-reports',   false, 10485760,
   array['image/jpeg','image/png','image/webp','image/heic','application/pdf'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- -------------------------------------------------------------
-- Attachments
-- -------------------------------------------------------------
create table public.attachments (
  id            uuid primary key default gen_random_uuid(),
  visit_id      uuid not null references public.visits(id) on delete restrict,
  patient_id    uuid not null references public.patients(id) on delete restrict,

  type          public.attachment_type not null,
  bucket        text not null,
  -- Opaque path: <facility_id>/<visit_id>/<uuid>.<ext>. Deliberately carries
  -- no patient name or original filename, so the path itself is never PHI
  -- and is safe to log.
  storage_path  text not null unique,

  mime          text not null,
  size_bytes    integer not null check (size_bytes > 0),
  -- Shown back to the user, never logged: an original filename can easily
  -- contain a patient name.
  original_name text,
  capture_source public.capture_source not null default 'file_manager',

  ocr_status    public.ocr_status not null default 'pending',
  ocr_text      text,
  ocr_engine    text,
  ocr_confidence numeric(4,3) check (ocr_confidence between 0 and 1),
  -- Low-confidence extraction must be confirmed by a human before it is
  -- allowed to populate any clinical field.
  needs_human_review boolean not null default true,

  -- Groups a multi-file upload so N files are processed and confirmed as one set.
  upload_batch_id uuid,

  uploaded_by   uuid references public.profiles(id) on delete restrict,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index attachments_visit_idx on public.attachments(visit_id);
create index attachments_patient_idx on public.attachments(patient_id);
create index attachments_batch_idx on public.attachments(upload_batch_id)
  where upload_batch_id is not null;
create index attachments_ocr_pending_idx on public.attachments(ocr_status)
  where ocr_status = 'pending';

create trigger attachments_set_updated_at before update on public.attachments
  for each row execute function public.set_updated_at();

-- -------------------------------------------------------------
-- Symptom entries
-- -------------------------------------------------------------
create table public.symptom_entries (
  id              uuid primary key default gen_random_uuid(),
  visit_id        uuid not null references public.visits(id) on delete restrict,
  patient_id      uuid not null references public.patients(id) on delete restrict,

  -- The original, in the language it was given. Kept alongside any
  -- translation: when a translation goes wrong the original is the only
  -- evidence, and for clinical review it is the primary record.
  raw_text        text not null check (length(trim(raw_text)) > 0),
  language        text not null default 'hi',
  input_mode      public.input_mode not null default 'text',

  -- Populated by the translation/normalisation layer in a later phase.
  normalized_text text,
  normalized_codes text[] not null default '{}',

  duration_days   integer check (duration_days >= 0),
  onset_date      date,
  severity_reported integer check (severity_reported between 0 and 10),

  -- Voice provenance, for the STT layer. Null for typed entries.
  audio_attachment_id uuid references public.attachments(id) on delete set null,
  stt_provider    text,
  stt_confidence  numeric(4,3) check (stt_confidence between 0 and 1),

  recorded_by     uuid references public.profiles(id) on delete restrict,
  created_at      timestamptz not null default now()
);

create index symptom_entries_visit_idx on public.symptom_entries(visit_id);
create index symptom_entries_patient_idx on public.symptom_entries(patient_id, created_at desc);

comment on column public.symptom_entries.onset_date is
  'Onset may be in the past but never in the future; enforced in the API '
  'layer where "today" is unambiguous.';

-- =============================================================
-- RLS — same reach rule as patients: assistant sees their facility,
-- doctor sees their district, admins see nothing clinical.
-- =============================================================
alter table public.attachments     enable row level security;
alter table public.symptom_entries enable row level security;

create policy attachments_read on public.attachments
  for select to authenticated
  using (exists (
    select 1 from public.visits v
    where v.id = attachments.visit_id
      and public.patient_in_my_facility(v.facility_id)
  ));

create policy attachments_insert on public.attachments
  for insert to authenticated
  with check (exists (
    select 1 from public.visits v
    where v.id = attachments.visit_id
      and public.patient_in_my_facility(v.facility_id)
  ));

create policy attachments_update on public.attachments
  for update to authenticated
  using (exists (
    select 1 from public.visits v
    where v.id = attachments.visit_id
      and public.patient_in_my_facility(v.facility_id)
  ))
  with check (exists (
    select 1 from public.visits v
    where v.id = attachments.visit_id
      and public.patient_in_my_facility(v.facility_id)
  ));

create policy symptom_entries_read on public.symptom_entries
  for select to authenticated
  using (exists (
    select 1 from public.visits v
    where v.id = symptom_entries.visit_id
      and public.patient_in_my_facility(v.facility_id)
  ));

create policy symptom_entries_insert on public.symptom_entries
  for insert to authenticated
  with check (exists (
    select 1 from public.visits v
    where v.id = symptom_entries.visit_id
      and public.patient_in_my_facility(v.facility_id)
  ));

-- -------------------------------------------------------------
-- Storage object policies
--
-- Mirror the table policies: reach the object only if you can reach the
-- attachment row that points at it.
-- -------------------------------------------------------------
create policy storage_clinical_read on storage.objects
  for select to authenticated
  using (
    bucket_id in ('prescriptions', 'wound-images', 'lab-reports')
    and exists (
      select 1
      from public.attachments a
      join public.visits v on v.id = a.visit_id
      where a.storage_path = storage.objects.name
        and a.bucket = storage.objects.bucket_id
        and public.patient_in_my_facility(v.facility_id)
    )
  );

create policy storage_clinical_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id in ('prescriptions', 'wound-images', 'lab-reports')
    and public.jwt_role() = 'clinical_assistant'
  );

-- No update or delete policy: uploaded clinical evidence is immutable.

-- -------------------------------------------------------------
-- Grants — clinical evidence is never deleted or rewritten by a client.
-- OCR fields are written by the pipeline via the service role only.
-- -------------------------------------------------------------
revoke delete on public.attachments, public.symptom_entries from authenticated;
revoke update on public.symptom_entries from authenticated;

revoke update on public.attachments from authenticated;
grant  update (original_name) on public.attachments to authenticated;

-- -------------------------------------------------------------
-- Audit actions for this phase
-- -------------------------------------------------------------
alter type public.audit_action add value if not exists 'attachment_uploaded';
alter type public.audit_action add value if not exists 'attachment_downloaded';
alter type public.audit_action add value if not exists 'symptom_recorded';

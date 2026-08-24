-- =============================================================
-- 0012 — Notifications
--
-- The DURABLE BACKSTOP behind the realtime layer.
--
-- A socket event reaches only a client that is connected at that instant.
-- A doctor whose phone dropped to 2G for thirty seconds, or an assistant
-- whose tablet slept, would otherwise simply never learn that a
-- consultation was scheduled or that a case was flagged back to them.
-- Every realtime event therefore also lands here, and clients reconcile
-- from this table on reconnect.
--
-- NO PHI IN PAYLOADS. A notification carries ids and a type, never a
-- patient name, symptom text, or clinical finding. The client fetches the
-- actual record through the normal RLS-protected endpoints once it knows
-- something happened. This keeps clinical data out of the websocket
-- stream and out of any client-side notification cache.
-- =============================================================

create type public.notification_type as enum (
  'consultation_scheduled',
  'consultation_ringing',
  'consultation_missed',
  'consultation_reassigned',
  'consultation_joined',
  'consultation_completed',
  'assessment_ready',
  'review_flagged_to_assistant',
  'review_approved',
  'high_risk_referral'
);

create table public.notifications (
  id            uuid primary key default gen_random_uuid(),
  recipient_id  uuid not null references public.profiles(id) on delete cascade,

  type          public.notification_type not null,
  -- Ids only. See the PHI note above.
  payload       jsonb not null default '{}'::jsonb,

  -- Denormalised so a client can jump straight to the right screen
  -- without a second lookup.
  visit_id        uuid references public.visits(id) on delete cascade,
  consultation_id uuid references public.consultations(id) on delete cascade,

  read_at       timestamptz,
  -- Which channels actually carried it, e.g. ['socket'] or ['socket','push'].
  -- Empty means it was persisted but nobody was connected to receive it.
  delivered_via text[] not null default '{}',

  created_at    timestamptz not null default now()
);

-- The main query: a recipient's unread notifications, newest first.
create index notifications_recipient_unread_idx
  on public.notifications(recipient_id, created_at desc)
  where read_at is null;

create index notifications_recipient_idx on public.notifications(recipient_id, created_at desc);
create index notifications_visit_idx on public.notifications(visit_id)
  where visit_id is not null;

comment on column public.notifications.payload is
  'Identifiers and enum values ONLY. Never a patient name, symptom text or '
  'clinical finding -- notifications travel over websockets and may be '
  'cached client-side. The client fetches the record itself through the '
  'normal RLS-protected endpoints.';

-- =============================================================
-- RLS — a notification is visible ONLY to its recipient.
-- =============================================================
alter table public.notifications enable row level security;

create policy notifications_read_own on public.notifications
  for select to authenticated
  using (recipient_id = auth.uid());

-- The only thing a recipient may change is marking their own as read.
create policy notifications_mark_read on public.notifications
  for update to authenticated
  using (recipient_id = auth.uid())
  with check (recipient_id = auth.uid());

-- No INSERT policy: notifications are emitted by the server as a
-- consequence of a real event. A client able to author one could forge a
-- "consultation scheduled" that no scheduler ever created.

-- -------------------------------------------------------------
-- Grants
-- -------------------------------------------------------------
revoke insert, delete on public.notifications from authenticated;
revoke update on public.notifications from authenticated;
grant  update (read_at) on public.notifications to authenticated;

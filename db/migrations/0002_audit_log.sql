-- =============================================================
-- 0002 — Audit log
--
-- Append-only, enforced by trigger. No update, no delete, for anyone,
-- including the service role. A healthcare system that cannot show what
-- was known and who did what at decision time is not defensible.
-- =============================================================

create type public.audit_action as enum (
  'login',
  'login_failed',
  'logout',
  'account_provisioned',
  'account_deactivated',
  'account_reactivated',
  'invitation_sent',
  'invitation_accepted',
  'role_changed',
  'patient_created',
  'patient_updated',
  'clinical_data_written',
  'assessment_run',
  'doctor_review',
  'prescription_issued',
  'referral_issued',
  'break_glass_access',
  'permission_denied',
  'service_role_write'
);

create table public.audit_log (
  id            bigint generated always as identity primary key,
  actor_id      uuid references public.profiles(id) on delete set null,
  actor_role    public.user_role,
  action        public.audit_action not null,
  entity_type   text,
  entity_id     text,
  -- Before/after snapshots. Must never contain secrets; the application
  -- redacts before writing.
  before_state  jsonb,
  after_state   jsonb,
  metadata      jsonb not null default '{}'::jsonb,
  ip_address    inet,
  user_agent    text,
  request_id    text,
  -- Raised for break-glass access and denied-permission events so alerting
  -- can filter cheaply.
  severity      text not null default 'info'
                check (severity in ('info', 'warning', 'critical')),
  created_at    timestamptz not null default now()
);

create index audit_log_actor_id_idx    on public.audit_log(actor_id);
create index audit_log_action_idx      on public.audit_log(action);
create index audit_log_created_at_idx  on public.audit_log(created_at desc);
create index audit_log_entity_idx      on public.audit_log(entity_type, entity_id);
create index audit_log_severity_idx    on public.audit_log(severity)
  where severity in ('warning', 'critical');

-- -------------------------------------------------------------
-- Append-only enforcement
-- -------------------------------------------------------------
create or replace function public.reject_audit_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_log is append-only: % is not permitted', tg_op
    using errcode = '42501';
end;
$$;

create trigger audit_log_no_update
  before update on public.audit_log
  for each row execute function public.reject_audit_mutation();

create trigger audit_log_no_delete
  before delete on public.audit_log
  for each row execute function public.reject_audit_mutation();

-- -------------------------------------------------------------
-- Staff invitations
--
-- Admins create the account; the staff member sets their own password via a
-- single-use, time-limited invite. The admin therefore never learns the
-- credential, so "who could have logged in as that doctor?" has exactly one
-- answer.
-- -------------------------------------------------------------
create table public.staff_invitations (
  id           uuid primary key default gen_random_uuid(),
  email        text not null,
  role         public.user_role not null,
  profile_id   uuid references public.profiles(id) on delete cascade,
  invited_by   uuid not null references public.profiles(id) on delete restrict,
  -- Only the hash is stored. A database read must not yield a usable invite.
  token_hash   text not null unique,
  expires_at   timestamptz not null,
  accepted_at  timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now(),

  constraint invitation_role_provisionable check (
    role in ('state_admin','district_admin','doctor','senior_doctor',
             'clinical_assistant','auditor')
  )
);

create index staff_invitations_email_idx on public.staff_invitations(lower(email));
create index staff_invitations_pending_idx on public.staff_invitations(expires_at)
  where accepted_at is null and revoked_at is null;

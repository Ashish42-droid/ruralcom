# Setup

## Prerequisites

- Node.js ≥ 20 (developed on 26)
- A Supabase project
- Docker — **not yet installed on the dev machine**; needed only for the
  containerised run, not for local development

## 1. Environment

```bash
cp .env.example .env
```

Fill in at minimum: `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`.

**Connection string gotcha:** if the database password contains `@`, `#`, `/`
or `:` it must be percent-encoded, or the URI parser reads it as a delimiter
and fails with a misleading "host not found". `p@ss` becomes `p%40ss`.

**IPv6:** `db.<ref>.supabase.co` has no A record — it is IPv6-only. That works
from most local machines but **not** from Railway, Render or Vercel functions,
which have no IPv6 egress. For deployment, copy the **Session pooler** URI from
Settings → Database and set `DATABASE_POOLER_URL`; `config/db.js` prefers it
when present.

## 2. Install and verify

```bash
npm install
npm run db:check
```

Expected:

```
OK    Postgres         PostgreSQL 17.6
OK    Supabase Auth    GoTrue v2.195.0
```

## 3. Migrations

```bash
npm run db:migrate
```

Migrations are **immutable**. Once applied, a file's checksum is recorded; if
you edit it, the runner refuses to continue and tells you to add a new
migration instead. That is deliberate — replaying an edited migration against
a database that already ran the old one produces schema drift you will not
notice until something breaks.

Use `--dry` to preview, `--force` only when you are certain a replay is safe.

## 4. Required dashboard steps

Three things must be done by hand in the Supabase dashboard. The API cannot do
them, and **two of them will silently break authorisation if skipped.**

### 4.1 Enable the custom access token hook — REQUIRED

**Authentication → Hooks → Customize Access Token (JWT) Claims**
→ select `public.custom_access_token_hook`.

Without this, JWTs carry no `app_role` claim, so every RLS policy that checks
a role evaluates to null and **denies**. Symptom: a valid login that can read
nothing. It looks like a broken database; it is a missing checkbox.

### 4.2 Disable public signup — REQUIRED

**Authentication → Providers → Email → disable "Enable sign-ups"**

Doctors and Clinical Assistants must never self-register. Three other layers
enforce this (the provisioning trigger, the missing INSERT policy, and the
admin-only route), but the signup endpoint should not exist at all.

### 4.3 Enable MFA for admin accounts — before the demo

**Authentication → Providers → enable TOTP.**
A `super_admin` account without MFA is the entire system's single point of
failure.

## 5. Bootstrap the first admin

```bash
node --env-file=.env scripts/bootstrap-admin.js --email you@example.com --name "Your Name"
```

Works **only on an empty system** — the provisioning trigger allows a null
`created_by` exactly once. It prints a single-use invitation token; set your
password with:

```bash
curl -X POST http://localhost:4000/api/v1/auth/accept-invitation \
  -H 'content-type: application/json' \
  -d '{"token":"<token>","password":"<your password>"}'
```

The password is never passed on the command line, so it stays out of shell
history.

## 6. Run

```bash
npm run dev     # http://localhost:4000
npm test        # unit + RLS policy tests
npm run lint
```

End-to-end smoke test, against a running server:

```bash
node --env-file=.env scripts/e2e-auth-smoke.js
```

It creates throwaway accounts under `*@ruralai-test.invalid`, exercises the
whole auth flow, then deactivates them. Safe to re-run.

## Accounts are deactivated, never deleted

A profile with audit history **cannot** be deleted — the foreign key is
`RESTRICT` and a trigger explains why. This is intentional: `ON DELETE SET
NULL` would erase attribution, and an audit log that forgets who acted is not
an audit log. Disposal is `is_active = false`.

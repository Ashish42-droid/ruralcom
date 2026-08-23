# RuralAI — System Architecture

Living document. Updated as each build phase lands.
Full design rationale: [`docs/PHASE1_ARCHITECTURE_PLAN.md`](docs/PHASE1_ARCHITECTURE_PLAN.md).
Deviations from the original brief: [`docs/DECISIONS.md`](docs/DECISIONS.md).

**Build status:** Phases 0–3 complete except voice input (scaffold, auth, RBAC, RLS, patient records, attachments + storage, symptom entry). STT adapters are stubs awaiting credentials.

**KNOWN RED TEST:** `tests/live-auth-path.test.js` fails until the Supabase access token hook is enabled (docs/SETUP.md §4.1). It is a configuration canary, not a code defect.

Setup steps, including two dashboard toggles that silently break authorisation if skipped: [`docs/SETUP.md`](docs/SETUP.md).

---

## 1. What this is

An AI-assisted virtual clinic for rural health centres. A trained Clinical
Assistant captures a patient's symptoms, vitals, documents and images; an AI
layer produces a structured assessment and a LOW / MEDIUM / HIGH triage tier;
a remote Doctor reviews, consults over video, and holds final medical
authority.

**The rule the whole system is built around:** nothing probabilistic makes a
safety-critical decision alone. Models generate hypotheses, deterministic
rules set floors and gates, humans decide.

---

## 2. Runtime shape

```
┌──────────────────┐        ┌──────────────────┐        ┌──────────────────┐
│  Assistant PWA   │        │  Doctor Portal   │        │  Admin Console   │
│   (web/, Next)   │        │   (web/, Next)   │        │   (web/, Next)   │
└────────┬─────────┘        └────────┬─────────┘        └────────┬─────────┘
         │                           │                           │
         │  reads + realtime (anon key + user JWT — RLS applies)  │
         ├───────────────────────────┴───────────────────────────┤
         │                                                       │
         ▼                                                       ▼
┌─────────────────────────────┐                 ┌────────────────────────────┐
│         Supabase            │                 │   RuralAI Core API         │
│  Postgres · Auth · Storage  │◀────────────────│   (Express, this repo)      │
│  Realtime · RLS             │  service role   │  triage · AI · OCR · IoT   │
└─────────────────────────────┘  (writes only)  │  jobs · sockets            │
                                                └────────────────────────────┘
                                                             │
                                                    ┌────────┴────────┐
                                                    │ Redis (BullMQ,  │
                                                    │ Socket.IO adapter)│
                                                    └─────────────────┘
```

**Why the split:** Supabase gives native row-level security, realtime and
storage without hand-building them. The Core API holds everything that needs
server-only secrets or trusted computation — the triage engine, LLM calls,
OCR, IoT ingest, scheduling and background jobs.

---

## 3. Security rules (non-negotiable)

These are enforced in code review. Violating one is a defect, not a style
disagreement.

1. **Service-role key bypasses ALL row-level security.**
   Clients read through `supabaseAsUser(jwt)` so Postgres enforces access.
   `supabaseAdmin` is for trusted server-side writes only — and every such
   call site needs an explicit authorisation check *and* an audit-log row.
   Reaching for `supabaseAdmin` to "make the query work" is the bug; fix the
   policy instead. See [`config/supabase.js`](config/supabase.js).

2. **No government ID data enters the system.** Patients are keyed by a
   system-issued 12-digit RuralAI Health ID (RHID). No Aadhaar number is
   stored — not raw, not hashed, not partially. See §5.

3. **Triage escalates monotonically.** `final_tier = max(rule_tier, model_tier)`.
   Deterministic red-flag rules can only ever *raise* a tier. Nothing lowers
   one. Degraded AI fails safe to MEDIUM, never LOW.

4. **Medicine is never model-authored.** LOW-tier suggestions come from a
   clinician-signed formulary via a rules engine. A medication record with no
   `rule_source_id` must not be persistable.

5. **AI output and doctor decision are separate records**, never one row with
   a status flag.

6. **Secrets never reach the browser, a log line, or a commit.**
   `.env` is gitignored; the logger redacts tokens, keys and patient
   identifiers; `.dockerignore` keeps secrets out of image layers.

---

## 4. Repository layout

```
RuralAI/
├── config/          env loading + validation, Postgres pool, Supabase clients, logger
├── controllers/     route handlers, one domain per file
├── middlewares/     request id, auth/RBAC guards, validation, rate limits, errors
├── models/          data models and Zod schemas
├── db-data/         local Postgres container volume        [renamed from mongo-data/]
├── public/temp/     transient upload staging pre-processing
├── routes/          route definitions, mirrors controllers
├── services/        business logic: triage engine, AI orchestration, OCR, notifications
├── sockets/         realtime: queue updates, doctor notifications, call signalling
├── jobs/            background work: review queue, risk re-evaluation, call reminders
├── locales/         multilingual strings for the voice + translation layer
├── scripts/         operational scripts (db:check, migrations)          [NEW]
├── tests/           unit + integration, mirrors controllers/services
├── utils/           shared helpers
├── docs/            architecture plan, decision records, API docs
├── web/             Next.js frontend                        [NEW, from Phase 8]
├── Dockerfile                                                            [NEW]
├── app.js           Express app (exported, no listener)
├── server.js        HTTP server, boot checks, graceful shutdown
└── docker-compose.yml
```

Additions beyond the specified structure are marked and justified in
[`docs/DECISIONS.md`](docs/DECISIONS.md).

---

## 5. Patient identity

- **`rhid`** — system-issued **12-digit** RuralAI Health ID. Human-facing key.
  Random (not sequential), with a check digit so mistyped IDs are rejected at
  entry rather than silently creating a duplicate patient.
- **Internal PK** — UUID. All foreign keys use this.
- **`abha_id`** — optional, only if a patient already has one. Reserved for
  future ABDM interoperability. Never required.
- **Lookup is rate-limited and audited**, so probing the ID space is
  impractical and detectable.

---

## 6. Roles

`super_admin` · `state_admin` · `district_admin` · `doctor` · `senior_doctor` ·
`clinical_assistant` · `auditor` · (`patient`, reserved)

Roles are explicit permission sets, **not** inheritance chains. No admin role
can write patient clinical data — enforced by RLS policy *and* a database
trigger, not by hiding a button. Doctors and Clinical Assistants can never
self-register; only an admin provisions accounts, and via invitation so the
admin never learns the credential.

Full permission matrix: `docs/PHASE1_ARCHITECTURE_PLAN.md` §C.2.

---

## 7. Triage tiers

| Tier | Output |
|---|---|
| **LOW** | First aid · patient details · medication from signed formulary, **queued for doctor review** · point-wise precautions · optional diet |
| **MEDIUM** | First aid · patient details · **load-balanced video consultation** (doctor chosen by disease category) · **doctor-issued PDF prescription** delivered to the assistant · precautions · optional diet |
| **HIGH** | First aid · patient details · **danger-zone UI** · bill generation with nearest-hospital referral, bed availability, location and contact · precautions. **No medicine.** |

Doctor review of a LOW case has two outcomes: **approve** the AI response as
correct, or **flag it back to the Clinical Assistant** with a mandatory
clinical note. A flagged case moves to `awaiting_assistant_action` and
requires explicit acknowledgement.

---

## 8. API surface

Base path `/api/v1`. Uniform envelopes:

```jsonc
// success
{ "success": true, "data": { }, "meta": { "requestId": "…" } }
// failure
{ "success": false, "error": { "code": "…", "message": "…", "requestId": "…" } }
```

**Live now:**

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/v1/health/live` | — | Liveness. Touches no dependency. |
| GET | `/api/v1/health/ready` | — | Readiness. Checks Postgres + Supabase Auth. |
| GET | `/api/v1/health` | — | Summary incl. responding instance id. |
| POST | `/api/v1/auth/login` | — | Sign in. Rate-limited, audited. |
| POST | `/api/v1/auth/refresh` | — | Rotate the session. |
| POST | `/api/v1/auth/accept-invitation` | — | Staff set their own password. |
| POST | `/api/v1/auth/logout` | staff | Revoke the session. |
| GET | `/api/v1/auth/me` | staff | Own profile, read through RLS. |
| PATCH | `/api/v1/auth/me` | staff | Own contact details only. |
| POST | `/api/v1/admin/staff` | admin | Provision an account + invitation. |
| GET | `/api/v1/admin/staff` | admin | Staff list, RLS-scoped to region. |
| PATCH | `/api/v1/admin/staff/:id/status` | admin | Deactivate / reactivate. |
| GET | `/api/v1/admin/regions` | admin | State → district tree. |
| POST | `/api/v1/patients` | assistant | Register a patient, issues the RHID. |
| POST | `/api/v1/patients/emergency` | assistant | Urgent bypass: minimal data, opens a visit. |
| GET | `/api/v1/patients/search` | clinical | By RHID, name or phone. Rate-limited, audited. |
| GET | `/api/v1/patients/recent` | clinical | Assistant landing view. |
| GET | `/api/v1/patients/:id` | clinical | Full record + history + allergies + visits. |
| PATCH | `/api/v1/patients/:id` | clinical | Update; completes an emergency record. |
| POST | `/api/v1/patients/:id/history` | clinical | Add a history entry. |
| POST | `/api/v1/patients/:id/allergies` | clinical | Add an allergy. |
| POST | `/api/v1/patients/:id/visits` | assistant | Open a visit. |
| POST | `/api/v1/intake/visits/:id/attachments` | assistant | Upload 1–10 files (camera or file manager). |
| GET | `/api/v1/intake/visits/:id/attachments` | clinical | List a visit's files. |
| GET | `/api/v1/intake/attachments/:id/url` | clinical | 300s signed URL. Only way to read a file. |
| POST | `/api/v1/intake/visits/:id/symptoms` | assistant | Record a symptom (text; voice returns 503). |
| GET | `/api/v1/intake/visits/:id/symptoms` | clinical | List symptom entries. |

Admins are absent from every clinical route **and** every clinical RLS policy.
Region-level management does not require seeing a named patient's record.

There is deliberately **no** `POST /auth/register`.

`/live` and `/ready` are deliberately separate: a liveness probe that checks
the database would restart every instance during a brief DB blip, turning a
small problem into an outage.

---

## 9. Local development

```bash
npm install
npm run db:check     # verify Postgres + Supabase connectivity
npm run dev          # http://localhost:4000
npm test
```

Requires `.env` (copy from `.env.example`). Docker is **not yet verified** —
see `docs/DECISIONS.md`.

---

## 10. Data model

**Identity:** `states` → `districts` → `facilities` · `profiles` ·
`doctors` / `clinical_assistants` / `admin_scopes` · `staff_invitations` ·
`audit_log` (append-only).

**Clinical:** `patients` → `patient_history`, `allergies`, `visits`.

**Visit-centric by design.** Everything clinical hangs off a `visit`, never
directly off a patient. A patient who returns three times has three visits,
each with its own vitals, symptoms and assessment. This is what makes the
longitudinal risk detector possible at all.

Clinical records are **never deleted** — no DELETE grant, no DELETE policy.
`visits.final_tier` is not client-writable: a client that could set its own
tier could downgrade a HIGH-risk case.

---

## 11. Current gaps

- Rate limiting uses an in-memory store, so limits are per-instance. Redis
  store lands with the Socket.IO adapter in Phase 5.
- MFA is not yet enforced in code; it is a dashboard toggle today.
- Invitation delivery is manual — no email/SMS provider is configured, so the
  token is returned once in the API response.
- `docker-compose.yml` and `Dockerfile` are written but unexecuted — Docker is
  not installed on the current dev machine.
- Deployment will need the Supavisor pooler URL: the direct Postgres host is
  IPv6-only and most PaaS providers have no IPv6 egress.

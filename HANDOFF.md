# RuralAI — Session Handoff

**Read this first in a new context window.** It is the shortest path from
"fresh session" to "productive". Everything below is current as of the last
commit on `main`.

---

## 1. Run it

```bash
npm install && npm --prefix web install
npm run demo
```

`npm run demo` builds the React frontend and starts the API, which serves
both. Open **http://localhost:4000** (redirects to `/app/`).

Sign in with a seeded account — the login screen has buttons that prefill
the email:

| Role | Email | Password |
|---|---|---|
| Clinical Assistant | `demo.assistant.1@ruralai-demo.invalid` | value of `SEED_DEMO_PASSWORD` in `.env` |
| Doctor | `demo.doctor.up-knp.2@ruralai-demo.invalid` | same |

Assistants are `demo.assistant.1`–`6`. Doctors are
`demo.doctor.<up-knp\|up-knd\|up-unn>.<1-10>`; about a third are seeded
`offline` so the load balancer has something to balance.

---

## 2. ⚠ THE ONE THING BLOCKING EVERYTHING

**The Postgres password was rotated externally and `.env` still has the old
one.** Nothing patient-facing works until this is fixed.

```
database     → password authentication failed for user "postgres"   ← 28P01
supabaseAuth → OK
redis        → OK
```

Fix: Supabase dashboard → Settings → Database → get the password, then
update BOTH in `.env`:

- `DATABASE_URL` (direct host)
- `DATABASE_POOLER_URL` (Supavisor pooler — **this is the one that matters**;
  the direct host is IPv6-only and fails on most networks, see D-010/D-034)

Verify with `npm run db:check`. Until then: 399 tests pass, 162 DB-backed
tests fail, the UI loads but every clinical call returns an error.

---

## 3. Verification commands

| Command | What it proves |
|---|---|
| `npm test` | Full suite. 561 tests; 162 currently fail on the DB password alone. |
| `npm run lint` | Must be clean. It is. |
| `npm run db:check` | Postgres + Supabase reachability, with an actionable hint on failure. |
| `npm run llm:check` | Real Groq call for the assessment layer. |
| `npm run vision:check` | Real Gemini call for wound analysis. **Proves wiring only** — see §6. |
| `npm run livekit:check` | Real LiveKit auth + room lifecycle. |
| `npm run assessment:check` | Full Phase 3→4 path against the live stack (needs DB). |
| `npm run seed:demo` | Re-seed Kanpur demo data. `-- --purge` removes it. |
| `npm run db:migrate` | Apply pending SQL migrations. |

**The `*:check` scripts are the only places allowed to hit real APIs.** The
Jest suite injects fakes so CI is free, deterministic, and never spends
quota. Twice now these scripts caught bugs no unit test could — see D-036
and D-045.

---

## 4. Architecture in one screen

Node/Express API + Supabase Postgres (RLS is the real access control) +
React/Vite frontend served by the same Express process.

```
web/          React + Framer Motion + React Three Fiber → built to public/app/
routes/       → controllers/ → services/          (one domain per file)
services/     triage, careplan, llm, ocr, vision, stt, video, consultation…
db/migrations numbered SQL. NEVER edit an applied one — add a new file.
sockets/      Socket.IO + Redis adapter (multi-instance fan-out)
jobs/         BullMQ — consultation tolerance window
docs/         DECISIONS.md is the real history. PHASE1_ARCHITECTURE_PLAN.md is the plan.
```

**`docs/DECISIONS.md` (D-001 … D-066) is the most valuable file in the
repo.** Every non-obvious choice, every reversal, and every bug worth
remembering is recorded there with its reasoning. Read it before changing
anything that looks arbitrary — it probably isn't.

---

## 5. The invariants. Do not break these.

1. **`final_tier = MAX(rule_tier, model_tier)`** — enforced by database
   CHECK constraints, not just code. Deterministic rules set a floor; a
   model may raise a tier and can never lower one. A compromised
   service-role key cannot record a de-escalation.
2. **Degraded AI fails safe to MEDIUM, never LOW.** Timeout, malformed
   output, no model configured — all floor at MEDIUM.
3. **Missing data escalates.** Absent vitals, unknown age and incomplete
   registration all raise the tier. Absence of evidence is not evidence of
   absence.
4. **Medicine is never model-authored.** It comes from a clinician-signed
   formulary via a rules engine. A medication row with no `rule_source_id`
   is rejected by a DB constraint. LOW tier only.
5. **Admins have no clinical access** — not read, not write. Enforced by
   RLS policy *and* trigger, not by hiding a button.
6. **No PHI in logs, audit metadata, or notification payloads** — including
   filenames. Storage paths are opaque by construction.
7. **Clinical records and audit entries are never deleted.** Accounts are
   deactivated, not removed, so attribution survives.

---

## 6. Known gaps — be honest about these

| Gap | Detail |
|---|---|
| **Clinician sign-off** | Triage thresholds (NEWS2/IMCI/PALS) and the OTC formulary (WHO/NLEM) are from published sources but **not validated for this deployment**. Stamped `unvalidated`; README carries a "not for clinical use" notice. **Longest lead time of anything, and nothing technical substitutes for it.** |
| **Vision untested on real images** | Gemini correctly refuses to score synthetic SVGs ("appears to be a graphic illustration"). `vision:check` proves wiring only. Upload a **real wound photo** to learn anything about clinical behaviour. |
| **IoT** | Drivers, registry and IEEE-11073 decoders are built and tested. Needs real hardware — send make/model + an nRF Connect dump. iOS has no Web Bluetooth; demo on Android or desktop Chrome. |
| **Rate limiting** | In-memory, so per-instance. Redis store is available now; not yet wired. |
| **Docker** | `docker-compose.yml` and `Dockerfile` are written but **never executed** — Docker isn't installed here. Verify before demo day. |
| **Charge schedule** | Referral document charges default to zero and are flagged provisional. Real amounts are state health policy. |

---

## 7. Credentials in `.env` (all live except the DB password)

`SUPABASE_URL` · `SUPABASE_ANON_KEY` · `SUPABASE_SERVICE_ROLE_KEY` ·
`DATABASE_URL` · `DATABASE_POOLER_URL` · `GROQ_API_KEY` (assessment +
Whisper STT) · `Gemini_API_Key` (wound vision) · `LIVEKIT_*` · `REDIS_URL`
(Upstash, **must be `rediss://`**) · `SEED_DEMO_PASSWORD`

> **Rotate the Groq, Gemini and Supabase keys before anything public.** All
> were pasted into a chat transcript, and the GitHub repo is public.

Two Supabase dashboard settings have no code equivalent and silently break
authorisation if wrong — see `docs/SETUP.md`:
1. **Auth → Hooks → Customize Access Token (JWT) Claims** → must point at
   `public.custom_access_token_hook`. It is currently ON.
2. **Auth → Providers → Email → Enable sign-ups** → must be OFF.

---

## 8. What is built

Phases 0–5 and 7 are complete and verified against live infrastructure:
auth + 8 roles + RLS, patients (12-digit Verhoeff health ID), intake
(vitals, symptoms, voice, multi-file uploads from camera or storage), OCR
(Tesseract, ~93% on printed labs), deterministic lab parsing, triage engine
+ golden case suite, Groq assessment, care plans (first aid / medication /
precautions / diet), consultations with a 5-minute tolerance window and
auto-reassignment, realtime notifications, HIGH-tier referral with hospital
ranking and a printable slip, doctor review with the flag-back loop, admin
region management, Kanpur demo seed data, and the React frontend.

**Deferred by the owner:** IoT hardware integration (Phase 6).

---

## 9. Working agreements from this session

- **Assume and fill in** missing information rather than blocking; mark it
  for replacement. The one carve-out is drug names and dosages, where a
  fabricated-but-plausible value is the kind a health worker could act on.
- **Never fabricate real-world data** as real — placeholder data is always
  labelled `PLACEHOLDER_DEMO`, and demo phone numbers are `+91-00000-xxxxx`
  so they cannot dial a real person.
- **Edit regex-bearing code with a real editor tool**, not through nested
  bash/Python string escaping — that silently turned `\b` into a literal
  backspace character once (D-060) and cost an hour.
- **Migrations are immutable.** Add a new numbered file; never edit an
  applied one.

# Decision Records

Every deviation from the original Phase 2 brief, with reasoning. Per the
brief's output rules, conflicts are recorded here rather than resolved
silently.

---

## D-001 — Postgres (Supabase), not MongoDB
**Brief said:** `mongo-data/` folder, implying self-hosted MongoDB.
**Decision:** Supabase / Postgres. `mongo-data/` → `db-data/`.
**Confirmed by:** project owner.
**Why:** the role model needs row-level security, which Postgres has natively
and Mongo does not. With RLS, a forgotten `WHERE doctor_id = …` returns zero
rows instead of every patient in the state — the difference between a bug and
a data-breach incident. Realtime and storage also come free rather than being
hand-built. Full comparison: `PHASE1_ARCHITECTURE_PLAN.md` §A.2.

---

## D-002 — 12-digit RuralAI Health ID, not Aadhaar
**Brief said:** "Aadhaar as primary key" (§2 and Build Phase 2).
**Decision:** system-issued 12-digit RHID. No government ID data stored at all.
**Confirmed by:** project owner — *"do what will be easiest and if aadhaar face
any hinderence remove it and use abha."*
**Why:** Aadhaar does face a hindrance. Storing raw Aadhaar numbers is
restricted to AUA/KUA-licensed entities under the Aadhaar Act 2016; DPDP 2023
adds duties on top. So Aadhaar is out.

ABHA was the named alternative, but it is **not** the easiest option: it
requires NHA registration to validate, and many rural patients do not have one
— which would block registration at the point of care, exactly where blocking
is least acceptable.

An RHID we issue ourselves is instant, needs no external dependency, works
during the emergency-bypass flow, and carries no legal baggage. `abha_id` is
kept as an **optional** column for patients who already have one, so ABDM
interoperability stays open.
**Owner should confirm** this reading of "easiest" is what was intended.

---

## D-003 — Plain JavaScript, not TypeScript
**Brief said:** `app.js`, `server.js`, `jest.config.js`.
**Decision:** plain JavaScript (ESM), per owner's explicit choice.
**Trade-off accepted:** no compile-time checking on clinical data shapes.
**Mitigation:** Zod validation is mandatory on every route that accepts input,
and on every LLM structured output. In JS, runtime validation is the only thing
between a malformed payload and the triage engine — so an unvalidated body on a
clinical endpoint is treated as a defect in review, not a shortcut.

---

## D-004 — `web/` added for the frontend
**Brief said:** backend-only structure, but Build Phase 8 requires a frontend.
**Decision:** monorepo — Next.js frontend in `web/`.
**Confirmed by:** owner — *"you are free to modify it accordingly."*
**Why:** single repo means one docker-compose, one deploy pipeline, and shared
validation schemas between API and UI. Two repos would duplicate types and add
sync overhead before a demo deadline.

---

## D-005 — `Dockerfile` added
**Why:** `docker-compose.yml` was required and has a `build` stanza, which
needs a Dockerfile. Multi-stage, non-root user, `tini` as PID 1 so SIGTERM
reaches Node and the graceful shutdown in `server.js` actually runs.

---

## D-006 — `scripts/` added
**Why:** `npm run db:check` and the migration runner need somewhere to live
that isn't `utils/` (shared helpers imported by the app) or `jobs/` (queued
background work). These are operator tools run from a terminal.

---

## D-007 — Migrations as SQL files, not via Supabase MCP
**Context:** the Supabase MCP server is installed but unauthenticated, and
authorising it needs an interactive OAuth flow.
**Decision:** skip it. Schema ships as numbered SQL files in `db/migrations/`,
applied via the Supabase dashboard SQL editor or CLI.
**Why this is better anyway:** migrations in version control are reviewable,
replayable and reversible. For a healthcare system where RLS policies are a
security control, every policy change belonging to git history is the correct
default regardless of tooling.

---

## D-008 — Rate limiting is per-instance in Phase 0
**Gap, not a decision.** `express-rate-limit` uses its in-memory store, so
behind the load balancer N instances means N× the effective limit.
**Resolution:** Redis store in Phase 1, alongside the Socket.IO Redis adapter.

---

## D-009 — Docker written but unverified
Docker is not installed on the current dev machine. `docker-compose.yml` and
`Dockerfile` are written to spec but have never been executed. **Must be
verified before the demo** — do not discover this on the day.

---

## D-010 — Direct Postgres host is IPv6-only
`db.<ref>.supabase.co` has no A record. It works from the current dev machine,
but most PaaS providers (Railway, Render, Vercel functions) have no IPv6
egress. Deployment will need the Supavisor **session pooler** URL.
`DATABASE_POOLER_URL` is already wired in `config/db.js` and takes precedence
when set.

---

## Open — awaiting owner input

Per the brief's hard rule, these are blocking their respective phases rather
than being stubbed or guessed.

| Needed for | Question |
|---|---|
| Phase 3 | STT/TTS/translation provider — Bhashini (recommended, free, Government of India) vs Google Cloud. Credentials needed. |
| Phase 3 | Which languages for the demo? Hindi + English minimum. |
| Phase 4 | LLM provider, tier, and API key for the assessment layer. Has a real per-assessment cost. |
| Phase 4 | **Clinician who can review and sign the OTC formulary.** On the critical path — start before the code. |
| Phase 5 | Video provider. 100ms recommended (India infra, free tier). Credentials needed. |
| Phase 6 | **Exact make and model of the oximeter and thermometer.** A BLE driver cannot be written against a guessed GATT profile. |
| Phase 6 | Demo device must be Android or desktop Chrome — **iOS does not support Web Bluetooth.** |
| Phase 7 | Real source for hospital / district / doctor data, or explicit approval to ship clearly-labelled placeholder seed data. |

---

## D-011 — Column-level revoke does not override a table-level grant
**Found by:** `tests/rls.test.js` (migration 0006 fixes it).

Migration 0004 ran `revoke update (role, is_active, …) on profiles from
authenticated`. Postgres reported success and **changed nothing**: Supabase
grants a *table-level* `UPDATE` to `authenticated`, which covers every column,
and revoking a column-level privilege does not carve a hole out of it.

Combined with the `profiles_update_self` policy, any signed-in staff member
could have set their own role to `super_admin`. The 0004 trigger was the only
thing stopping it — one control where the design called for two.

**Correct sequence:** revoke the table-level grant first, then grant back the
specific columns. `tests/rls.test.js` now asserts there is no table-level
UPDATE grant, so this cannot regress silently.

---

## D-012 — Profiles are deactivated, never deleted
**Found while testing** (migration 0007).

`audit_log.actor_id` was `ON DELETE SET NULL`. Deleting a profile fired an
UPDATE on `audit_log`, which the append-only trigger correctly refused — so
the delete failed with the misleading message *"audit_log is append-only:
UPDATE is not permitted"*, naming the wrong table entirely.

Worse, had it succeeded it would have **erased attribution**: deleting a
doctor would have anonymised every clinical decision they ever made. An audit
log that forgets who acted is not an audit log.

**Now:** `ON DELETE RESTRICT`, plus a trigger that says plainly which profile
has how many audit entries and to deactivate instead. This matches the
documented policy; the database now enforces it.

**Consequence for tests:** `scripts/e2e-auth-smoke.js` cannot assume an empty
database. It bootstraps only on a virgin system, otherwise reuses an existing
super_admin, and disposes of its accounts by deactivating them and rotating
the credential.

---

## D-013 — Docker install deferred
Docker is still not installed. Phase 1 does not need it — the stack runs
against hosted Supabase. Deferred rather than pushing a system-level install
that is not yet on the critical path. **Still must be verified before the
demo** (D-009).

---

## D-014 — Two dashboard steps silently break authorisation
Not decisions, but the highest-risk operational gotchas found so far. Both are
documented in `docs/SETUP.md` §4.

1. **The custom access token hook must be enabled** in Authentication → Hooks.
   Without it JWTs carry no `app_role` claim, every role-checking RLS policy
   evaluates to null and denies, and a valid login can read nothing. It
   presents as a broken database; it is a missing checkbox.
2. **Public signup must be disabled** in Authentication → Providers → Email.
   Three code layers already prevent self-registration, but the endpoint
   should not exist.

---

## D-015 — Verhoeff, not Luhn, for the RHID check digit
The RHID is 11 random digits plus a **Verhoeff** check digit.

Verhoeff catches all single-digit errors **and all adjacent transpositions**
(typing 21 for 12). Luhn misses the 09/90 transposition. Health workers read
these numbers aloud from a card and type them in groups, so transposition is
the realistic error — and a mistyped ID that passes validation creates a
second patient record for the same person, which is the single largest source
of duplicates in field EMRs.

`tests/rhid.test.js` proves both properties exhaustively against generated
ids rather than asserting a fixed example.

Also: **random, not sequential** (a sequential id leaks patient volume and
permits enumeration), and **never a leading zero** (a leading zero lost to a
spreadsheet or an integer cast silently corrupts the identifier).

---

## D-016 — Emergency registration cannot be blocked by a missing age
The schema requires either a date of birth or an age, because paediatric
dosing, IMCI danger signs and the risk score all branch on it.

The emergency bypass would otherwise be blocked by exactly the field a
panicking relative is least able to supply. Resolution: unknown age is stored
as 0 with `registration_complete = false`, and downstream triage treats an
incomplete record as **missing data, which raises the tier**. Care is never
blocked; the gap is visible and conservative rather than silently assumed
benign.

---

## D-017 — RLS test suite restructured after it began hanging
**Symptom:** intermittent failures, then a full-suite hang past 600s.

**Cause, and it was not the timeout:** the RLS suites re-seeded geography and
patients inside *every test case*. Against a REMOTE Postgres that is ~8
network round trips per test, so a 22-test file made ~180 round trips. Between
that, a connection pool capped at 2 in test mode, and one test opening a
nested connection inside an open transaction, the suite starved.

**Fix (structural, in `tests/helpers/dbFixture.js`):** seed **once per file**
in one transaction on one connection, give each test a SAVEPOINT for
isolation, roll the whole thing back at the end. Pool cap raised to 10;
`maxWorkers` capped at 2 so parallel workers do not each hold open
transactions against one remote database.

**Result:** 137s and hanging → 47s, stable across repeated runs.

**Better still, later:** run these against a local Postgres via
`docker compose --profile local-db up`. Blocked on Docker not being installed
(D-009/D-013).

---

## D-018 — The `code` column truncation bug (caught by the fixture)
While writing the fixture I truncated generated region codes to 10 characters,
which made "State A" and "State B" produce the *identical* code and violate the
unique constraint. `code` is `text` with no length limit, so the truncation was
pointless as well as wrong. Noted because it is the kind of defect that looks
like a database problem and is not.

---

## D-019 — `visit_id`, not `encounter_id`
The Phase 3 brief specifies `attachments.encounter_id` and
`symptom_entries.encounter_id`. Phase 2 already built, tested and policied
this table as `visits` (migration 0008). Same concept; renaming an applied
table with live RLS policies is churn for no gain. The foreign key is
`visit_id`. Flagged rather than silently resolved.

---

## D-020 — Supabase MCP is still not connected
The Phase 3 brief states "Supabase MCP connected, read-only". It is not — it
remains unauthenticated (D-007), and all schema work continues to ship as
versioned SQL migrations, which the Phase 3 constraints also require.

---

## D-021 — Magic-byte validation, not extension or Content-Type
Both the file extension and the client-supplied `Content-Type` are trivially
forged. Accepting either means a `.jpg` that is actually HTML with a script
payload. `utils/fileSignature.js` identifies files from their bytes and
allowlists five formats (JPEG, PNG, WebP, HEIC, PDF).

**HEIC and WebP are included deliberately** — they are what phone cameras
actually produce, and rejecting them would break the camera capture path on
most modern Android and iOS devices.

**SVG is deliberately excluded** despite being an image: it is a scriptable
format and an XSS vector when served inline.

**PDFs are rejected for `wound_image`** specifically. A wound photograph is
never a document, and the narrower the allowlist per type, the smaller the
surface.

A declared/actual MIME mismatch is logged and the bytes win.

---

## D-022 — Storage is private, signed-URL only
No bucket is public and no code path creates one. Objects are reachable only
through signed URLs with a 300-second TTL — a leaked wound-image link is a
personal-data breach, so it should expire before it can travel.

`storage.objects` policies mirror the table policies: you can reach an object
only if you can reach the `attachments` row pointing at it. There is no
UPDATE or DELETE policy at all — uploaded clinical evidence is immutable, and
a test asserts only SELECT and INSERT policies exist.

Storage paths are `<facility_id>/<visit_id>/<uuid>.<ext>` — opaque by
construction, carrying no patient name and no original filename, so the path
itself is safe to log and appears in error messages.

---

## D-023 — No PHI in logs, including filenames
`ramesh-kumar-xray.jpg` is PHI. Consequently:
- Original filenames are stored (users need to see them) but **never logged**.
- Upload failure messages name the reason and the index, never the file.
- Symptom text is never logged, and never enters audit metadata — only its
  language, input mode and character count.
- Audit `before`/`after` snapshots pass through a redactor that strips
  `rhid`, `abha_id`, tokens and passwords.

---

## D-024 — A failed batch upload reports per file
An assistant who uploads five photos and loses all of them because the fifth
was rejected will not upload again. Uploads are processed per file with a
shared `upload_batch_id`; the response returns `uploaded` and `rejected`
separately, and only a wholly failed batch is an error.

Uploads run sequentially, not in parallel: a rural uplink gains nothing from
ten concurrent multipart writes and memory stays bounded.

---

## D-025 — STT: a wrong-language model is a clinical risk
Google Cloud STT has no Bhojpuri model. The failover chain therefore **skips**
a provider that lacks the requested language rather than substituting a
related one — transcribing Bhojpuri with a Hindi model produces plausible,
wrong symptom text, and downstream triage cannot tell a bad transcript from a
real one. For the same reason, total failure throws instead of returning an
empty or guessed transcript.

Empty audio is validated before the failover loop: it is a caller error, not
a provider outage, and retrying it down the whole chain would burn quota and
misreport a client bug as a provider failure.

`POST /intake/visits/:id/symptoms` with `inputMode: "voice"` returns 503
`STT_NOT_CONFIGURED` rather than storing an untranscribed entry.

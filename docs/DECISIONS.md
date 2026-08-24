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

---

## D-026 — Bhojpuri removed from the demo language set
Per owner instruction. Demo languages are now Hindi, Bengali, Tamil, English.

**Consequence worth knowing:** Bhojpuri was the only language Google Cloud STT
could not serve. With it gone, *either* provider covers the full set alone, so
Bhashini is now a preference (cost, and the Government-of-India platform story
for the demo) rather than a necessity. The fallback chain is now genuine
redundancy instead of a coverage requirement.

The skip-don't-substitute rule in the failover chain stays. It is a safety
property of the chain, not a Bhojpuri workaround.

---

## D-027 — Triage thresholds are UNVALIDATED pending physician sign-off
`services/triage/rules.js` implements thresholds derived from published
sources — NEWS2 (adult physiology), WHO IMCI (paediatric danger signs), PALS
(age-banded respiratory rates). Each rule cites its source in its output.

**They have not been reviewed by a clinician for this deployment.** The
ruleset version is stamped `2026.08.1-unvalidated` and appears on every
assessment. The golden case suite is likewise constructed, not clinically
reviewed.

This is the highest-priority external dependency in the project. Until a
registered physician signs off both the thresholds and the golden cases, the
system must not be used for real patients, and the README carries a "not for
clinical use" notice.

---

## D-028 — The triage invariant is enforced in exactly one place
`final_tier = MAX(rule_tier, model_tier)`, implemented once in
`services/triage/engine.js` rather than trusted to callers.

Fail-safe behaviour, in order of how badly each would otherwise go wrong:
- Model throws, times out, or returns unparseable output -> **MEDIUM**.
  A degraded AI must never mean "send them home".
- Model returns a tier below the rule floor -> floor wins, and
  `modelAttemptedDeEscalation` is recorded. That flag is the signal that the
  model is miscalibrated in the one direction that harms patients, and it is
  worth watching in aggregate.
- **No model configured at all -> minimum MEDIUM.** Rules alone cannot
  justify LOW: they see only vitals and a red-flag phrase list, so anything
  they miss would otherwise go home unreviewed. This is why the system
  currently floors every case at MEDIUM — there is no LLM wired yet.

---

## D-029 — Golden cases run against a model that always says LOW
The golden suite drives the engine with a stub model that insists every
patient is fine. Every escalation therefore has to come from the
deterministic rule floor, against active disagreement.

The first version ran with no model at all, and the engine's "no model ->
MEDIUM" fallback silently masked whether the rules had fired — two LOW cases
passed for the wrong reason. Caught by the `exact: true` assertions.

24 cases covering: vitals-only escalation, symptom red flags with entirely
normal vitals (the cases a vitals-only system misses), IMCI danger signs,
neonates, and missing-data fail-safes. Under-triage fails the build;
over-triage is permitted except where `exact: true`.

---

## D-030 — LLM: hosted now, self-hosted DeepSeek R1 after incubation
**Owner decision.** Near term: a hosted provider (account being provisioned
by the owner; provider not yet named). Long term: **DeepSeek R1 self-hosted
on a GPU pod post-incubation.**

**Why the adapter is written against the OpenAI wire format rather than a
DeepSeek-specific one:** vLLM and SGLang — the two realistic ways to serve
R1 — both expose an OpenAI-compatible `/v1/chat/completions` endpoint. One
adapter therefore serves *any* self-hosted open-weight model, so replacing
R1 with something newer becomes a config change instead of a rewrite.

**Note for whoever implements it:** R1 is a reasoning model and emits a
`<think>` block before its answer. That block must be stripped before JSON
parsing, and it must never be persisted or logged — it restates patient
details at length, so it is PHI.

**Output validation lives in the base class, not the adapters.** An adapter
implements `_complete()` and returns raw parsed JSON; `assess()` validates it
against a Zod schema. An adapter therefore cannot skip validation even by
accident. The schema has **no field for medication** — there is deliberately
nowhere for a model to put a drug name, dose or frequency, and a test asserts
that.

Unlike the STT chain, schema-invalid output is **not retried against the same
provider**. Retrying malformed clinical output is more likely to burn twenty
seconds than to fix anything, and the engine's fail-safe to MEDIUM is a
perfectly safe outcome. A health worker is standing in front of a patient.

---

## D-031 — Video: LiveKit, not 100ms
**Owner decision** — 100ms asked for payment. LiveKit is the better fit
anyway: open source (Apache 2.0), self-hostable, and consistent with the
DeepSeek self-hosting direction in D-030, so the same "free tier now,
self-host after incubation" path applies to both.

Trade-off versus the original 100ms recommendation: 100ms has India-region
infrastructure out of the box, which was its main draw for latency and for a
data-residency answer. With LiveKit Cloud the region depends on the project
setting; self-hosted LiveKit on an Indian VPS gives full control but means
owning TURN capacity — which is precisely what fails on a hostile venue
network. **For the demo, use LiveKit Cloud rather than self-hosting**, and
revisit after incubation.

Unchanged from the original plan: notification delivery stays completely
decoupled from the video provider. Scheduling, the 5-minute tolerance window,
ringing and reassignment are ours; the provider only supplies a room.
Swapping providers should touch no scheduling logic.

---

## D-032 — IoT: ports and drivers built, hardware pending
**Owner decision** — build the abstraction and drivers now, hardware to be
purchased later.

Delivered, and it is real code rather than a mock:
- `services/iot/ieee11073.js` — SFLOAT and FLOAT decoders. BLE health
  profiles do not use IEEE-754, and both formats reserve specific mantissas
  for NaN/infinity/not-at-this-resolution. Those are surfaced as `null`, not
  decoded: **NaN (0x07FF) read as a number becomes 2047, a plausible-looking
  pulse rate.** That is the classic bug in this layer.
- `drivers/blePulseOximeter.js` — SIG standard PLX service (0x1822).
- `drivers/bleThermometer.js` — SIG standard Health Thermometer (0x1809),
  with Fahrenheit→Celsius conversion. Unconverted, 98.6 would read as a
  fever that isn't there.
- `drivers/simulated.js` — emits spec-compliant payloads so it drives the
  REAL parsers, and marks every observation `SIMULATED` all the way into the
  database.
- `registry.js` — routing by GATT UUID or capability, plus the repeatable
  add-a-device procedure.

Observations are FHIR-shaped with LOINC codes. That costs nothing now and
makes ABDM/FHIR interoperability a mapping exercise later.

**Two things that need real hardware:**
1. **Many cheap consumer oximeters are not SIG-compliant** — they expose
   proprietary characteristics. Those need a per-model driver, which is
   exactly what the abstraction is for. Send the make/model and an nRF
   Connect characteristic dump and it is a short file.
2. **Captured raw payloads.** CI has no physical device, so a saved byte
   buffer from the real hardware is the only regression protection a driver
   will ever get. Capture some on day one.

**Readings the device itself distrusts are rejected, not stored.** A PLX
payload flagging poor perfusion or inadequate signal produces no
observation — a spurious SpO2 of 99% would *mask* hypoxia, which is worse
than having no reading.

---

## D-033 — Deferred by owner
- **Access token hook / signup disable / key rotation** — owner will do
  later. `tests/live-auth-path.test.js` stays red until then; it is a
  configuration canary, not a code defect.
- **Clinician sign-off on triage thresholds and the golden case suite**
  (D-027) — skipped for now at owner's direction. The ruleset stays stamped
  `unvalidated` and the README keeps its "not for clinical use" notice.
  Flagging once more that this is the longest-lead-time item in the project
  and the only one that cannot be bought with an API key.

---

## D-034 — The IPv6-only DB host bit us, as D-010 predicted
**Symptom:** 71 tests failed across the four DB-backed suites with
`getaddrinfo ENOTFOUND db.<ref>.supabase.co`, while `nslookup` resolved the
host fine and the REST API returned 200. It looked exactly like a code
regression introduced alongside the LLM and IoT work. It was not — the
non-DB suites (211 tests) all passed, and the DB suites failed identically
when run serially.

**Cause:** the direct Postgres host has **only an AAAA record**. When the
machine's IPv6 route drops, the OS resolver returns no usable address and
Node reports the host as non-existent. `nslookup` queries DNS directly and
still succeeds, which is what makes this so misleading.

**Fix:** `DATABASE_POOLER_URL` — the IPv4 Supavisor pooler. `config/db.js`
already prefers it when set.

**Why it is not set yet:** the pooler hostname cannot be derived. Trying
`aws-0-*` and `aws-1-*` across five regions returned "Tenant or user not
found" every time, so the region and hostname have to come from the
dashboard. Requested from the owner.

**Mitigation shipped:** `explainConnectionError()` in `config/db.js`, wired
into `npm run db:check`, turns both failure modes into an actionable message
instead of a bare DNS error. This cost ten minutes and will save an hour the
next time it happens — probably on a venue network on demo day, which is
exactly where IPv6 is least likely to work.

---

## D-035 — Groq wired as the concrete near-term LLM provider
**Owner instruction**, 2026-08-24: use Groq now (`llama-3.3-70b-versatile`),
self-hosted DeepSeek R1 after incubation (already tracked as D-030).

**What changed:** the previous `HostedLlmAdapter` stub is replaced by a real
`GroqLlmAdapter` in `services/llm/adapters.js`. It calls Groq's
OpenAI-compatible `/v1/chat/completions` endpoint directly via `fetch` — no
SDK dependency, which keeps the adapter identical in shape to the
soon-to-be-real `SelfHostedLlmAdapter` and means the eventual DeepSeek
adapter is close to a copy of this file with a different base URL.

**Stayed in Node, did not introduce Python.** The owner's example was a
Python ReAct-style tool-calling agent loop. This system does not need tool
calling — the assessment layer needs one structured JSON call per triage —
and the repo is Node/Express end to end (D-003). Adding a second language
runtime for one API call would mean a second dependency tree, a second test
harness, and a process boundary between it and the triage engine for no
capability gained. The equivalent logic is `services/llm/adapters.js` +
`services/llm/prompt.js`, wired into the same `assess()` contract every
other provider (and the engine itself) already uses.

**Prompt design** (`services/llm/prompt.js`, versioned separately from any
adapter so every provider is prompted identically):
- Explicitly tells the model its tier is a **floor candidate only** — the
  deterministic rules layer can raise it further, and the model is told not
  to reason around that.
- Explicitly forbids mentioning any medication, drug name, or dose. The
  output schema already has no field for one (tested); the prompt exists so
  the model is never invited to reach for one in its reasoning either — a
  suppressed field is a weaker guardrail than a model never asked.
- "When uncertain, choose the higher tier" is stated as the first rule, in
  those words, because it is the one instruction that matters most if
  everything else in the prompt is ignored.
- Uses Groq's `response_format: json_object` (JSON mode), which removes the
  most common real-world failure — markdown fences, leading commentary —
  before validation even runs.

**Testing discipline:** `tests/llm.test.js` never calls the real Groq API.
`fetchImpl` is dependency-injected into `GroqLlmAdapter`, defaulting to the
global `fetch` in production and to a fake in every test — so CI is free,
deterministic, and never depends on Groq's uptime or the owner's quota.
`npm run llm:check` (`scripts/llm-smoke.js`) is the one place allowed to hit
the real API, run by hand against two constructed cases whenever the prompt
or key changes.

**Privacy note, worth flagging explicitly:** every assessment request sends
patient vitals and symptom text to a third-party US inference provider. This
is inherent to using a hosted LLM at all, not specific to Groq, but it is a
DPDP-relevant fact the eventual consent flow (`consents` table,
PHASE1_ARCHITECTURE_PLAN.md §B.2) needs to account for, and it is the kind
of detail worth being upfront about if asked in the demo.

**Key handling:** the Groq key was shared in this conversation and is now in
the transcript. Same caution as the Supabase keys and DB password earlier —
**rotate it** at console.groq.com/keys before anything public-facing, and
prefer editing `.env` directly over pasting a key in future.

---

## D-036 — Groq model corrected to openai/gpt-oss-120b, prompt hardened with a worked example
`llama-3.3-70b-versatile` (used in D-035 and in the owner's example script) has
been **withdrawn from Groq's API** and returns `404 model_not_found` for this
key. `GET /openai/v1/models` against the live key lists what is actually
available; `openai/gpt-oss-120b` was chosen as the largest model present.
**Groq's catalogue changes without notice — re-run `npm run llm:check` after
any model or key change**, since this exact failure mode (a suddenly
nonexistent model) is easy to miss until an assessment silently fails over
to MEDIUM.

**gpt-oss-120b returns a separate `message.reasoning` field** (chain of
thought) alongside `message.content`, the same shape as the DeepSeek R1
`<think>` block noted in D-030. `GroqLlmAdapter._complete()` reads only
`.content` and never touches `.reasoning` — worth stating explicitly because
that field would restate patient details at length and must never be logged
or persisted.

**The real smoke test caught a real quality problem the mocked test suite
could not:** against a genuine chest-pain case, Groq returned a
`differential` array where some entries were bare strings instead of the
required object shape. Schema validation correctly rejected it — this is
exactly the boundary in `LlmProvider.assess()` doing its job — and the
engine failed over to the rule floor, landing HIGH on the chest-pain red
flag alone with `modelTier: null`. **The safety architecture held under a
real, unplanned model failure, not a simulated one.**

Fixed by adding one complete worked example to the end of the system prompt
(`services/llm/prompt.js`) showing the exact object shape for every
differential entry. Open-weight models follow a concrete example far more
reliably than an abstract schema description. Re-running `npm run
llm:check` afterwards: both cases returned valid, schema-passing output, and
on the chest-pain case the model *itself* named acute myocardial infarction
at 70% confidence and agreed with the rule floor — model and rules aligned,
`escalationReason: model_and_rules_agree`.

---

## D-037 — Pooler connected; test pool size fixed to match
**Owner supplied the real Supavisor session-pooler string** (region
`ap-southeast-2`, not the `ap-south-1` guessed earlier — five regions were
tried blind in D-034 and all failed; the real one had to come from the
dashboard, as expected). `DATABASE_POOLER_URL` is now set and `config/db.js`
already preferred it once set, so D-010/D-034's IPv6 fragility is resolved:
the app and tests now connect over IPv4 regardless of the machine's IPv6
route, which matters most on a venue network on demo day.

**This immediately surfaced a second, different problem.** The full test
suite passed 290/290 serially but failed intermittently (14–71 tests) in
Jest's normal parallel mode — and only after switching to the pooler. Cause:
`config/db.js` set `max: 10` unconditionally, and `jest.config.js` already
capped `maxWorkers: 2`, so worst case was 2 × 10 = 20 concurrent
connections. The **direct** host tolerated that fine; Supavisor's **session
pooler** caps total connections far more tightly, so parallel test runs
exhausted it while serial runs and direct-connection runs never had.

Fixed by making the pool size test-aware: `max: env.isTest ? 3 : 10`, giving
a worst case of 2 × 3 = 6 concurrent test connections — comfortably under
the pooler's cap — while production keeps the generous `max: 10` the direct
host always supported. Verified: 290/290 passing in Jest's normal parallel
mode, not just `--runInBand`.

**Also discovered while investigating:** `tests/live-auth-path.test.js` is
now genuinely green (9/9) — the access-token-hook canary from D-033 is
passing for real, meaning the hook has been enabled since it was last
checked. Confirmed by running that suite in isolation, not inferred from the
full-suite count. RLS via a real login now works end to end.

---

## D-038 — Two of the four values supplied were not usable as given
Alongside the pooler string, the owner supplied a `GROQ_BASE_URL` and a
LiveKit secret. Neither could be wired in as sent, and per the
ask-don't-assume rule, flagged rather than guessed around:

1. **`GROQ_BASE_URL=https://<id>.us-west-1-0.aws.cloud.qdrant.io`** — this is
   a **Qdrant Cloud vector-database cluster URL**, not a Groq API endpoint.
   Groq's chat-completions endpoint
   (`https://api.groq.com/openai/v1/chat/completions`, already hardcoded as
   `GROQ_CHAT_COMPLETIONS_URL` in `services/llm/adapters.js`) has no
   relationship to Qdrant. **Not applied.** If a vector store is intended
   for something else in the project (e.g. retrieval for the differential
   layer, per PHASE1_ARCHITECTURE_PLAN.md §D.1's RAG discussion), that is a
   separate, real integration — say so explicitly and it can be planned
   properly, rather than silently repurposing an unrelated URL as an LLM
   base-URL override.
2. **`LIVEKIT_API_SECRET=••••••••••••••••••••••••••••••••`** — this is a
   **masked display value** from the LiveKit dashboard, not the actual
   secret; dashboards render secrets as bullets after creation specifically
   so they cannot be read back. `LIVEKIT_URL` and `LIVEKIT_API_KEY` are real
   and are now in `.env`; the secret is commented out pending the real
   value. LiveKit API secrets are typically shown only once, at key
   creation — if it cannot be revealed again in the dashboard, generate a
   new key pair rather than guessing.

---

## D-039 — LiveKit wired: token generation is live, full scheduling is not
**Owner supplied real, working LiveKit credentials** (a second, regenerated
key pair — the first API key sent earlier carried a masked secret and
could not be used, see D-038). Verified end to end with `npm run
livekit:check`: authenticate, create a room, mint a join token, delete the
room, all against the real LiveKit Cloud project.

**What "wire up LiveKit" means concretely, and what is built now**
(`services/video/livekit.js`):
- `createJoinToken()` — mints a signed access token scoped to one visit's
  room, with role-shaped permissions (clinical roles can publish and
  subscribe; anything else is subscribe-only, though no caller reaches
  that branch yet).
- `ensureRoom()` / `closeRoom()` — idempotent room lifecycle via
  `RoomServiceClient`.
- `roomNameForVisit()` — deterministic `visit-<id>` naming, so two
  participants calling independently land in the same room without any
  coordination step.
- `POST /api/v1/video/visits/:visitId/token` and `/close` — gated by the
  same RLS-backed visit-reachability check every other visit-scoped
  endpoint already uses (`supabaseAsUser`, not the service role): if RLS
  will not return the visit for this caller, no token is minted.

**Why token generation needed no network mocking in tests, unlike Groq:** a
LiveKit access token is a self-contained signed JWT — minted entirely with
the local API secret, verified in `tests/livekit.test.js` by independently
decoding it with `jsonwebtoken` and asserting the room/grant/identity
claims. LiveKit's servers see it only when a client later uses it to
connect. This is genuinely offline-testable code, not code that merely
happens to be mocked. `RoomServiceClient` calls (create/list/delete a real
room) are the one part that does hit the network, and those are exercised
for real by `npm run livekit:check` — same split as the Groq smoke test.

**What is deliberately NOT built yet**, because it needs foundations that
don't exist:
- The `consultations` table and its RLS policies.
- Scheduling: doctor selection by disease category, load balancing across
  available doctors.
- The 5-minute tolerance window and auto-reassignment on a missed call —
  needs a delayed job, i.e. BullMQ + Redis (`REDIS_URL` not configured).
- Realtime notifications to both parties on scheduling/ringing/joining —
  needs `sockets/`, not built yet.
- The "one active call per doctor" constraint.

Building those now, without a `consultations` schema or a job queue in
place, would mean redoing them shortly after rather than building once.
`services/video/livekit.js` is the piece with no such dependency, so it
ships now; the rest is real remaining Phase 5 scope, not an oversight.

**A production detail worth flagging for later:** `createJoinToken()`
currently trusts `req.user.role` from the authenticated session to decide
publish rights, which is correct today because only clinical roles can
reach the route at all (`requireRole` in `routes/video.routes.js`). Once
the `consultations` table exists, this should additionally check that the
caller is the SPECIFIC doctor/assistant assigned to THIS consultation, not
merely any clinical-role user who can reach the visit via RLS — tracked
alongside the scheduling work above, not a gap in what shipped today.

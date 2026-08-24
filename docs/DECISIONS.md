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

---

## D-040 — Vitals table: a Phase 3 gap found while building Phase 4
Persisting assessments surfaced a real hole: **there was no `vitals`
table**. Phase 3's intake pipeline persisted symptoms and attachments but
never vitals — and the entire deterministic rule layer (NEWS2 thresholds,
PALS age-banded respiratory rates) is built on them.

The system was not broken, but it was useless in a specific and quiet way:
with no vitals to read, the engine always saw "no vitals recorded", which
correctly fires the `no_vitals_recorded` fail-safe and escalates every case
to MEDIUM. **Safe, and completely uninformative** — exactly the kind of
failure that looks like it is working.

Added in migration 0010 with per-column plausibility CHECKs mirroring
`services/iot/DeviceDriver.js` PLAUSIBLE_RANGE, so a manually typed value
faces the same gate as a device reading: a mistyped SpO2 of 9 is as
dangerous as a misparsed one. Two constraints worth noting:
- `vitals_not_empty` — a row recording nothing is a data-entry mistake, not
  a measurement.
- `vitals_bp_ordered` — systolic must exceed diastolic. Physiologically
  impossible otherwise, and almost always means the two were entered the
  wrong way round.

A partially-filled set is explicitly NORMAL, not an error: a health centre
may have a thermometer and no oximeter. Absent values stay absent and the
triage layer treats them as missing data (which escalates), never as normal
values.

---

## D-041 — The escalation invariant is now enforced by Postgres, not just code
`ai_assessments` carries two CHECK constraints:

    final_tier >= rule_tier          (assessment_final_at_least_rule)
    model_tier is null or final_tier >= model_tier

Because `risk_tier` is an ordered enum declared `('low','medium','high')`,
those two statements together are exactly `final = MAX(rule, model)`.

This matters because it moves the system's single most important safety
property out of application code and into storage. Even a compromised
service-role key, a direct `psql` session, or a future bug in
`services/triage/engine.js` **cannot record a de-escalated tier**. Verified
against the live database before shipping: an attempted write of
`rule=high, model=low, final=low` is rejected by name.

Same reasoning for `medication_must_cite_source` on `ai_recommendations`: a
medication row with a null `rule_source_id` is rejected outright, making an
unsourced drug recommendation structurally impossible to store rather than
merely discouraged. Other recommendation types (first_aid, precaution,
diet) need no source and are unaffected.

**`ai_assessments` has no INSERT policy for `authenticated` at all**, and
the grant is revoked. Assessments are authored only by the server after
running the engine — a client able to write its own could fabricate a LOW
tier for a patient the rules would escalate. Tested for all three clinical
roles.

---

## D-042 — Assessment persistence, and what happens when half of it fails
`services/assessment.service.js` gathers input through the CALLER's JWT (so
RLS decides what can be assembled), runs the engine, then writes through the
service role — the narrow, audited service-role use the project rule allows.

Two partial-failure paths, handled differently on purpose:
- **Rule hits fail to write** → the assessment row is deleted. An
  assessment without the evidence justifying its tier is worse than none:
  "why did it say HIGH?" must never answer "we don't know".
- **Visit status update fails** → logged as an error, request still
  succeeds. The assessment itself is saved and correct; only the status
  lagged. Failing here would prompt a re-run, costing another real model
  call for a cosmetic inconsistency.

Verified end to end with `npm run assessment:check` (new): seeds a facility
and assistant, signs in for real, registers a patient, records vitals and a
symptom, runs a REAL Groq assessment, reads it back with evidence, confirms
the visit advanced, and cleans up. On a crushing-chest-pain case it returned
`ruleTier=high, modelTier=high, finalTier=high`, rule hit `chest_pain`, top
differential "Acute myocardial infarction", and advanced the visit to
`referred`. This is the one check that proves the Phase 3 → Phase 4 path
actually joins up; no unit test can.

---

## D-043 — Redis wired; the tolerance window is a job, not a timer
Owner supplied Upstash credentials, so the 5-minute tolerance window and
the doctor review loop are now built (migration 0011).

**The URL scheme needed correcting.** Upstash's dashboard shows
`redis-cli --tls -u redis://...` — TLS as a separate flag. ioredis and
BullMQ negotiate TLS from the *scheme*, so the stored URL must be
`rediss://`. With plain `redis://` the connection fails in a way that looks
like a network fault rather than a config error, so `config/env.js` now
rejects a `redis://` URL pointing at upstash.io outright.

**Why a job queue rather than `setTimeout`:** the API runs multiple
instances behind a load balancer. A `setTimeout` lives in one process's
memory and dies with a deploy, a crash, or a scale-down — silently, taking
the patient's escalation with it. A delayed BullMQ job survives all three
and fires on whichever instance is alive. Verified on Upstash before
building on it: delayed jobs fire at 3179ms against a 3000ms target, and
blocking commands (which BullMQ needs) are permitted.

**Degraded mode is explicit.** Without `REDIS_URL` the API still serves
every clinical route and calls still connect — only automatic
miss-and-reassign is unavailable. That is a real loss of safety, so it is
logged loudly at boot and on every schedule attempt rather than passed over
in silence. Redis is reported by `/health` but deliberately NOT part of
readiness: failing readiness would pull a working instance out of the load
balancer over a degraded background feature.

---

## D-044 — Spec rules encoded as database constraints, not intentions
Three rules from the original brief now hold at the storage layer:

- **"One active call per doctor at a time"** → a partial unique index on
  `consultations(doctor_id) where status in ('ringing','active')`.
  Application checks and UI state both race under concurrent scheduling;
  a unique index cannot. When it fires, `scheduleConsultation` translates
  the 23505 into a `DOCTOR_BECAME_BUSY` conflict — a real race between
  doctor selection and insert, not a bug.
- **A flag-back must explain itself** → `flag_requires_note` rejects
  `action = 'flag_to_assistant'` with a null *or whitespace-only* note. An
  unexplained flag cannot be acted on by the assistant who receives it.
- **One review per assessment** → unique index. A change of mind is a new
  assessment or a consultation, not a rewritten review.

Also: `consultations` has no INSERT policy for `authenticated` (scheduling
involves load balancing and a timer a client must not forge), and the only
client-writable part of a `doctor_review` is the assistant's
acknowledgement — the clinical content is immutable once written.

**A duplicate table was avoided by accident.** The first draft of migration
0011 created a `doctor_availability` table and collided with the *enum* of
that name from migration 0001. Checking what already existed showed
`public.doctors` already carries `availability_status`, `specialities` and
`max_concurrent_cases` — everything the load balancer needs. The new table
would have been a second source of truth for the same fact, and the two
would have drifted. Dropped it; added indexes to `doctors` instead.

---

## D-045 — A colon in a BullMQ job id would have broken every tolerance window
The end-to-end test caught something no unit test would have: BullMQ
**rejects `:` in a custom job id** (it uses `:` as its own Redis key
separator), failing with `Custom Id cannot contain :`.

`jobIdFor()` originally returned `tolerance:${consultationId}`. The error
surfaces only at enqueue time against real Redis, so **every single
tolerance window would have silently failed to arm in production** — and
the symptom would have been "missed calls are never reassigned", days
later, with no obvious cause. Now `tolerance-${consultationId}`.

This is the second time in this project that a real end-to-end check caught
something the mocked suite could not (the first was Groq returning a
malformed differential, D-036). Both argue for keeping the `*:check`
scripts as a standing habit, not a one-off.

**Both tolerance paths verified against real Redis and a real database:**
- Doctor does not answer → call marked `missed`, auto-reassigned to a
  different available doctor, `reassign_count` incremented, chain traceable
  via `reassigned_from`.
- Doctor answers in time → timer disarmed, no reassignment, exactly one
  consultation left `active`.

Reassignment excludes every doctor who already missed the same chain and
gives up after `MAX_REASSIGNMENTS` (3) rather than looping forever.
Doctor selection is least-loaded-first with a random tie-break, so an
all-idle pool does not funnel every case to the same doctor.

---

## D-046 — Realtime: durable row first, socket push second
`services/notification.service.js` writes the `notifications` row BEFORE
emitting the socket event, deliberately. A crash between the two loses the
push (recoverable — the client reconciles from the table on reconnect) and
not the record (not recoverable at all).

This matters more here than in a typical app: a socket event reaches only a
client connected at that instant, and the target users are a doctor on a
phone and an assistant on a tablet, both on rural connectivity. Without the
durable row, a thirty-second drop means a consultation nobody ever learns
was scheduled.

`notify()` never throws into its caller. A notification is a side effect of
a clinical action; failing the action because a socket was unavailable
would be strictly worse than a late notification.

---

## D-047 — No PHI in notification payloads, enforced not just documented
Notification payloads travel over websockets and may be cached client-side,
so they carry **ids and enum values only** — never a patient name, symptom
text, model reasoning, clinical note, health ID, phone or village. The
client learns *that* something happened and fetches the record itself
through the normal RLS-protected endpoints.

`assertNoPhi()` checks payload keys against a forbidden list and **throws in
development and test**, so the mistake is caught while the code is being
written; in production it logs an error instead of dropping a notification
a clinician is waiting on. `tests/notification-payload.test.js` pins the
rule so a future "just include the patient name, it's convenient" change
fails loudly.

Notifications are also strictly per-person at the database: the RLS policy
is `recipient_id = auth.uid()`, not facility or district scope. A colleague
at the same facility sees none of them. There is no INSERT policy for
`authenticated` at all — a client able to author one could forge a
"consultation scheduled" that no scheduler ever created — and the only
updatable column is `read_at`.

---

## D-048 — Socket rooms are joined from the verified profile, never from the client
Socket.IO authenticates every connection at the handshake against Supabase
(same path as the HTTP middleware, including the deactivated-account
check), then joins rooms derived from the resolved profile. **A client never
names a room**, so it cannot subscribe to another user's stream by guessing
one. `visit:subscribe` is the one client-initiated join, and it is
authorised server-side against the same facility/district scope RLS uses.

Verified against a real server with real tokens over a real socket
(`tests/socket-auth.test.js`): a missing token, a garbage token, and a
structurally-valid-but-unsigned JWT are all rejected at the handshake; an
event emitted for user A reaches A and provably does not reach user B.

---

## D-049 — A shutdown leak the socket tests surfaced
The socket suite hung rather than failing, which is its own kind of signal.
The tests passed in 28s under `--forceExit` — so the hang was Jest unable to
exit, not a test failure.

Cause: `closeSockets()` called `io.close()` but never closed the Redis
**adapter** connections. `io.close()` does not own them, so two ioredis
clients stayed open and kept the event loop alive.

In production this would not have lost data, but every graceful shutdown
would have hit the 15-second force-exit timer in `server.js` and logged
"Graceful shutdown timed out; forcing exit" on every single deploy — noise
that trains you to ignore a message that should mean something. Fixed by
holding the adapter clients and quitting them in `closeSockets()`; the
suite now exits cleanly with no `--forceExit`.

Shutdown order in `server.js` is now sockets → queue → pool: stop accepting
new realtime work, let an in-flight tolerance expiry finish, then drop the
database connection it needed.

---

## D-050 — Voice intake: Groq Whisper, no new credentials
Owner asked for "any free tier alternative" for STT. Groq already serves
**whisper-large-v3**, and it covers all four demo languages — so voice
intake now works on the `GROQ_API_KEY` already configured for the
assessment layer. No new account, no new credential, no new cost.

Bhashini and Google remain in the chain as stubs. `createSttService()` is
now config-driven: a provider is only added once it actually has
credentials, so an unconfigured stub never sits in the chain failing on
every request purely to be skipped.

**The hallucination guard is the point of this adapter.** Whisper invents
fluent, plausible text when given silence or noise. Everywhere else that is
a curiosity; here the output becomes a patient's SYMPTOM DESCRIPTION and
feeds the triage engine, so an invented "chest pain" would escalate a well
patient and an invented mild complaint would bury a real one.

Two guards, both from the model's own signals, which is why the adapter
requests `verbose_json` rather than the simpler response format:
- `no_speech_prob > 0.6` → **reject outright**. Verified against the live
  API with a pure 440Hz tone: it returns `no_speech_prob 0.977` alongside a
  confidently wrong Hindi word. The **worst** segment decides, not the
  average — one hallucinated stretch in an otherwise clean recording is
  still a fabricated symptom.
- `avg_logprob` → a real confidence score. Below 0.5 the transcript is
  **returned but flagged** `needsHumanConfirmation`, so the health worker
  reads it back to the patient rather than the system either trusting it
  silently or discarding real speech.

A response with no segments is treated as untrustworthy rather than
defaulting to a reassuring confidence.

---

## D-051 — Kanpur demo data: explicitly generated, explicitly fake
Owner explicitly authorised generating Indian-origin demo data for Kanpur,
lifting the standing "never fabricate realistic-looking real-world data"
rule for this specific purpose. Everything is written with
`data_source = 'PLACEHOLDER_DEMO'` and the admin API surfaces a
`containsDemoData` flag plus a warning string.

**What is real:** the geography. Uttar Pradesh, Kanpur Nagar / Kanpur Dehat
/ Unnao, and the block names are public administrative fact.

**What is deliberately not real, and why:**
- **Every doctor is fictional.** 30 of them, 10 per district, built from
  common UP given names and surnames so the roster reads plausibly to the
  audience without naming any real practitioner. Every registration number
  is `DEMO-` prefixed so it cannot be mistaken for a real UP Medical
  Council number.
- **Every phone number is `+91-00000-xxxxx`.** Indian mobile numbers begin
  6–9, so a leading zero cannot route to any real subscriber. Generating
  plausible-looking numbers would risk a live demo dialling a stranger —
  the one failure mode of fake data that reaches outside the system.
- **Facility names** are generic or block-named; coordinates are district
  centroids, good enough to demonstrate nearest-hospital matching and
  nothing more.
- **Availability is 2/3, not all**, so load balancing has something to
  balance and "no doctor available" is also reachable on stage.

The roster is **deterministic**: re-running the seed produces the same
names, so a demo script that says "Dr Aarti Sharma will take this call"
stays true between runs.

`SEED_DEMO_PASSWORD` has **no default**. These accounts can read patient
records, and a weak shared password must not become bakeable into a public
repository by omission.

---

## D-052 — Orphaned test data found and cleaned
Verifying the seed surfaced three `E2E District …` rows and a `SMOKE-…`
district left behind by test runs that crashed before their teardown. They
were harmless but would have appeared in the admin console's district list
during a demo, which is exactly the kind of detail that undermines a
polished presentation.

Cleaned by targeting the fixtures' own naming, nothing else. Worth noting
the general lesson: fixtures that clean up in `finally` still leak when the
process is killed, so a periodic check for test-shaped rows is worth
keeping as a habit before any demo.

---

## D-053 — Referral ranking: capability and beds outrank proximity
The obvious implementation sorts hospitals by distance. That is wrong here.

`rankHospitals()` orders by **free bed → emergency capability → distance**,
deliberately in that order. The nearest hospital that cannot admit the
patient is not a destination, it is a wasted journey — and in a
time-critical transfer from a village health centre that is the costliest
possible mistake.

Hospitals with **no free beds are still returned**, ranked last and
flagged, rather than filtered out. When everything nearby is full the
assistant needs to see that and telephone ahead, not be handed an empty
list with no explanation.

A district hospital survives the capability filter even with its emergency
flag unset: it is the referral destination of last resort and must not
disappear from the list because of a missing data flag.

Search covers the whole **state**, not just the district. The nearest
capable hospital is frequently across a district line, and excluding it for
an administrative reason means nothing to a patient in an ambulance.

---

## D-054 — Two honesty constraints the referral flow is built around
**Distance is straight-line, never presented as travel distance.** Every
distance carries `distanceBasis: 'straight_line'`, the API response carries
a plain-language notice, and a `DISTANCE_IS_APPROXIMATE` warning is
attached to every referral. In rural terrain haversine and road distance
diverge sharply — a river with no nearby bridge is the ordinary case, not
the exception. Showing "12 km" to someone deciding whether to move a
critical patient, when the road is 40 km, would be actively dangerous.

**Bed counts go stale, and the record says so.** Capacity is snapshotted at
referral time along with `capacity_age_seconds` — how old the figures
already were. A referral made against a three-day-old count is a different
clinical act from one made against live data. A live join would have
silently rewritten history: "we sent you to a hospital showing 8 free beds"
must stay verifiable afterwards. Contact and location are snapshotted for
the same reason — if an admin later corrects a phone number, the slip the
patient was handed still says what it said.

Referrals against `PLACEHOLDER_DEMO` capacity emit a **critical** warning
saying so in as many words. Seeded bed counts must never be mistaken for a
live feed during a demo in front of clinicians.

**A bug this caught:** `Number(null)` is `0`, so a facility with missing
coordinates was being placed at (0,0) — off the coast of Africa — and would
have rendered "9045 km away" on a referral screen instead of an honest
"distance unknown". Fixed with an explicit nullish coordinate helper in
both `rankHospitals` and `findHospitals`.

---

## D-055 — It is a referral document, not a bill
The spec says "generate and print a bill". The table is
`referral_documents`, not `bills`, because at a government PHC or CHC the
printed slip is primarily a **referral note** — care is frequently free or
subsidised, and assuming payment is due would be wrong for the actual
setting.

The schema supports line items and a total, but **defaults to zero** and
carries `charge_source = 'PLACEHOLDER_DEMO'` with a `chargesAreProvisional`
flag on every API response. Real charge schedules are set by state health
policy; nothing here is an authoritative fee, and the UI must not present
placeholder amounts as payable.

> **NEEDS OWNER INPUT:** if the demo should show non-zero charges, supply a
> real or explicitly-fictional charge schedule. Inventing plausible medical
> fees unprompted is exactly the "realistic-looking fabricated data" the
> project rules forbid.

**Danger-zone mechanics** work as the spec describes: the HIGH-tier state
stays active while a referral exists with an unprinted document, and clears
on `POST /referrals/documents/:id/printed`. Marking printed is the ONLY
client-writable field on the document — destination, charges and snapshot
are immutable once the slip is in a patient's hand.

Verified end to end against the seeded Kanpur data with a real assistant
login: SpO2 88 / BP 86/58 / HR 132 plus crushing chest pain produced
`rule=high, model=high, final=high` on five rule hits, ranked Bilhaur CHC
first at 0.63 km with 9 free beds, issued the referral with a demo-data
warning, and the danger zone went active → cleared on print.

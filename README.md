# RuralAI

AI-assisted virtual clinic for rural health centres.

A trained Clinical Assistant captures a patient's symptoms, vitals, documents
and images; a triage layer produces a structured assessment and a LOW /
MEDIUM / HIGH tier; a remote Doctor reviews, consults over video, and holds
final medical authority.

Originally built in 36 hours at BOB HACKS'26 (CSJMU) under Problem Statement 3
and now being rebuilt as a production system.

> **Not for clinical use.** Triage thresholds are derived from published
> sources (NEWS2, WHO IMCI, PALS) but have **not** been validated or signed
> off by a physician for this deployment. The OTC formulary is unimplemented
> and unsigned. See [`docs/DECISIONS.md`](docs/DECISIONS.md).

---

## The rule the system is built around

**Nothing probabilistic makes a safety-critical decision alone.** Models
generate hypotheses, deterministic rules set floors and gates, humans decide.

Concretely:

- `final_tier = max(rule_tier, model_tier)` — red-flag rules can only ever
  *raise* a tier. Nothing lowers one.
- Degraded or failed AI falls back to MEDIUM (doctor contact), never LOW.
- Missing data is not normal data — absent vitals raise the tier.
- Medicine is never model-authored; it comes from a clinician-signed
  formulary via a rules engine.
- AI output and doctor decisions are separate records, never one row with a
  status flag.

---

## Stack

| Layer | Choice |
|---|---|
| Data / auth / storage / realtime | Supabase (Postgres 17, GoTrue, Storage) |
| Access control | **Postgres row-level security** — the primary control |
| API | Node 20+, Express 5, ESM JavaScript |
| Validation | Zod on every input route |
| Tests | Jest + Supertest, incl. real RLS policy tests |

Full rationale: [`docs/PHASE1_ARCHITECTURE_PLAN.md`](docs/PHASE1_ARCHITECTURE_PLAN.md).
Every deviation from the original brief: [`docs/DECISIONS.md`](docs/DECISIONS.md).

---

## Quick start

```bash
npm install
cp .env.example .env      # fill in Supabase URL + keys + DATABASE_URL
npm run db:check          # verify connectivity
npm run db:migrate        # apply schema
npm run dev               # http://localhost:4000
npm test
```

Full setup, **including two Supabase dashboard toggles that silently break
authorisation if skipped**: [`docs/SETUP.md`](docs/SETUP.md).

---

## Build status

| Phase | State |
|---|---|
| 0 — Scaffold, config, health checks | done |
| 1 — Auth, RBAC, RLS, audit log | done |
| 2 — Patient records, RHID, visits | done |
| 3 — Attachments, storage, symptom entry | done (voice pending credentials) |
| 4 — AI assessment + triage | rules layer in progress; LLM layer blocked on credentials |
| 5–10 | not started |

**Known red test:** `tests/live-auth-path.test.js` fails until the Supabase
custom access token hook is enabled. It is a configuration canary, not a code
defect — and it is the only test that catches a misconfiguration which would
otherwise leave a valid login able to read nothing.

---

## Security notes

- **The Supabase service-role key bypasses all RLS.** Clients read through
  `supabaseAsUser(jwt)`; `supabaseAdmin` is for trusted server-side writes
  only, each with an explicit authorisation check and an audit-log row.
- **No government ID data is stored.** Patients are keyed by a system-issued
  12-digit health ID with a Verhoeff check digit.
- **No PHI in logs** — including filenames. Storage paths are opaque by
  construction.
- **Storage buckets are private.** Access is via short-TTL signed URLs only.
- **Uploads are validated by magic bytes**, never by extension or
  `Content-Type`.
- **Clinical records and audit entries are never deleted.** Accounts are
  deactivated, not removed, so the audit trail keeps its attribution.

Never commit `.env`. If a key is ever exposed, rotate it in the Supabase
dashboard immediately.

---

## Licence

Not yet determined.

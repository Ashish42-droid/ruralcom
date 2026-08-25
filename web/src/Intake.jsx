/**
 * Patient intake wizard and the tiered result.
 *
 * Section 3.7 of the brief: every intake type accepts single AND multiple
 * files, from the file manager OR the camera. The staging queue below
 * accumulates across pickers, so a health worker can photograph a
 * prescription, add a lab report from storage, then a wound image, and
 * send the lot in one call.
 */
import { useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

import { api } from './api.js';
import {
  Card, Button, Banner, Tier, Steps, IconFolder, IconCamera, IconX, IconActivity, IconAlert,
} from './components/ui.jsx';
import { fadeUp, popIn } from './components/motion.js';

const STEPS = ['Patient', 'Vitals', 'Symptoms', 'Documents', 'Assess'];

const DOC_TYPES = [
  ['prescription', 'Prescription'],
  ['lab_report', 'Lab report'],
  ['wound_image', 'Wound image'],
];

const SCENARIOS = {
  high: {
    name: 'Demo Patient', age: 54, sex: 'male', complaint: 'chest pain',
    v: { temperatureC: 36.9, spo2: 88, systolic: 86, diastolic: 58, pulseBpm: 132 },
    s: 'crushing chest pain radiating to the left arm, cannot breathe, cold and clammy',
  },
  low: {
    name: 'Demo Patient', age: 28, sex: 'female', complaint: 'fever',
    v: { temperatureC: 37.6, spo2: 98, systolic: 118, diastolic: 76, pulseBpm: 82, weightKg: 54 },
    s: 'fever for two days with body ache, and a small clean cut on the hand',
  },
};

export default function Intake({ onDanger }) {
  const [step, setStep] = useState(0);
  const [patient, setPatient] = useState(null);
  const [visitId, setVisitId] = useState(null);
  const [form, setForm] = useState({ ...SCENARIOS.high, ...SCENARIOS.high.v });
  const [assessment, setAssessment] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [docType, setDocType] = useState('prescription');
  const [queue, setQueue] = useState([]);
  const [uploadNote, setUploadNote] = useState(null);

  const fileRef = useRef();
  const camRef = useRef();

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  function loadScenario(kind) {
    const s = SCENARIOS[kind];
    setForm({ ...s, ...s.v });
  }

  async function run(label, fn) {
    setBusy(label); setError('');
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(''); }
  }

  const register = () => run('register', async () => {
    const p = await api('/patients', {
      method: 'POST',
      body: {
        fullName: form.name, ageYears: Number(form.age),
        sex: form.sex, preferredLanguage: 'hi',
      },
    });
    const v = await api(`/patients/${p.id}/visits`, {
      method: 'POST', body: { chiefComplaint: form.complaint },
    });
    setPatient(p); setVisitId(v.id); setStep(1);
  });

  const saveVitals = () => run('vitals', async () => {
    const body = {};
    for (const k of ['temperatureC', 'spo2', 'systolic', 'diastolic', 'pulseBpm', 'weightKg']) {
      if (form[k] !== '' && form[k] != null) body[k] = Number(form[k]);
    }
    await api(`/clinical/visits/${visitId}/vitals`, { method: 'POST', body });
    setStep(2);
  });

  const saveSymptoms = () => run('symptoms', async () => {
    await api(`/intake/visits/${visitId}/symptoms`, {
      method: 'POST', body: { rawText: form.s, language: 'en' },
    });
    setStep(3);
  });

  function addFiles(list) {
    // Append rather than replace — the queue is meant to accumulate across
    // several pickers before one batched upload.
    setQueue((q) => [...q, ...Array.from(list)]);
  }

  const upload = () => run('upload', async () => {
    const fd = new FormData();
    queue.forEach((f) => fd.append('files', f));
    fd.append('type', docType);
    fd.append('captureSource', 'camera');

    const res = await api(`/intake/visits/${visitId}/attachments`, { method: 'POST', form: fd });
    setQueue([]);

    if (docType === 'wound_image') {
      setUploadNote({ kind: 'info', text: `${res.uploaded.length} image(s) stored. Wound images are assessed visually — no OCR is run on them.` });
      setStep(4);
      return;
    }

    setBusy('ocr');
    let done = 0;
    for (let i = 0; i < 30; i += 1) {
      await new Promise((r) => setTimeout(r, 2000));
      const list = await api(`/intake/visits/${visitId}/attachments`);
      done = list.filter((a) => a.ocrStatus === 'done').length;
      if (list.every((a) => a.ocrStatus !== 'pending')) break;
    }
    setUploadNote({
      kind: done ? 'info' : 'warn',
      text: done
        ? `OCR finished on ${done} document(s). Every result is flagged for human review — OCR never fills a clinical field on its own.`
        : 'OCR did not complete. The documents are stored; values were not extracted.',
    });
    setStep(4);
  });

  const assess = () => run('assess', async () => {
    const a = await api(`/clinical/visits/${visitId}/assess`, { method: 'POST' });
    setAssessment(a);
    onDanger(a.finalTier === 'high');
  });

  return (
    <div>
      <Steps steps={STEPS} current={step} />

      {error && <div style={{ marginBottom: 'var(--sp-3)' }}><Banner kind="err">{error}</Banner></div>}

      <div className="grid two">
        <div>
          {/* ── 1 · Patient ── */}
          <Card title="1 · Register patient"
                sub="Issues a 12-digit RuralAI Health ID. No government identity data is stored.">
            <div className="row">
              <div style={{ flex: '2 1 160px' }}>
                <label htmlFor="nm">Full name</label>
                <input id="nm" value={form.name} onChange={(e) => set('name', e.target.value)} />
              </div>
              <div style={{ flex: '1 1 84px' }}>
                <label htmlFor="ag">Age</label>
                <input id="ag" type="number" value={form.age} onChange={(e) => set('age', e.target.value)} />
              </div>
              <div style={{ flex: '1 1 110px' }}>
                <label htmlFor="sx">Sex</label>
                <select id="sx" value={form.sex} onChange={(e) => set('sex', e.target.value)}>
                  <option value="female">Female</option>
                  <option value="male">Male</option>
                  <option value="undisclosed">Undisclosed</option>
                </select>
              </div>
            </div>

            <label htmlFor="cc" style={{ marginTop: 'var(--sp-2)' }}>Chief complaint</label>
            <input id="cc" value={form.complaint} onChange={(e) => set('complaint', e.target.value)} />

            <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
              <Button onClick={register} loading={busy === 'register'} disabled={!!patient}>
                {patient ? 'Registered' : 'Register & open visit'}
              </Button>
              <button className="btn ghost" onClick={() => loadScenario('high')} disabled={!!patient}>HIGH scenario</button>
              <button className="btn ghost" onClick={() => loadScenario('low')} disabled={!!patient}>LOW scenario</button>
            </div>

            <AnimatePresence>
              {patient && (
                <motion.div variants={popIn} initial="hidden" animate="show" exit={{ opacity: 0 }}
                            style={{ marginTop: 'var(--sp-3)' }}>
                  <div className="kv"><span>Health ID</span><span className="mono">{patient.rhidFormatted}</span></div>
                  <div className="kv"><span>Visit</span><span className="mono">{visitId?.slice(0, 8)}…</span></div>
                </motion.div>
              )}
            </AnimatePresence>
          </Card>

          {/* ── 2 · Vitals ── */}
          <Card title="2 · Vitals"
                sub="A partial set is normal — missing vitals raise the tier rather than being read as normal.">
            <div className="grid auto">
              {[
                ['temperatureC', 'Temp °C', '0.1'],
                ['spo2', 'SpO₂ %', '1'],
                ['systolic', 'Systolic', '1'],
                ['diastolic', 'Diastolic', '1'],
                ['pulseBpm', 'Pulse', '1'],
                ['weightKg', 'Weight kg', '0.1'],
              ].map(([k, lbl, st]) => (
                <div key={k}>
                  <label htmlFor={k}>{lbl}</label>
                  <input id={k} type="number" step={st} value={form[k] ?? ''}
                         onChange={(e) => set(k, e.target.value)} />
                </div>
              ))}
            </div>
            <p className="muted small" style={{ marginTop: 10 }}>
              Weight is required before any paediatric dose can be calculated.
            </p>
            <Button className="btn" onClick={saveVitals} loading={busy === 'vitals'}
                    disabled={!visitId} style={{ marginTop: 'var(--sp-3)' }}>
              Record vitals
            </Button>
          </Card>

          {/* ── 3 · Symptoms ── */}
          <Card title="3 · Symptoms" sub="The original text is always kept, whatever language it was given in.">
            <label htmlFor="sy">What the patient describes</label>
            <textarea id="sy" value={form.s} onChange={(e) => set('s', e.target.value)} />
            <Button onClick={saveSymptoms} loading={busy === 'symptoms'} disabled={!visitId}
                    style={{ marginTop: 'var(--sp-3)' }}>
              Record symptoms
            </Button>
          </Card>

          {/* ── 4 · Documents ── */}
          <Card title="4 · Documents & images"
                sub="Prescriptions, lab reports and wound photos. Several at a time, from storage or the camera.">
            <div className="row" role="tablist" aria-label="Document type">
              {DOC_TYPES.map(([v, lbl]) => (
                <button key={v} role="tab" aria-selected={docType === v}
                        className={`btn ghost${docType === v ? '' : ''}`}
                        onClick={() => setDocType(v)}
                        style={docType === v
                          ? { borderColor: 'var(--accent)', background: 'var(--panel-2)', color: 'var(--text)' }
                          : { color: 'var(--muted)' }}>
                  {lbl}
                </button>
              ))}
            </div>

            <div className="row" style={{ marginTop: 'var(--sp-2)' }}>
              <button className="btn ghost" onClick={() => fileRef.current.click()} disabled={!visitId}>
                <IconFolder size={18} /> Choose files
              </button>
              <button className="btn ghost" onClick={() => camRef.current.click()} disabled={!visitId}>
                <IconCamera size={18} /> Camera
              </button>
            </div>

            <input ref={fileRef} type="file" multiple hidden
                   accept="image/*,application/pdf"
                   onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
            {/* capture="environment" is what actually opens the rear camera
                on Android and iOS. The picker above deliberately omits it. */}
            <input ref={camRef} type="file" multiple hidden
                   accept="image/*" capture="environment"
                   onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />

            <AnimatePresence>
              {queue.map((f, i) => (
                <motion.div key={`${f.name}-${i}`} layout
                            variants={fadeUp} initial="hidden" animate="show" exit="exit"
                            style={{
                              display: 'flex', gap: 10, alignItems: 'center',
                              background: 'var(--panel-2)', border: '1px solid var(--line)',
                              borderRadius: 10, padding: '10px 12px', marginTop: 8, fontSize: 13.5,
                            }}>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {f.name}
                  </span>
                  <span className="muted mono">{(f.size / 1024).toFixed(0)} KB</span>
                  <button aria-label={`Remove ${f.name}`}
                          onClick={() => setQueue((q) => q.filter((_, j) => j !== i))}
                          style={{ background: 'none', border: 0, color: 'var(--muted)', cursor: 'pointer', padding: 6 }}>
                    <IconX size={16} />
                  </button>
                </motion.div>
              ))}
            </AnimatePresence>

            <Button onClick={upload} loading={busy === 'upload' || busy === 'ocr'}
                    disabled={!queue.length} style={{ marginTop: 'var(--sp-3)' }}>
              {busy === 'ocr' ? 'Running OCR…'
                : queue.length ? `Upload ${queue.length} file${queue.length > 1 ? 's' : ''}`
                : 'Upload'}
            </Button>

            {uploadNote && (
              <div style={{ marginTop: 'var(--sp-3)' }}>
                <Banner kind={uploadNote.kind}>{uploadNote.text}</Banner>
              </div>
            )}

            <button className="btn ghost block" style={{ marginTop: 'var(--sp-2)' }}
                    onClick={() => setStep(4)} disabled={!visitId}>
              Skip — no documents
            </button>
          </Card>
        </div>

        {/* ── Right column ── */}
        <div>
          <Card title="5 · AI assessment"
                sub="Deterministic rules set the floor. The model may raise the tier; it can never lower it.">
            <Button onClick={assess} loading={busy === 'assess'} disabled={!visitId} className="btn block"
                    icon={IconActivity}>
              Run AI assessment
            </Button>

            <AnimatePresence>
              {assessment && <Result key="r" a={assessment} />}
            </AnimatePresence>
          </Card>

          <AnimatePresence>
            {assessment?.carePlan && <CarePlan key="cp" cp={assessment.carePlan} />}
          </AnimatePresence>

          <AnimatePresence>
            {assessment?.finalTier === 'high' && (
              <Referral key="ref" visitId={visitId} onCleared={() => onDanger(false)} />
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

/* ── Assessment result ────────────────────────────────────────────── */
function Result({ a }) {
  return (
    <motion.div variants={fadeUp} initial="hidden" animate="show" exit="exit"
                style={{ marginTop: 'var(--sp-3)' }}>
      <div className="row" style={{ alignItems: 'center', gap: 14 }}>
        <Tier tier={a.finalTier} size="lg" />
        <span className="muted mono">{a.latencyMs}ms</span>
      </div>

      <div style={{ marginTop: 'var(--sp-3)' }}>
        <div className="kv"><span>Rule floor</span><span className="mono">{a.ruleTier}</span></div>
        <div className="kv"><span>Model tier</span><span className="mono">{a.modelTier ?? '—'}</span></div>
        <div className="kv"><span>Final</span><span className="mono">MAX = {a.finalTier}</span></div>
      </div>

      {a.modelAttemptedDeEscalation && (
        <div style={{ marginTop: 'var(--sp-2)' }}>
          <Banner kind="err">
            The model proposed a <b>lower</b> tier than the rules allow. The rule floor was applied.
          </Banner>
        </div>
      )}

      {a.ruleHits?.length > 0 && (
        <>
          <h4 className="muted small" style={{ marginTop: 'var(--sp-3)', textTransform: 'uppercase', letterSpacing: '.6px' }}>
            Rules that fired
          </h4>
          <div className="row" style={{ gap: 6, marginTop: 8 }}>
            {a.ruleHits.map((h) => (
              <span key={h.code} className="mono"
                    style={{
                      background: 'var(--panel-2)', border: '1px solid var(--line)',
                      borderRadius: 7, padding: '4px 9px', fontSize: 12,
                    }}>
                {h.code}
              </span>
            ))}
          </div>
        </>
      )}

      {a.differential?.length > 0 && (
        <>
          <h4 className="muted small" style={{ marginTop: 'var(--sp-3)', textTransform: 'uppercase', letterSpacing: '.6px' }}>
            Differential
          </h4>
          {a.differential.slice(0, 4).map((d) => (
            <div className="kv" key={d.condition}>
              <span>{d.condition}</span>
              <span>{Math.round(d.confidence * 100)}%</span>
            </div>
          ))}
        </>
      )}

      {a.reasoning && <p className="muted small" style={{ marginTop: 'var(--sp-2)' }}>{a.reasoning}</p>}
    </motion.div>
  );
}

/* ── Care plan ────────────────────────────────────────────────────── */
function CarePlan({ cp }) {
  return (
    <Card title="Care plan" sub="Deterministic protocols. Medication is a suggestion pending doctor review, never an instruction.">
      <h4 className="muted small" style={{ textTransform: 'uppercase', letterSpacing: '.6px' }}>
        First aid — {cp.firstAid.title}
      </h4>
      <ol style={{ paddingLeft: 20, marginTop: 8 }}>
        {cp.firstAid.steps.map((s) => <li key={s} style={{ marginBottom: 7 }}>{s}</li>)}
      </ol>

      <h4 className="muted small" style={{ marginTop: 'var(--sp-3)', textTransform: 'uppercase', letterSpacing: '.6px' }}>
        Medication {cp.tier !== 'low' && '(not applicable at this tier)'}
      </h4>
      {cp.medications.length === 0 && (
        <p className="muted small" style={{ marginTop: 6 }}>No medication is suggested for this tier.</p>
      )}
      {cp.medications.map((m) => (
        <div key={m.ruleSourceId}
             style={{
               background: 'var(--panel-2)', border: '1px solid var(--line)',
               borderLeft: '3px solid var(--medium)', borderRadius: 10,
               padding: '12px 14px', marginTop: 9,
             }}>
          <b>{m.drug}</b>
          <div className="mono" style={{ color: 'var(--accent)', margin: '5px 0' }}>
            {m.dose} · {m.frequency}{m.maxDaily ? ` · max ${m.maxDaily}` : ''}
          </div>
          <p className="muted small"><IconAlert size={14} /> {m.warning}</p>
          <p className="muted small">Source: {m.source} · up to {m.maxDurationDays} days · pending doctor review</p>
        </div>
      ))}

      {cp.suppressedMedications?.length > 0 && (
        <>
          <h4 className="muted small" style={{ marginTop: 'var(--sp-3)', textTransform: 'uppercase', letterSpacing: '.6px' }}>
            Withheld by safety gates
          </h4>
          {cp.suppressedMedications.map((s) => (
            <div key={s.ruleSourceId} className="banner err" style={{ marginTop: 8 }}>
              <div><b>{s.drug}</b> — {s.reasons.join('; ')}</div>
            </div>
          ))}
        </>
      )}

      <h4 className="muted small" style={{ marginTop: 'var(--sp-3)', textTransform: 'uppercase', letterSpacing: '.6px' }}>
        Precautions
      </h4>
      <ul style={{ paddingLeft: 20, marginTop: 8 }}>
        {cp.precautions.map((p) => <li key={p} style={{ marginBottom: 7 }}>{p}</li>)}
      </ul>

      {cp.diet.length > 0 && (
        <>
          <h4 className="muted small" style={{ marginTop: 'var(--sp-3)', textTransform: 'uppercase', letterSpacing: '.6px' }}>
            Diet
          </h4>
          <ul style={{ paddingLeft: 20, marginTop: 8 }}>
            {cp.diet.map((d) => <li key={d} style={{ marginBottom: 7 }}>{d}</li>)}
          </ul>
        </>
      )}

      <div className="banner info" style={{ marginTop: 'var(--sp-3)' }}>
        <div><b>{cp.nextStep.label}</b><br /><span className="small">{cp.nextStep.detail}</span></div>
      </div>

      <p className="muted small" style={{ marginTop: 'var(--sp-2)' }}>{cp.disclaimer}</p>
    </Card>
  );
}

/* ── HIGH-tier referral ───────────────────────────────────────────── */
function Referral({ visitId, onCleared }) {
  const [hospitals, setHospitals] = useState(null);
  const [issued, setIssued] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  async function load() {
    setBusy('load');
    try { setHospitals(await api(`/referrals/visits/${visitId}/hospitals`)); }
    catch (e) { setErr(e.message); } finally { setBusy(''); }
  }
  if (!hospitals && !busy && !err) load();

  async function issue() {
    setBusy('issue');
    try {
      setIssued(await api(`/referrals/visits/${visitId}`, {
        method: 'POST',
        body: { reason: 'HIGH-tier assessment — urgent transfer required' },
      }));
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  }

  async function markPrinted() {
    setBusy('print');
    try {
      await api(`/referrals/documents/${issued.document.id}/printed`, { method: 'POST' });
      setIssued((s) => ({ ...s, printed: true }));
      onCleared();
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  }

  return (
    <Card title="Urgent referral" sub="Ranked by free beds, then emergency capability, then distance.">
      {err && <Banner kind="err">{err}</Banner>}

      {!issued && hospitals && (
        <>
          <Banner kind="warn">
            The nearest hospital that cannot admit is a wasted journey, so bed
            availability outranks proximity here.
          </Banner>
          <div className="scroll" style={{ marginTop: 'var(--sp-2)' }}>
            <table>
              <thead><tr><th>Hospital</th><th>Distance</th><th>Beds</th></tr></thead>
              <tbody>
                {hospitals.hospitals.slice(0, 4).map((h) => (
                  <tr key={h.facilityId}>
                    <td>{h.name}<br /><span className="muted small">{h.type.replace(/_/g, ' ')}</span></td>
                    <td className="mono">{h.distanceKm ?? '—'} km</td>
                    <td className="mono" style={{ color: h.availableBeds > 0 ? 'var(--low)' : 'var(--high)' }}>
                      {h.availableBeds}/{h.totalBeds}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small" style={{ marginTop: 10 }}>{hospitals.notice}</p>
          <Button className="btn danger block" onClick={issue} loading={busy === 'issue'}
                  style={{ marginTop: 'var(--sp-3)' }}>
            Issue referral & generate slip
          </Button>
        </>
      )}

      {issued && (
        <motion.div variants={fadeUp} initial="hidden" animate="show">
          <div className="kv"><span>Destination</span><span>{issued.referral.contactSnapshot.name}</span></div>
          <div className="kv"><span>Contact</span><span className="mono">{issued.referral.contactSnapshot.contact}</span></div>
          <div className="kv"><span>Distance</span><span className="mono">{issued.referral.distanceKm} km (straight line)</span></div>
          <div className="kv"><span>Beds at issue</span>
            <span className="mono">{issued.referral.capacitySnapshot.availableBeds}/{issued.referral.capacitySnapshot.totalBeds}</span></div>
          <div className="kv"><span>Document</span><span className="mono">{issued.document.documentNumber}</span></div>

          {issued.warnings.map((w) => (
            <div key={w.code} style={{ marginTop: 8 }}>
              <Banner kind={w.severity === 'critical' ? 'err' : w.severity === 'warning' ? 'warn' : 'info'}>
                <b>{w.code}</b> — {w.message}
              </Banner>
            </div>
          ))}

          {!issued.printed ? (
            <Button className="btn block" onClick={markPrinted} loading={busy === 'print'}
                    style={{ marginTop: 'var(--sp-3)' }}>
              Mark printed — clears danger zone
            </Button>
          ) : (
            <div style={{ marginTop: 'var(--sp-3)' }}>
              <Banner kind="info">Slip printed. Danger-zone state cleared.</Banner>
            </div>
          )}
        </motion.div>
      )}
    </Card>
  );
}

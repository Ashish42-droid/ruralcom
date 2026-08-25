/**
 * Doctor portal — the LOW-tier review queue and the flag-back loop.
 *
 * The flag-back is the point of this screen: without it a doctor's
 * disagreement is recorded and forgotten. With it, the correction reaches
 * the person actually treating the patient, and they must acknowledge it
 * before the case can close.
 */
import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

import { api } from './api.js';
import {
  Card, Button, Banner, Tier, IconCheck, IconAlert,
} from './components/ui.jsx';
import { fadeUp } from './components/motion.js';

export default function Doctor() {
  const [queue, setQueue] = useState([]);
  const [calls, setCalls] = useState([]);
  const [selected, setSelected] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('load');
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState('');

  async function load({ initial = false } = {}) {
    // On mount, busy already starts as 'load' — setting it again here is
    // what makes React warn about a cascading render.
    if (!initial) {
      setBusy('load');
      setErr('');
    }
    try {
      const [q, c] = await Promise.all([
        api('/consultations/reviews/pending'),
        api('/consultations/queue'),
      ]);
      setQueue(q);
      setCalls(c);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  }

  // Fetching on mount is exactly what an effect is for — synchronising with
  // an external system. The `initial` flag skips the only synchronous
  // setState in `load`, so nothing here triggers a cascading render; the
  // rule cannot see through the function call to verify that.
  // eslint-disable-next-line react/set-state-in-effect
  useEffect(() => { load({ initial: true }); }, []);

  async function submit(action) {
    setBusy(action);
    setMsg(null);
    setErr('');
    try {
      await api(`/consultations/assessments/${selected.assessmentId}/review`, {
        method: 'POST',
        body: { action, clinicalNote: note || undefined },
      });
      setMsg({
        kind: 'info',
        text: action === 'flag_to_assistant'
          ? 'Flagged back. The assistant must acknowledge it before the case can close.'
          : 'Approved. The case is closed.',
      });
      setSelected(null);
      setNote('');
      load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="grid two">
      <Card title="Review queue" sub="LOW-tier assessments awaiting your decision.">
        {err && <Banner kind="err">{err}</Banner>}
        <Button className="btn ghost" onClick={load} loading={busy === 'load'}>Refresh</Button>

        <div style={{ marginTop: 'var(--sp-3)' }}>
          <AnimatePresence>
            {queue.length === 0 && !busy && (
              <p className="muted small">The queue is empty.</p>
            )}
            {queue.map((c) => (
              <motion.button
                key={c.assessmentId}
                layout
                variants={fadeUp}
                initial="hidden"
                animate="show"
                exit="exit"
                onClick={() => setSelected(c)}
                aria-pressed={selected?.assessmentId === c.assessmentId}
                style={{
                  width: '100%', textAlign: 'left', cursor: 'pointer',
                  display: 'flex', gap: 12, alignItems: 'center', marginBottom: 9,
                  background: 'var(--panel-2)',
                  border: `1px solid ${selected?.assessmentId === c.assessmentId ? 'var(--accent)' : 'var(--line)'}`,
                  borderRadius: 12, padding: '13px 15px', minHeight: 'var(--touch)',
                  color: 'inherit',
                }}
              >
                <Tier tier="low" />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <b style={{ display: 'block' }}>{c.patient?.fullName ?? 'Patient'}</b>
                  <span className="muted small">
                    {c.patient?.ageYears ?? '?'}y · {c.differential?.[0]?.condition ?? 'no differential'}
                  </span>
                </span>
              </motion.button>
            ))}
          </AnimatePresence>
        </div>
      </Card>

      <div>
        <Card
          title="Decision"
          sub="Approving closes the case. Flagging sends it back with a note — required, and enforced by the database."
        >
          {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}

          {!selected ? (
            <p className="muted small">Select a case from the queue.</p>
          ) : (
            <motion.div variants={fadeUp} initial="hidden" animate="show">
              <div className="kv">
                <span>Patient</span><span>{selected.patient?.fullName ?? '—'}</span>
              </div>
              <div className="kv">
                <span>Top differential</span>
                <span>{selected.differential?.[0]?.condition ?? '—'}</span>
              </div>
              {selected.reasoning && (
                <p className="muted small" style={{ margin: 'var(--sp-2) 0' }}>{selected.reasoning}</p>
              )}

              <label htmlFor="note" style={{ marginTop: 'var(--sp-2)' }}>
                Clinical note <span className="muted">(required to flag back)</span>
              </label>
              <textarea
                id="note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. Re-check the blood pressure — the readings look transposed."
              />

              <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
                <Button onClick={() => submit('approve')} loading={busy === 'approve'} icon={IconCheck}>
                  Approve
                </Button>
                <Button
                  className="btn ghost"
                  onClick={() => submit('flag_to_assistant')}
                  loading={busy === 'flag_to_assistant'}
                  icon={IconAlert}
                >
                  Flag back to assistant
                </Button>
              </div>
            </motion.div>
          )}
        </Card>

        <Card title="Consultation queue" sub="MEDIUM-tier calls assigned to you, with their tolerance window.">
          {calls.length === 0 ? (
            <p className="muted small">No calls assigned.</p>
          ) : (
            calls.map((c) => (
              <div className="kv" key={c.id}>
                <span>{c.status}</span>
                <span className="mono">
                  expires {new Date(c.toleranceExpiresAt).toLocaleTimeString()}
                </span>
              </div>
            ))
          )}
        </Card>
      </div>
    </div>
  );
}

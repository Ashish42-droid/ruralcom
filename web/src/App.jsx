import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

import Landing from './Landing.jsx';
import Intake from './Intake.jsx';
import Doctor from './Doctor.jsx';
import { signOut, onActivity } from './api.js';
import {
  IconActivity, IconStethoscope, IconUser,
} from './components/ui.jsx';
import { fadeUp } from './components/motion.js';

export default function App() {
  const [user, setUser] = useState(null);
  const [tab, setTab] = useState(null);
  const [danger, setDanger] = useState(false);
  const [log, setLog] = useState([]);

  useEffect(
    () => onActivity((e) => {
      setLog((l) => [{ ...e, at: new Date().toLocaleTimeString() }, ...l].slice(0, 40));
    }),
    [],
  );

  // The HIGH-tier danger state recolours the whole document rather than one
  // panel — it has to be unmissable from across a room.
  useEffect(() => {
    document.body.classList.toggle('danger', danger);
  }, [danger]);

  if (!user) return <Landing onSignedIn={setUser} />;

  const isAssistant = user.role === 'clinical_assistant';

  // Derived, not synced from an effect: the default follows from the role,
  // and an explicit choice overrides it.
  const activeTab = tab ?? (isAssistant ? 'intake' : 'doctor');

  const tabs = [
    ['intake', 'Patient intake', IconUser, isAssistant],
    ['doctor', 'Doctor portal', IconStethoscope, true],
    ['activity', 'Activity', IconActivity, true],
  ].filter(([, , , show]) => show);

  return (
    <div>
      <AnimatePresence>
        {danger && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            role="alert"
            style={{
              background: 'linear-gradient(90deg,#b3122b,#7d0d1e)',
              padding: '14px 20px',
              fontWeight: 700,
              letterSpacing: '0.5px',
              textAlign: 'center',
            }}
          >
            HIGH RISK — REFERRAL REQUIRED
          </motion.div>
        )}
      </AnimatePresence>

      <header
        style={{
          display: 'flex', alignItems: 'center', gap: 14, padding: '14px 20px',
          borderBottom: '1px solid var(--line)', background: 'var(--bg-2)',
          position: 'sticky', top: 0, zIndex: 20,
        }}
      >
        <div
          aria-hidden="true"
          style={{
            width: 36, height: 36, borderRadius: 10, display: 'grid', placeItems: 'center',
            background: 'linear-gradient(135deg,var(--accent),#34d399)',
            color: '#04141c', fontWeight: 700,
          }}
        >
          R
        </div>
        <div>
          <b>RuralAI</b>
          <div className="muted" style={{ fontSize: 12 }}>Virtual Village Clinic</div>
        </div>

        <div style={{ flex: 1 }} />

        <span className="tier low" style={{ fontSize: 12, padding: '6px 12px' }}>
          <span className="dot" />
          {user.role.replace(/_/g, ' ')}
        </span>
        <button
          className="btn ghost"
          style={{ minHeight: 44 }}
          onClick={() => { signOut(); setUser(null); setDanger(false); }}
        >
          Sign out
        </button>
      </header>

      <div className="wrap">
        <div className="row" role="tablist" style={{ marginBottom: 'var(--sp-3)' }}>
          {tabs.map(([id, label, Icon]) => (
            <button
              key={id}
              role="tab"
              aria-selected={activeTab === id}
              onClick={() => setTab(id)}
              className={`btn ${activeTab === id ? '' : 'ghost'}`}
            >
              <Icon size={18} /> {label}
            </button>
          ))}
        </div>

        <AnimatePresence mode="wait">
          <motion.div key={activeTab} variants={fadeUp} initial="hidden" animate="show" exit="exit">
            {activeTab === 'intake' && isAssistant && <Intake onDanger={setDanger} />}
            {activeTab === 'doctor' && <Doctor />}
            {activeTab === 'activity' && (
              <div className="card">
                <h3 className="card-title">API activity</h3>
                <p className="card-sub">Every call this session has made.</p>
                <div className="scroll" style={{ maxHeight: 420 }}>
                  {log.length === 0 && <p className="muted small">Nothing yet.</p>}
                  {log.map((e, i) => (
                    <div className="kv" key={i}>
                      <span className="mono">{e.at} {e.method} {e.path}</span>
                      <span
                        className="mono"
                        style={{ color: e.ok ? 'var(--low)' : 'var(--high)' }}
                      >
                        {e.status} · {e.ms}ms
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

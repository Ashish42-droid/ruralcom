/**
 * Landing page + sign-in.
 *
 * The 3D scene is lazy-loaded behind Suspense so three.js never blocks
 * first paint — on a rural connection that difference is the whole
 * experience, not a micro-optimisation.
 */
import { Suspense, lazy, useState } from 'react';
import { motion } from 'framer-motion';

import { signIn } from './api.js';
import {
  Reveal, Card, Button, Banner, IconStethoscope, IconUser, IconShield, IconArrow,
} from './components/ui.jsx';
import { stagger, fadeUp } from './components/motion.js';

const Hero3D = lazy(() => import('./components/Hero3D.jsx'));

const CAPABILITIES = [
  ['Patient identity', '12-digit health ID with a Verhoeff check digit. No government ID data is stored.'],
  ['Multimodal intake', 'Vitals, typed or spoken symptoms, prescriptions, lab reports and wound photos.'],
  ['Document OCR', 'Runs locally. ~93% confidence on printed lab reports, always flagged for human review.'],
  ['Deterministic triage', 'final tier = MAX(rules, model). The model can raise a tier, never lower one.'],
  ['Care plan', 'First aid, precautions and diet for every tier; medication only at LOW, pending doctor review.'],
  ['Urgent referral', 'Nearest capable hospital ranked by free beds before distance, with a printable slip.'],
];

export default function Landing({ onSignedIn }) {
  const [email, setEmail] = useState('demo.assistant.1@ruralai-demo.invalid');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e?.preventDefault();
    setBusy(true);
    setError('');
    try {
      onSignedIn(await signIn(email, password));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {/* ── Hero ── */}
      <section
        style={{
          position: 'relative', minHeight: '58vh', display: 'grid',
          placeItems: 'center', overflow: 'hidden',
          borderBottom: '1px solid var(--line)',
        }}
      >
        <Suspense fallback={null}>
          <Hero3D />
        </Suspense>

        {/* Darkening scrim so hero text keeps 4.5:1 over a moving scene. */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute', inset: 0,
            background:
              'linear-gradient(180deg, rgba(10,17,32,.55) 0%, rgba(10,17,32,.78) 62%, var(--bg) 100%)',
          }}
        />

        <motion.div
          className="wrap"
          style={{ position: 'relative', textAlign: 'center', padding: 'var(--sp-6) var(--sp-3)' }}
          variants={stagger}
          initial="hidden"
          animate="show"
        >
          <motion.div variants={fadeUp}>
            <span className="tier low" style={{ marginBottom: 'var(--sp-3)' }}>
              <span className="dot" /> BOB HACKS&apos;26 · 1st Prize
            </span>
          </motion.div>

          <motion.h1
            variants={fadeUp}
            style={{ fontSize: 'clamp(30px, 6vw, 58px)', marginTop: 'var(--sp-3)' }}
          >
            A doctor&apos;s reach,<br />
            <span style={{ color: 'var(--accent)' }}>kilometres from the nearest one.</span>
          </motion.h1>

          <motion.p
            variants={fadeUp}
            className="muted"
            style={{ maxWidth: 620, margin: 'var(--sp-3) auto 0', fontSize: 17 }}
          >
            RuralAI helps a trained health worker assess a patient, act immediately,
            and reach a remote doctor when it matters — under protocols that never
            let the AI decide alone.
          </motion.p>

          <motion.div variants={fadeUp} className="row" style={{ justifyContent: 'center', marginTop: 'var(--sp-4)' }}>
            <a href="#signin" className="btn" style={{ textDecoration: 'none' }}>
              <IconArrow size={18} /> Enter the clinic
            </a>
          </motion.div>
        </motion.div>
      </section>

      <div className="wrap" style={{ paddingTop: 'var(--sp-5)', paddingBottom: 'var(--sp-6)' }}>
        <Reveal>
          <Banner kind="warn">
            <b>Demonstration build.</b> Every patient, doctor and facility record is
            fictional and marked as such. Triage thresholds and dosing come from
            published sources (WHO IMCI, NEWS2, PALS, NLEM) but are <b>not clinically
            validated for this deployment</b>. Not for clinical use.
          </Banner>
        </Reveal>

        {/* ── The three tiers ── */}
        <Reveal delay={0.05} style={{ marginTop: 'var(--sp-5)' }}>
          <h2 style={{ fontSize: 24, marginBottom: 6 }}>Every case lands in one of three tiers</h2>
          <p className="muted" style={{ marginBottom: 'var(--sp-3)' }}>
            Deterministic rules set the floor. The model may raise a tier; it can never lower one.
          </p>
        </Reveal>

        <motion.div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))' }}
          variants={stagger} initial="hidden" animate="show">
          {[
            ['low', 'Handled on site', 'First aid, precautions, diet, and OTC medication — queued for daily doctor review before anything is dispensed.'],
            ['medium', 'Doctor consultation', 'A video call is scheduled and load-balanced across available doctors, with a 5-minute tolerance window and automatic reassignment.'],
            ['high', 'Urgent referral', 'Danger-zone state, nearest capable hospital ranked by free beds before distance, and a printable referral slip.'],
          ].map(([tier, title, body]) => (
            <motion.div key={tier} className="card" variants={fadeUp}>
              <span className={`tier ${tier}`}><span className="dot" />{tier.toUpperCase()}</span>
              <h3 style={{ fontSize: 18, margin: 'var(--sp-2) 0 6px' }}>{title}</h3>
              <p className="muted small">{body}</p>
            </motion.div>
          ))}
        </motion.div>

        {/* ── Sign in ── */}
        <div className="grid two" style={{ marginTop: 'var(--sp-5)' }} id="signin">
          <Card title="Sign in" sub="Accounts are provisioned by an administrator. There is no public signup.">
            <form onSubmit={submit}>
              <label htmlFor="email">Email</label>
              <input
                id="email" type="email" autoComplete="username"
                value={email} onChange={(e) => setEmail(e.target.value)}
              />

              <label htmlFor="password" style={{ marginTop: 'var(--sp-2)' }}>Password</label>
              <input
                id="password" type="password" autoComplete="current-password"
                value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder="SEED_DEMO_PASSWORD"
              />

              <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
                <Button type="submit" loading={busy} icon={IconArrow}>Sign in</Button>
                <button type="button" className="btn ghost"
                  onClick={() => setEmail('demo.assistant.1@ruralai-demo.invalid')}>
                  <IconUser size={18} /> Assistant
                </button>
                <button type="button" className="btn ghost"
                  onClick={() => setEmail('demo.doctor.up-knp.2@ruralai-demo.invalid')}>
                  <IconStethoscope size={18} /> Doctor
                </button>
              </div>

              {error && (
                <div style={{ marginTop: 'var(--sp-3)' }}>
                  <Banner kind="err">{error}</Banner>
                </div>
              )}
            </form>
          </Card>

          <Card title="What is running" sub="Every item below is implemented and talking to live infrastructure.">
            {CAPABILITIES.map(([k, v]) => (
              <div key={k} style={{ padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                  <IconShield size={17} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 3 }} />
                  <div>
                    <b style={{ fontSize: 14.5 }}>{k}</b>
                    <p className="muted small">{v}</p>
                  </div>
                </div>
              </div>
            ))}
          </Card>
        </div>
      </div>
    </div>
  );
}

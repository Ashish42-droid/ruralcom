/**
 * Shared UI primitives and motion presets.
 *
 * Motion here is at "standard" intensity: it conveys spatial relationship
 * and state change, and nothing moves purely for decoration. On a clinical
 * screen an animation that delays information is a cost, not a flourish —
 * so entrances are short (~260ms) and exits shorter, and every transform
 * is on `transform`/`opacity` only so it stays on the compositor.
 *
 * Icons are inline SVG (Lucide-style paths), never emoji. Emoji render
 * inconsistently across Android versions and are announced as their
 * literal name by screen readers.
 */

/*
 * eslint-disable react/only-export-components --
 * False positive. The Icon* exports below ARE components, but they are
 * produced by the svg() factory and assigned to a const, which the rule's
 * heuristic cannot distinguish from a plain constant. Everything exported
 * from this file is a component.
 */
import { motion, useReducedMotion } from 'framer-motion';

import { fadeUp, popIn } from './motion.js';

/** Wraps a section so it animates in on mount, respecting reduced motion. */
export function Reveal({ children, className = '', delay = 0, ...rest }) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className} {...rest}>{children}</div>;
  return (
    <motion.div
      className={className}
      variants={fadeUp}
      initial="hidden"
      animate="show"
      transition={{ delay }}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

export function Card({ title, sub, children, className = '', ...rest }) {
  return (
    <Reveal className={`card ${className}`} {...rest}>
      {title && <h3 className="card-title">{title}</h3>}
      {sub && <p className="card-sub">{sub}</p>}
      {children}
    </Reveal>
  );
}

/* ── Icons (inline SVG, 24×24, currentColor) ──────────────────────── */

const svg = (paths, extra = {}) =>
  function Icon({ size = 20, ...p }) {
    return (
      <svg
        width={size} height={size} viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2" strokeLinecap="round"
        strokeLinejoin="round" aria-hidden="true" focusable="false"
        {...extra} {...p}
      >
        {paths}
      </svg>
    );
  };

export const IconFolder = svg(
  <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />,
);
export const IconCamera = svg(
  <>
    <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" />
    <circle cx="12" cy="13" r="3" />
  </>,
);
export const IconCheck = svg(<path d="M20 6 9 17l-5-5" />);
export const IconAlert = svg(
  <>
    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
    <path d="M12 9v4M12 17h.01" />
  </>,
);
export const IconStethoscope = svg(
  <>
    <path d="M4.8 2.3A.3.3 0 1 0 5 2H4a2 2 0 0 0-2 2v5a6 6 0 0 0 6 6v0a6 6 0 0 0 6-6V4a2 2 0 0 0-2-2h-1a.2.2 0 1 0 .3.3" />
    <path d="M8 15v1a6 6 0 0 0 6 6v0a6 6 0 0 0 6-6v-4" />
    <circle cx="20" cy="10" r="2" />
  </>,
);
export const IconUser = svg(
  <>
    <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </>,
);
export const IconX = svg(<path d="M18 6 6 18M6 6l12 12" />);
export const IconArrow = svg(<path d="M5 12h14M12 5l7 7-7 7" />);
export const IconActivity = svg(<path d="M22 12h-4l-3 9L9 3l-3 9H2" />);
export const IconShield = svg(
  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />,
);

/* ── Small components ─────────────────────────────────────────────── */

export function Tier({ tier, size = 'md' }) {
  const label = { low: 'LOW RISK', medium: 'MEDIUM RISK', high: 'HIGH RISK' }[tier] ?? tier;
  return (
    <motion.span
      className={`tier ${tier}`}
      variants={popIn}
      initial="hidden"
      animate="show"
      style={size === 'lg' ? { fontSize: 17, padding: '11px 22px' } : undefined}
      // Colour alone never carries the meaning — the word is always there.
      role="status"
    >
      <span className="dot" />
      {label}
    </motion.span>
  );
}

export function Banner({ kind = 'info', children }) {
  const Icon = kind === 'info' ? IconCheck : IconAlert;
  return (
    <motion.div className={`banner ${kind}`} variants={fadeUp} initial="hidden" animate="show">
      <Icon size={18} style={{ flexShrink: 0, marginTop: 2 }} />
      <div>{children}</div>
    </motion.div>
  );
}

export function Spinner({ size = 16 }) {
  return (
    <motion.span
      aria-hidden="true"
      style={{
        width: size, height: size, borderRadius: '50%',
        border: '2px solid rgba(255,255,255,.28)', borderTopColor: 'currentColor',
        display: 'inline-block',
      }}
      animate={{ rotate: 360 }}
      transition={{ repeat: Infinity, duration: 0.75, ease: 'linear' }}
    />
  );
}

export function Button({ children, loading, icon: Icon, ...rest }) {
  return (
    <button className="btn" {...rest} disabled={rest.disabled || loading}>
      {loading ? <Spinner /> : Icon ? <Icon size={18} /> : null}
      {children}
    </button>
  );
}

/** Step indicator for the intake wizard. */
export function Steps({ steps, current }) {
  return (
    <div className="row" style={{ gap: 8, marginBottom: 'var(--sp-3)' }} aria-label="Progress">
      {steps.map((label, i) => {
        const done = i < current;
        const now = i === current;
        return (
          <motion.div
            key={label}
            layout
            style={{
              flex: '1 1 96px', minWidth: 96, padding: '9px 10px',
              borderRadius: 10, fontSize: 12.5, textAlign: 'center',
              border: `1px solid ${done ? 'var(--low)' : now ? 'var(--accent)' : 'var(--line)'}`,
              color: done ? 'var(--low)' : now ? 'var(--text)' : 'var(--muted)',
              background: now ? 'rgba(34,211,238,.1)' : 'var(--panel-2)',
            }}
            aria-current={now ? 'step' : undefined}
          >
            {done ? '✓ ' : `${i + 1}. `}{label}
          </motion.div>
        );
      })}
    </div>
  );
}

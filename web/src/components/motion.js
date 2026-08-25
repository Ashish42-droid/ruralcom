/**
 * Shared motion presets.
 *
 * Kept out of ui.jsx so that file exports only components — React Fast
 * Refresh degrades to a full reload when a module mixes the two.
 *
 * Intensity is "standard": motion conveys spatial relationship and state
 * change, never decoration. Entrances are ~260ms and exits shorter, and
 * everything animates transform/opacity only so it stays on the compositor.
 */
export const fadeUp = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.26, ease: [0.22, 1, 0.36, 1] } },
  exit: { opacity: 0, y: -8, transition: { duration: 0.16 } },
};

/** Children reveal in sequence, drawing the eye down the page in order. */
export const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.055, delayChildren: 0.04 } },
};

export const popIn = {
  hidden: { opacity: 0, scale: 0.94 },
  show: { opacity: 1, scale: 1, transition: { type: 'spring', stiffness: 320, damping: 26 } },
};

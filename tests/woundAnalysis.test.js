/**
 * Wound image analysis.
 *
 * Network is mocked throughout — no test spends the owner's Gemini quota.
 * The real API is exercised by `npm run vision:check` instead.
 *
 * The assertions that matter are the safety ones: a wound finding can
 * raise a tier and never lower one, and "no redness seen" is never treated
 * as "no infection".
 */
import {
  analyseWound,
  toTriageText,
  woundRubricSchema,
  WoundAnalysisError,
  isVisionConfigured,
  RUBRIC_VERSION,
} from '../services/vision/woundAnalysis.js';
import { evaluateRules } from '../services/triage/rules.js';

const IMAGE = Buffer.from('fake jpeg bytes');

/** Builds a fake fetch returning a Gemini generateContent body. */
function fakeGemini(rubric, { ok = true, status = 200 } = {}) {
  return async () => ({
    ok,
    status,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify(rubric) }] } }],
    }),
    text: async () => JSON.stringify(rubric),
  });
}

const CLEAN = {
  isWoundVisible: true,
  imageQuality: 'good',
  approximateSizeCm: 2,
  depth: 'superficial',
  tissueAppearance: ['clean'],
  infectionSigns: ['none_seen'],
  activeBleeding: 'none',
  foreignBodyVisible: false,
  observations: 'A small clean laceration on the palm.',
};

const INFECTED = {
  ...CLEAN,
  infectionSigns: ['erythema', 'purulent_discharge', 'spreading_redness'],
  tissueAppearance: ['sloughy'],
  approximateSizeCm: 5,
};

/**
 * The key is INJECTED rather than read from process.env.
 *
 * Under Jest ESM a value assigned to process.env from a test file does not
 * reliably reach the module under test, so ambient configuration makes for
 * flaky, confusing failures. Explicit injection is both deterministic and
 * better design.
 */
const KEY = { apiKey: 'test-key-1234567890' };

describe('configuration', () => {
  it('rejects empty image data before making any request', async () => {
    let called = false;
    const fetchImpl = async () => { called = true; return fakeGemini(CLEAN)(); };
    await expect(analyseWound(Buffer.alloc(0), 'image/png', { ...KEY, fetchImpl })).rejects.toThrow(TypeError);
    expect(called).toBe(false);
  });

  it('detects that a key is configured', () => {
    // The 'no key' path cannot be isolated here — an explicit null falls
    // back to the real environment by design. It is covered where it
    // matters instead: processAttachment() checks isVisionConfigured()
    // and marks the attachment not_applicable rather than failing.
    expect(isVisionConfigured()).toBe(true);
  });
});

describe('a well-formed analysis', () => {
  it('returns the scored rubric with its version stamped', async () => {
    const r = await analyseWound(IMAGE, 'image/png', { ...KEY, fetchImpl: fakeGemini(CLEAN) });

    expect(r.depth).toBe('superficial');
    expect(r.approximateSizeCm).toBe(2);
    expect(r.rubricVersion).toBe(RUBRIC_VERSION);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('sends the image inline and asks for a constrained JSON schema', async () => {
    let captured;
    const fetchImpl = async (_url, init) => { captured = init; return fakeGemini(CLEAN)(); };
    await analyseWound(IMAGE, 'image/jpeg', { ...KEY, fetchImpl });

    const body = JSON.parse(captured.body);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    // A constrained schema is what stops the model returning prose.
    expect(body.generationConfig.responseSchema.type).toBe('OBJECT');
    expect(body.generationConfig.temperature).toBe(0);
    expect(body.contents[0].parts[1].inline_data.mime_type).toBe('image/jpeg');
  });
});

describe('the skin-tone limitation is always surfaced', () => {
  it('warns that absent redness is not absent infection', async () => {
    const r = await analyseWound(IMAGE, 'image/png', { ...KEY, fetchImpl: fakeGemini(CLEAN) });
    const text = r.limitations.join(' ');

    // Erythema is harder to see on brown and black skin, and the training
    // data under-represents both. This must never be silently dropped.
    expect(text).toMatch(/brown and black skin/i);
    expect(text).toMatch(/does not mean no infection/i);
  });

  it('warns when redness IS reported too', async () => {
    const r = await analyseWound(IMAGE, 'image/png', { ...KEY, fetchImpl: fakeGemini(INFECTED) });
    expect(r.limitations.join(' ')).toMatch(/brown and black skin/i);
  });

  it('always states that an image can only raise the tier', async () => {
    const r = await analyseWound(IMAGE, 'image/png', { ...KEY, fetchImpl: fakeGemini(CLEAN) });
    expect(r.limitations.join(' ')).toMatch(/never lowers/i);
  });

  it('flags poor image quality explicitly', async () => {
    const r = await analyseWound(IMAGE, 'image/png', {
      ...KEY, fetchImpl: fakeGemini({ ...CLEAN, imageQuality: 'poor', depth: 'unclear' }),
    });
    expect(r.limitations.join(' ')).toMatch(/poor.*re-photograph/i);
  });
});

describe('rubric output is validated, not trusted', () => {
  it.each([
    ['prose instead of JSON', 'the wound looks infected'],
    ['an invented depth value', { ...CLEAN, depth: 'very deep' }],
    ['an invented infection sign', { ...CLEAN, infectionSigns: ['gangrene'] }],
    ['a missing required field', { imageQuality: 'good' }],
    ['a negative size', { ...CLEAN, approximateSizeCm: -4 }],
  ])('rejects %s', async (_label, payload) => {
    const fetchImpl = typeof payload === 'string'
      ? async () => ({ ok: true, status: 200,
          json: async () => ({ candidates: [{ content: { parts: [{ text: payload }] } }] }) })
      : fakeGemini(payload);

    await expect(analyseWound(IMAGE, 'image/png', { ...KEY, fetchImpl })).rejects.toThrow(WoundAnalysisError);
  });

  it('the schema forbids any treatment or medication field', () => {
    // Vision reports observations. Medicine comes from the signed
    // formulary, and there is deliberately nowhere here to put a drug.
    const keys = Object.keys(woundRubricSchema.shape).join(' ').toLowerCase();
    expect(keys).not.toMatch(/medicat|drug|dose|treat|prescri|diagnos/);
  });
});

describe('transport failures surface clearly', () => {
  it('reports a non-2xx status', async () => {
    const fetchImpl = fakeGemini({ error: 'quota' }, { ok: false, status: 429 });
    await expect(analyseWound(IMAGE, 'image/png', { ...KEY, fetchImpl })).rejects.toThrow(/HTTP 429/);
  });

  it('reports a network failure', async () => {
    const fetchImpl = async () => { throw new Error('ENOTFOUND'); };
    await expect(analyseWound(IMAGE, 'image/png', { ...KEY, fetchImpl })).rejects.toThrow(/request failed/i);
  });
});

describe('toTriageText phrases findings for the rule layer', () => {
  it('produces nothing when no wound is visible', () => {
    expect(toTriageText({ ...CLEAN, isWoundVisible: false })).toBe('');
  });

  it('produces nothing for a clean superficial wound', () => {
    // A reassuring photograph must not generate an escalating phrase.
    expect(toTriageText(CLEAN)).toBe('');
  });

  it('names the specific findings that matter', () => {
    const text = toTriageText(INFECTED);
    expect(text).toMatch(/spreading redness/);
    expect(text).toMatch(/purulent discharge/);
  });
});

describe('wound findings escalate DETERMINISTICALLY', () => {
  const normalVitals = { temperatureC: 37, spo2: 98, pulseBpm: 76 };
  const adult = { ageYears: 34, registrationComplete: true };

  it('spreading redness reaches HIGH with no model involvement', () => {
    const r = evaluateRules({
      vitals: normalVitals, patient: adult,
      symptomText: `cut on the leg. ${toTriageText(INFECTED)}`,
    });

    expect(r.tier).toBe('high');
    expect(r.hits.map((h) => h.code)).toContain('wound_spreading_cellulitis');
  });

  it('a visible foreign body reaches MEDIUM', () => {
    const r = evaluateRules({
      vitals: normalVitals, patient: adult,
      symptomText: toTriageText({ ...CLEAN, foreignBodyVisible: true }),
    });
    expect(r.hits.map((h) => h.code)).toContain('wound_foreign_body');
  });

  it('a clean wound adds NO escalation of its own', () => {
    const r = evaluateRules({
      vitals: normalVitals, patient: adult,
      symptomText: `small cut on hand. ${toTriageText(CLEAN)}`.trim(),
    });
    expect(r.hits.map((h) => h.code).filter((c) => c.startsWith('wound_'))).toEqual([]);
    expect(r.tier).toBe('low');
  });

  it('no wound rule can LOWER a tier', () => {
    // The floor set by hypoxia must survive a reassuring photograph.
    const r = evaluateRules({
      vitals: { ...normalVitals, spo2: 85 },
      patient: adult,
      symptomText: `laceration. ${toTriageText(CLEAN)}`,
    });
    expect(r.tier).toBe('high');
  });
});

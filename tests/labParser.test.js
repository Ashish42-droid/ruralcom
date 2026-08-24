/**
 * Lab report parsing.
 *
 * These matter because the output feeds triage. The single most dangerous
 * failure mode is misreading which number on a line is the RESULT and
 * which is the reference bound — reporting a haemoglobin of 13.0 when the
 * patient's is 7.2 turns severe anaemia into a normal result.
 */
import {
  parseLabReport,
  parseReferenceRange,
  classify,
  toTriageText,
  ANALYTES,
} from '../services/ocr/labParser.js';

/** Exactly what Tesseract produced from a rendered lab report. */
const REAL_OCR_OUTPUT = `CITY DIAGNOSTIC LAB
Patient: Ramesh Kumar Age: 54 / M
Haemoglobin 7.2 g/dL (13.0 - 17.0)
WBC Count 11200 /uL (4000 - 11000)
Platelets 142000 /uL (150000 - 410000)
Blood Glucose 186 mg/dL (70 - 140)
Creatinine 1.1 mg/dL (0.7 - 1.3)`;

describe('parseReferenceRange', () => {
  it.each([
    ['parenthesised', 'Haemoglobin 7.2 g/dL (13.0 - 17.0)', { low: 13, high: 17 }],
    ['en dash', 'Glucose 186 mg/dL (70 – 140)', { low: 70, high: 140 }],
    ['"to"', 'Urea 30 mg/dL (15 to 45)', { low: 15, high: 45 }],
    ['Ref: prefix', 'Creatinine 1.1 Ref: 0.7-1.3', { low: 0.7, high: 1.3 }],
    ['comma thousands', 'Platelets 142000 (150,000 - 410,000)', { low: 150000, high: 410000 }],
  ])('parses a %s range', (_label, line, expected) => {
    expect(parseReferenceRange(line)).toEqual(expected);
  });

  it('returns null when no range is printed', () => {
    expect(parseReferenceRange('Haemoglobin 7.2 g/dL')).toBeNull();
  });

  it('rejects an inverted range rather than accepting nonsense', () => {
    expect(parseReferenceRange('Hb 7.2 (17.0 - 13.0)')).toBeNull();
  });
});

describe('parsing real Tesseract output', () => {
  const parsed = parseLabReport(REAL_OCR_OUTPUT);

  it('extracts every analyte on the report', () => {
    expect(parsed.results.map((r) => r.key).sort()).toEqual(
      ['creatinine', 'glucose', 'haemoglobin', 'platelets', 'wbc'].sort(),
    );
  });

  it('takes the RESULT, not the reference bound', () => {
    // The failure that turns severe anaemia into a normal result.
    const hb = parsed.results.find((r) => r.key === 'haemoglobin');
    expect(hb.value).toBe(7.2);
    expect(hb.value).not.toBe(13.0);
  });

  it('handles values with thousands separators and large magnitudes', () => {
    expect(parsed.results.find((r) => r.key === 'platelets').value).toBe(142000);
    expect(parsed.results.find((r) => r.key === 'wbc').value).toBe(11200);
  });

  it("prefers the lab's own printed range over the fallback table", () => {
    const hb = parsed.results.find((r) => r.key === 'haemoglobin');
    expect(hb.rangeSource).toBe('report');
    expect(hb.referenceRange).toEqual({ low: 13, high: 17 });
  });

  it('flags out-of-range values by arithmetic', () => {
    const byKey = Object.fromEntries(parsed.results.map((r) => [r.key, r]));

    // 7.2 is below the 13.0 reference floor but ABOVE the 7.0 critical
    // threshold, so it is "low", not "critical_low". Both are abnormal;
    // only the latter warrants an immediate callback.
    expect(byKey.haemoglobin.flag).toBe('low');
    expect(byKey.wbc.flag).toBe('high'); // 11200 > 11000
    expect(byKey.platelets.flag).toBe('low'); // 142000 < 150000
    expect(byKey.glucose.flag).toBe('high'); // 186 > 140
    expect(byKey.creatinine.flag).toBe('normal'); // 1.1 within 0.7-1.3
  });

  it('counts abnormal results', () => {
    expect(parsed.abnormalCount).toBe(4);
  });

  it('ignores the header and demographic lines', () => {
    expect(parsed.results.some((r) => r.sourceLine.includes('Ramesh'))).toBe(false);
  });
});

describe('spelling variants that appear on real Indian reports', () => {
  it.each([
    ['Hemoglobin 9.1 g/dL', 'haemoglobin', 9.1],
    ['Haemoglobin 9.1 g/dL', 'haemoglobin', 9.1],
    ['Hb 9.1 g/dL', 'haemoglobin', 9.1],
    ['TLC 12500 /uL', 'wbc', 12500],
    ['Total Leucocyte Count 12500', 'wbc', 12500],
    ['PLT 90000', 'platelets', 90000],
    ['RBS 240 mg/dL', 'glucose', 240],
    ['BUN 55 mg/dL', 'urea', 55],
  ])('recognises "%s"', (line, expectedKey, expectedValue) => {
    const parsed = parseLabReport(line);
    expect(parsed.results[0]?.key).toBe(expectedKey);
    expect(parsed.results[0]?.value).toBe(expectedValue);
  });
});

describe('critical thresholds', () => {
  it('marks a critically low haemoglobin as critical, not merely low', () => {
    const parsed = parseLabReport('Haemoglobin 6.4 g/dL (13.0 - 17.0)');
    expect(parsed.results[0].flag).toBe('critical_low');
    expect(parsed.results[0].severity).toBe('critical');
    expect(parsed.criticalCount).toBe(1);
  });

  it('marks a critically high glucose as critical', () => {
    const parsed = parseLabReport('Blood Glucose 420 mg/dL (70 - 140)');
    expect(parsed.results[0].severity).toBe('critical');
  });

  it('treats a merely-out-of-range value as a warning', () => {
    const parsed = parseLabReport('Blood Glucose 186 mg/dL (70 - 140)');
    expect(parsed.results[0].severity).toBe('warning');
  });
});

describe('classify', () => {
  const hb = ANALYTES.find((a) => a.key === 'haemoglobin');

  it.each([
    [15, 'normal'],
    [11, 'low'],
    [19, 'high'],
    [6.0, 'critical_low'],
  ])('classifies %s as %s', (value, expected) => {
    expect(classify(value, { low: 13, high: 17 }, hb).flag).toBe(expected);
  });

  it('returns unknown rather than guessing when there is no range', () => {
    // Absence of a range is not evidence the value is normal.
    expect(classify(7.2, null, hb).flag).toBe('unknown');
  });

  it('returns unknown for a missing value', () => {
    expect(classify(null, { low: 13, high: 17 }, hb).flag).toBe('unknown');
  });
});

describe('malformed and adversarial input', () => {
  it.each([
    ['empty string', ''],
    ['whitespace', '   \n  \n '],
    ['null', null],
    ['a number', 12345],
    ['undefined', undefined],
  ])('handles %s without throwing', (_label, input) => {
    expect(() => parseLabReport(input)).not.toThrow();
    expect(parseLabReport(input).results).toEqual([]);
  });

  it('skips an analyte line with no readable number', () => {
    expect(parseLabReport('Haemoglobin  ---  g/dL').results).toEqual([]);
  });

  it('counts numeric lines it could not attribute to an analyte', () => {
    // Surfaces "OCR read something we did not understand", so a report
    // full of unrecognised results is visible rather than silently empty.
    const parsed = parseLabReport('Haemoglobin 12 (13-17)\nSome Unknown Test 42 mg/dL');
    expect(parsed.unrecognisedLines).toBe(1);
  });

  it('keeps only the first occurrence of a repeated analyte', () => {
    const parsed = parseLabReport(
      'Haemoglobin 7.2 g/dL (13.0 - 17.0)\nHaemoglobin reference 13.0 - 17.0',
    );
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].value).toBe(7.2);
  });
});

describe('toTriageText', () => {
  it('phrases abnormal results for the triage rule layer', () => {
    const text = toTriageText(parseLabReport(REAL_OCR_OUTPUT));

    expect(text).toMatch(/Haemoglobin/);
    expect(text).toMatch(/7\.2/);
    // Normal results are omitted — the rule layer only needs the flags.
    expect(text).not.toMatch(/Creatinine/);
  });

  it('returns an empty string when everything is normal', () => {
    const parsed = parseLabReport('Creatinine 1.1 mg/dL (0.7 - 1.3)');
    expect(toTriageText(parsed)).toBe('');
  });

  it('handles no results without throwing', () => {
    expect(toTriageText(null)).toBe('');
    expect(toTriageText({ results: [] })).toBe('');
  });
});

describe('lab results escalate the tier DETERMINISTICALLY', () => {
  it('a critical lab escalates to HIGH without any model involvement', async () => {
    const { evaluateRules } = await import('../services/triage/rules.js');

    const labText = toTriageText(
      parseLabReport('Haemoglobin 6.1 g/dL (13.0 - 17.0)\nPlatelets 88000 /uL (150000 - 410000)'),
    );

    const result = evaluateRules({
      // Everything else deliberately unremarkable: on vitals alone this
      // patient looks fine.
      vitals: { temperatureC: 37.1, spo2: 97, systolic: 112, diastolic: 74, pulseBpm: 92 },
      patient: { ageYears: 45, registrationComplete: true },
      symptomText: `feeling weak and tired for two weeks. ${labText}`,
    });

    expect(result.tier).toBe('high');
    // Hb 6.1 is below the 7.0 critical threshold -> critical.
    // Platelets 88000 are low but above the 50000 bleeding-risk
    // threshold, so they contribute lab_abnormal rather than a critical hit.
    expect(result.hits.map((h) => h.code)).toEqual(
      expect.arrayContaining(['lab_severe_anaemia', 'lab_abnormal']),
    );
  });

  it('an abnormal-but-not-critical lab reaches MEDIUM, not HIGH', async () => {
    const { evaluateRules } = await import('../services/triage/rules.js');

    const labText = toTriageText(parseLabReport('Blood Glucose 186 mg/dL (70 - 140)'));
    const result = evaluateRules({
      vitals: { temperatureC: 37, spo2: 98, systolic: 118, diastolic: 76, pulseBpm: 74 },
      patient: { ageYears: 45, registrationComplete: true },
      symptomText: labText,
    });

    expect(result.tier).toBe('medium');
    expect(result.hits.map((h) => h.code)).toContain('lab_abnormal');
  });

  it('entirely normal labs add no escalation of their own', async () => {
    const { evaluateRules } = await import('../services/triage/rules.js');

    const labText = toTriageText(parseLabReport('Creatinine 1.1 mg/dL (0.7 - 1.3)'));
    expect(labText).toBe('');

    const result = evaluateRules({
      vitals: { temperatureC: 37, spo2: 98, systolic: 118, diastolic: 76, pulseBpm: 74 },
      patient: { ageYears: 45, registrationComplete: true },
      symptomText: `mild headache. ${labText}`.trim(),
    });

    expect(result.hits.map((h) => h.code)).not.toContain('lab_abnormal');
    expect(result.tier).toBe('low');
  });
});

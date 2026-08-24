/**
 * Lab report parsing — deterministic, not AI.
 *
 * ===================== WHY NO MODEL IS INVOLVED =====================
 * A haemoglobin of 7.2 g/dL against a reference range of 13.0–17.0 is
 * anaemia by arithmetic. Nothing is inferred, nothing is judged, and no
 * model should be given the opportunity to disagree.
 *
 * The division of labour is deliberate:
 *   - OCR turns pixels into text (fallible, confidence-scored).
 *   - THIS module turns text into numbers and compares them to ranges
 *     (infallible given correct input).
 *   - A model may later phrase the result in the patient's language.
 * Only the first step can be wrong, and it is the only one carrying a
 * confidence score.
 * ===================================================================
 *
 * Reference ranges are taken from the REPORT ITSELF wherever the lab
 * printed them, which is the common case on Indian lab reports and is
 * always preferable — ranges are analyser- and population-specific, so the
 * lab's own range beats any table we could hold. The fallback table below
 * is standard adult reference data and is marked unvalidated.
 */

/**
 * Canonical analytes.
 *
 * `match` covers the spelling variants that actually appear on Indian lab
 * reports (Haemoglobin/Hemoglobin/Hb, TLC for total leucocyte count).
 *
 * >>> FALLBACK RANGES ARE UNVALIDATED <<<
 * Standard adult values, used ONLY when the report prints no range of its
 * own. They require clinician review before any clinical use, same status
 * as the triage thresholds (docs/DECISIONS.md D-027).
 */
export const ANALYTES = [
  {
    key: 'haemoglobin',
    display: 'Haemoglobin',
    loinc: '718-7',
    match: /\b(ha?emoglobin|hb|hgb)\b/i,
    unit: 'g/dL',
    fallbackRange: { low: 12.0, high: 17.0 },
    criticalLow: 7.0,
  },
  {
    key: 'wbc',
    display: 'White cell count',
    loinc: '6690-2',
    match: /\b(wbc|w\.?b\.?c|tlc|total leu[ck]ocyte|leu[ck]ocyte count)\b/i,
    unit: '/uL',
    fallbackRange: { low: 4000, high: 11000 },
  },
  {
    key: 'platelets',
    display: 'Platelet count',
    loinc: '777-3',
    match: /\b(platelets?|plt|platelet count)\b/i,
    unit: '/uL',
    fallbackRange: { low: 150000, high: 410000 },
    criticalLow: 50000,
  },
  {
    key: 'glucose',
    display: 'Blood glucose',
    loinc: '2345-7',
    match: /\b(blood glucose|glucose|rbs|fbs|sugar)\b/i,
    unit: 'mg/dL',
    fallbackRange: { low: 70, high: 140 },
    criticalLow: 54,
    criticalHigh: 300,
  },
  {
    key: 'creatinine',
    display: 'Creatinine',
    loinc: '2160-0',
    match: /\bcreatinine\b/i,
    unit: 'mg/dL',
    fallbackRange: { low: 0.6, high: 1.3 },
  },
  {
    key: 'urea',
    display: 'Blood urea',
    loinc: '3094-0',
    match: /\b(blood urea|urea|bun)\b/i,
    unit: 'mg/dL',
    fallbackRange: { low: 15, high: 45 },
  },
  {
    key: 'bilirubin',
    display: 'Total bilirubin',
    loinc: '1975-2',
    match: /\b(total bilirubin|bilirubin)\b/i,
    unit: 'mg/dL',
    fallbackRange: { low: 0.2, high: 1.2 },
  },
];

/** Strips thousands separators without mangling a decimal point. */
function toNumber(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/,/g, '').trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pulls a printed reference range out of a line.
 * Handles "(13.0 - 17.0)", "13.0-17.0", "Ref: 13 to 17".
 */
export function parseReferenceRange(line) {
  const patterns = [
    /\(\s*([\d.,]+)\s*[-–to]+\s*([\d.,]+)\s*\)/i,
    /\bref(?:erence)?[:\s]+([\d.,]+)\s*[-–to]+\s*([\d.,]+)/i,
    /\b([\d.,]+)\s*[-–]\s*([\d.,]+)\s*$/,
  ];

  for (const pattern of patterns) {
    const m = line.match(pattern);
    if (!m) continue;
    const low = toNumber(m[1]);
    const high = toNumber(m[2]);
    if (low !== null && high !== null && low < high) return { low, high };
  }
  return null;
}

/**
 * Extracts the measured value from a line, given where the analyte name ended.
 *
 * Deliberately takes the FIRST number after the name: on a typical report
 * the layout is `Analyte  <value>  <unit>  (<low> - <high>)`, so the
 * reference-range numbers come later and must not be mistaken for the
 * result. Getting this backwards would report a patient's haemoglobin as
 * 13.0 when it is actually 7.2.
 */
function extractValue(line, afterIndex) {
  const rest = line.slice(afterIndex);
  const range = parseReferenceRange(line);

  const matches = [...rest.matchAll(/(-?[\d][\d.,]*)/g)];
  for (const m of matches) {
    const n = toNumber(m[1]);
    if (n === null) continue;
    // Skip a number that is only the opening bound of the printed range.
    if (range && n === range.low && rest.indexOf(m[1]) > rest.indexOf('(')) continue;
    return n;
  }
  return null;
}

/** Classifies a value against its range. */
export function classify(value, range, analyte) {
  if (value === null || !range) return { flag: 'unknown', severity: 'info' };

  const criticalLow = analyte?.criticalLow;
  const criticalHigh = analyte?.criticalHigh;

  if (criticalLow !== undefined && value <= criticalLow) {
    return { flag: 'critical_low', severity: 'critical' };
  }
  if (criticalHigh !== undefined && value >= criticalHigh) {
    return { flag: 'critical_high', severity: 'critical' };
  }
  if (value < range.low) return { flag: 'low', severity: 'warning' };
  if (value > range.high) return { flag: 'high', severity: 'warning' };
  return { flag: 'normal', severity: 'info' };
}

/**
 * Parses OCR'd lab report text into structured, range-compared results.
 *
 * @param {string} text raw OCR output
 * @returns {{results: Array, abnormalCount: number, criticalCount: number,
 *            unrecognisedLines: number}}
 */
export function parseLabReport(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { results: [], abnormalCount: 0, criticalCount: 0, unrecognisedLines: 0 };
  }

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const results = [];
  const seen = new Set();
  let unrecognisedLines = 0;

  for (const line of lines) {
    const analyte = ANALYTES.find((a) => a.match.test(line));

    if (!analyte) {
      if (/[\d]/.test(line)) unrecognisedLines += 1;
      continue;
    }

    // One result per analyte — the first occurrence wins. A repeated name
    // later in a report is usually a footer or a reference legend.
    if (seen.has(analyte.key)) continue;

    const nameMatch = line.match(analyte.match);
    const value = extractValue(line, nameMatch.index + nameMatch[0].length);
    if (value === null) continue;

    // The lab's own printed range beats our table: ranges are analyser-
    // and population-specific.
    const printedRange = parseReferenceRange(line);
    const range = printedRange ?? analyte.fallbackRange;
    const { flag, severity } = classify(value, range, analyte);

    seen.add(analyte.key);
    results.push({
      key: analyte.key,
      display: analyte.display,
      loinc: analyte.loinc,
      value,
      unit: analyte.unit,
      referenceRange: range,
      rangeSource: printedRange ? 'report' : 'fallback_table',
      flag,
      severity,
      sourceLine: line,
    });
  }

  return {
    results,
    abnormalCount: results.filter((r) => r.flag !== 'normal' && r.flag !== 'unknown').length,
    criticalCount: results.filter((r) => r.severity === 'critical').length,
    unrecognisedLines,
  };
}

/**
 * Turns parsed results into text the triage rule layer can read.
 *
 * Critical values are phrased so the existing red-flag matcher picks them
 * up, rather than inventing a separate escalation path that could drift
 * out of step with the main one.
 */
export function toTriageText(parsed) {
  if (!parsed?.results?.length) return '';

  return parsed.results
    .filter((r) => r.flag !== 'normal' && r.flag !== 'unknown')
    .map((r) => {
      const direction = r.flag.includes('low') ? 'low' : 'high';
      const critical = r.severity === 'critical' ? 'critically ' : '';
      return `${r.display} ${critical}${direction} at ${r.value} ${r.unit} (reference ${r.referenceRange.low}-${r.referenceRange.high})`;
    })
    .join('. ');
}

export default { parseLabReport, parseReferenceRange, classify, toTriageText, ANALYTES };

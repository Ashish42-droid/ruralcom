import {
  generateRhid,
  isValidRhid,
  normaliseRhid,
  formatRhid,
  verhoeffCheckDigit,
  verhoeffValidate,
  RHID_LENGTH,
} from '../utils/rhid.js';

describe('Verhoeff check digit', () => {
  it('validates a payload plus its own check digit', () => {
    const payload = '23657895642';
    const full = payload + verhoeffCheckDigit(payload);
    expect(verhoeffValidate(full)).toBe(true);
  });

  it('rejects any single-digit error', () => {
    const rhid = generateRhid();
    for (let pos = 0; pos < rhid.length; pos += 1) {
      for (let d = 0; d <= 9; d += 1) {
        if (String(d) === rhid[pos]) continue;
        const mutated = rhid.slice(0, pos) + d + rhid.slice(pos + 1);
        expect(verhoeffValidate(mutated)).toBe(false);
      }
    }
  });

  it('rejects every adjacent transposition — the read-aloud error', () => {
    const rhid = generateRhid();
    for (let i = 0; i < rhid.length - 1; i += 1) {
      if (rhid[i] === rhid[i + 1]) continue;
      const swapped =
        rhid.slice(0, i) + rhid[i + 1] + rhid[i] + rhid.slice(i + 2);
      expect(verhoeffValidate(swapped)).toBe(false);
    }
  });
});

describe('generateRhid', () => {
  it('produces 12 digits', () => {
    expect(generateRhid()).toMatch(/^[0-9]{12}$/);
    expect(generateRhid()).toHaveLength(RHID_LENGTH);
  });

  it('never starts with zero, so no leading digit can be lost', () => {
    for (let i = 0; i < 500; i += 1) {
      expect(generateRhid()[0]).not.toBe('0');
    }
  });

  it('always validates', () => {
    for (let i = 0; i < 500; i += 1) {
      expect(isValidRhid(generateRhid())).toBe(true);
    }
  });

  it('is not sequential — 1000 ids yield 1000 distinct values', () => {
    const seen = new Set();
    for (let i = 0; i < 1000; i += 1) seen.add(generateRhid());
    expect(seen.size).toBe(1000);
  });
});

describe('isValidRhid', () => {
  it.each([
    ['too short', '12345678901'],
    ['too long', '1234567890123'],
    ['non-numeric', '12345678901a'],
    ['leading zero', '012345678901'],
    ['empty', ''],
  ])('rejects %s', (_label, value) => {
    expect(isValidRhid(value)).toBe(false);
  });

  it.each([null, undefined, 123456789012, {}, []])(
    'rejects the non-string %p without throwing',
    (value) => {
      expect(isValidRhid(value)).toBe(false);
    },
  );
});

describe('normaliseRhid', () => {
  it('accepts spaced and hyphenated input as health workers actually type it', () => {
    const rhid = generateRhid();
    const spaced = formatRhid(rhid);
    const hyphenated = spaced.replace(/ /g, '-');

    expect(normaliseRhid(spaced)).toBe(rhid);
    expect(normaliseRhid(hyphenated)).toBe(rhid);
    expect(isValidRhid(normaliseRhid(spaced))).toBe(true);
  });

  it('returns an empty string for non-string input', () => {
    expect(normaliseRhid(null)).toBe('');
  });
});

describe('formatRhid', () => {
  it('groups in fours for display', () => {
    expect(formatRhid('123456789012')).toBe('1234 5678 9012');
  });

  it('passes through anything of the wrong length unchanged', () => {
    expect(formatRhid('123')).toBe('123');
  });
});

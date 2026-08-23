/**
 * RuralAI Health ID (RHID).
 *
 * A system-issued 12-digit patient identifier: 11 random digits plus one
 * Verhoeff check digit. No government ID data is involved — we issue it, so
 * it is our own data and carries none of the Aadhaar Act / UIDAI storage
 * restrictions (see docs/DECISIONS.md D-002).
 *
 * Why a check digit at all: transcription error is the single largest source
 * of duplicate records in field EMRs. A health worker mistyping one digit
 * must get "invalid ID", not a silently created second patient record for
 * the same person.
 *
 * Why Verhoeff rather than Luhn: Verhoeff catches all single-digit errors
 * AND all adjacent transpositions (typing 21 for 12), which is the most
 * common human error when reading a number aloud from a card. Luhn misses
 * the 09/90 transposition.
 *
 * Why random rather than sequential: a sequential ID leaks how many patients
 * the system holds and lets anyone enumerate records by counting up.
 */
import { randomInt } from 'node:crypto';

/** Multiplication table for the dihedral group D5. */
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

/** Permutation table. */
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** Inverse table. */
const INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

/** Computes the Verhoeff check digit for a digit string. */
export function verhoeffCheckDigit(digits) {
  let c = 0;
  const reversed = String(digits).split('').reverse();

  for (let i = 0; i < reversed.length; i += 1) {
    const digit = Number(reversed[i]);
    if (Number.isNaN(digit)) {
      throw new TypeError(`Not a digit string: ${digits}`);
    }
    c = D[c][P[(i + 1) % 8][digit]];
  }

  return INV[c];
}

/** True when a full digit string (payload + check digit) validates. */
export function verhoeffValidate(full) {
  let c = 0;
  const reversed = String(full).split('').reverse();

  for (let i = 0; i < reversed.length; i += 1) {
    const digit = Number(reversed[i]);
    if (Number.isNaN(digit)) return false;
    c = D[c][P[i % 8][digit]];
  }

  return c === 0;
}

export const RHID_LENGTH = 12;
const PAYLOAD_LENGTH = RHID_LENGTH - 1;

/**
 * Generates one candidate RHID.
 *
 * The first digit is forced non-zero so the ID always renders as 12
 * characters — a leading zero lost to a spreadsheet or an integer cast is a
 * classic way to corrupt an identifier.
 */
export function generateRhid() {
  let payload = String(randomInt(1, 10));
  for (let i = 1; i < PAYLOAD_LENGTH; i += 1) {
    payload += String(randomInt(0, 10));
  }
  return payload + String(verhoeffCheckDigit(payload));
}

/** Shape and check-digit validation. Does not check the database. */
export function isValidRhid(value) {
  if (typeof value !== 'string') return false;
  if (!/^[1-9][0-9]{11}$/.test(value)) return false;
  return verhoeffValidate(value);
}

/**
 * Normalises user input: strips spaces and hyphens so "1234 5678 9012" and
 * "1234-5678-9012" both work. Health workers read these aloud and type them
 * in groups; rejecting a space would be a needless failure.
 */
export function normaliseRhid(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\s-]/g, '');
}

/** Formats for display in groups of four: 1234 5678 9012. */
export function formatRhid(value) {
  const clean = normaliseRhid(value);
  if (clean.length !== RHID_LENGTH) return clean;
  return `${clean.slice(0, 4)} ${clean.slice(4, 8)} ${clean.slice(8)}`;
}

export default {
  generateRhid,
  isValidRhid,
  normaliseRhid,
  formatRhid,
  verhoeffCheckDigit,
  verhoeffValidate,
  RHID_LENGTH,
};

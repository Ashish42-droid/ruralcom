/**
 * IEEE 11073-20601 medical device float decoding.
 *
 * Bluetooth health-device profiles do not use IEEE-754. They use two
 * personal-health-device float formats, and getting these wrong is the
 * classic source of "the oximeter says 3200%" bugs.
 *
 * SFLOAT (16-bit): 4-bit signed exponent, 12-bit signed mantissa
 * FLOAT  (32-bit): 8-bit signed exponent, 24-bit signed mantissa
 *
 * Both reserve specific mantissa values for NaN / infinity / not-at-this-
 * resolution. Those MUST be surfaced as null rather than decoded as
 * numbers — an NaN sentinel silently read as 2046 becomes a plausible-
 * looking pulse rate.
 */

/** SFLOAT reserved mantissas. */
const SFLOAT_SPECIAL = {
  0x07fe: 'positive_infinity',
  0x07ff: 'nan',
  0x0800: 'not_at_this_resolution',
  0x0801: 'reserved',
  0x0802: 'negative_infinity',
};

/** FLOAT reserved mantissas. */
const FLOAT_SPECIAL = {
  0x007ffffe: 'positive_infinity',
  0x007fffff: 'nan',
  0x00800000: 'not_at_this_resolution',
  0x00800001: 'reserved',
  0x00800002: 'negative_infinity',
};

/** Sign-extends an n-bit two's-complement value. */
function signExtend(value, bits) {
  const signBit = 1 << (bits - 1);
  return value & signBit ? value - (1 << bits) : value;
}

/**
 * Decodes a 16-bit SFLOAT at `offset` (little-endian).
 * @returns {{value: number|null, special: string|null}}
 */
export function readSFloat(buffer, offset = 0) {
  if (buffer.length < offset + 2) {
    throw new RangeError(`SFLOAT needs 2 bytes at offset ${offset}`);
  }

  const raw = buffer.readUInt16LE(offset);
  const mantissaRaw = raw & 0x0fff;
  const exponentRaw = (raw >> 12) & 0x0f;

  const special = SFLOAT_SPECIAL[mantissaRaw];
  if (special) return { value: null, special };

  const mantissa = signExtend(mantissaRaw, 12);
  const exponent = signExtend(exponentRaw, 4);

  return { value: mantissa * 10 ** exponent, special: null };
}

/**
 * Decodes a 32-bit FLOAT at `offset` (little-endian).
 * @returns {{value: number|null, special: string|null}}
 */
export function readFloat(buffer, offset = 0) {
  if (buffer.length < offset + 4) {
    throw new RangeError(`FLOAT needs 4 bytes at offset ${offset}`);
  }

  const mantissaRaw =
    buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
  const exponentRaw = buffer[offset + 3];

  const special = FLOAT_SPECIAL[mantissaRaw];
  if (special) return { value: null, special };

  const mantissa = signExtend(mantissaRaw, 24);
  const exponent = signExtend(exponentRaw, 8);

  const value = mantissa * 10 ** exponent;

  // Floating-point exponent arithmetic leaves artefacts like 36.90000000001.
  // Device resolution is never better than 0.001, so rounding there is
  // lossless and stops artefacts reaching a clinical record.
  return { value: Math.round(value * 1000) / 1000, special: null };
}

/**
 * Decodes a 7-byte BLE date/time at `offset`.
 * Returns null when the device reports an unknown year (0).
 */
export function readDateTime(buffer, offset = 0) {
  if (buffer.length < offset + 7) {
    throw new RangeError(`DateTime needs 7 bytes at offset ${offset}`);
  }

  const year = buffer.readUInt16LE(offset);
  if (year === 0) return null;

  const month = buffer[offset + 2];
  const day = buffer[offset + 3];
  if (month === 0 || day === 0) return null;

  return new Date(
    Date.UTC(year, month - 1, day, buffer[offset + 4], buffer[offset + 5], buffer[offset + 6]),
  );
}

export default { readSFloat, readFloat, readDateTime };

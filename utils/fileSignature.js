/**
 * Magic-byte file type detection.
 *
 * A client-supplied extension and Content-Type are both trivially forged.
 * Accepting them means a `.jpg` that is actually an HTML file with a script
 * payload, or a polyglot that renders as an image and executes elsewhere.
 * The only trustworthy signal is what the bytes actually say.
 *
 * Deliberately small and dependency-free: this list is exactly the formats
 * the intake pipeline accepts, and a narrow allowlist is the point.
 */

/** Byte signatures, checked at a given offset. */
const SIGNATURES = [
  { mime: 'image/jpeg', ext: 'jpg', offset: 0, bytes: [0xff, 0xd8, 0xff] },
  {
    mime: 'image/png',
    ext: 'png',
    offset: 0,
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  { mime: 'application/pdf', ext: 'pdf', offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
];

/** ASCII helper. */
const ascii = (buf, start, length) => buf.subarray(start, start + length).toString('latin1');

function matches(buf, sig) {
  if (buf.length < sig.offset + sig.bytes.length) return false;
  for (let i = 0; i < sig.bytes.length; i += 1) {
    if (buf[sig.offset + i] !== sig.bytes[i]) return false;
  }
  return true;
}

/**
 * Identifies a buffer.
 * @returns {{mime: string, ext: string}|null} null when unrecognised
 */
export function detectFileType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  for (const sig of SIGNATURES) {
    if (matches(buffer, sig)) return { mime: sig.mime, ext: sig.ext };
  }

  // Container formats need a second check: both WebP and HEIC start with a
  // generic box header, so the brand at offset 8 is what distinguishes them.
  if (ascii(buffer, 0, 4) === 'RIFF' && ascii(buffer, 8, 4) === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }

  if (ascii(buffer, 4, 4) === 'ftyp') {
    const brand = ascii(buffer, 8, 4);
    // Phone cameras produce these; an Android/iOS capture path must accept them.
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) {
      return { mime: 'image/heic', ext: 'heic' };
    }
  }

  return null;
}

/** MIME types the intake pipeline accepts. */
export const ALLOWED_MIME_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
]);

/** Per-attachment-type allowlist. Wound images are never PDFs. */
export const ALLOWED_BY_TYPE = Object.freeze({
  prescription: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'],
  lab_report: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'],
  wound_image: ['image/jpeg', 'image/png', 'image/webp', 'image/heic'],
  other: ALLOWED_MIME_TYPES,
});

/**
 * Validates a buffer for a given attachment type.
 *
 * @returns {{ok: true, mime: string, ext: string} | {ok: false, reason: string}}
 */
export function validateUpload(buffer, attachmentType, declaredMime) {
  const detected = detectFileType(buffer);

  if (!detected) {
    return {
      ok: false,
      reason: 'File type could not be identified from its contents',
    };
  }

  const allowed = ALLOWED_BY_TYPE[attachmentType] ?? ALLOWED_MIME_TYPES;
  if (!allowed.includes(detected.mime)) {
    return {
      ok: false,
      reason: `${detected.mime} is not accepted for ${attachmentType}`,
    };
  }

  // A mismatch between what the client claimed and what the bytes say is
  // worth surfacing: usually a mislabelled phone upload, occasionally an
  // attempt to smuggle a type past the filter.
  if (declaredMime && declaredMime !== detected.mime) {
    return {
      ok: true,
      mime: detected.mime,
      ext: detected.ext,
      mismatch: { declared: declaredMime, actual: detected.mime },
    };
  }

  return { ok: true, mime: detected.mime, ext: detected.ext };
}

export default { detectFileType, validateUpload, ALLOWED_MIME_TYPES, ALLOWED_BY_TYPE };

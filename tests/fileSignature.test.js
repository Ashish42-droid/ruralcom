/**
 * Magic-byte validation.
 *
 * The point of these tests is that a forged extension or Content-Type gets
 * you nowhere: only the bytes count.
 */
import { detectFileType, validateUpload } from '../utils/fileSignature.js';

const pad = (head, length = 64) =>
  Buffer.concat([Buffer.from(head), Buffer.alloc(Math.max(0, length - head.length))]);

const JPEG = pad([0xff, 0xd8, 0xff, 0xe0]);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = pad([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const WEBP = pad([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const HEIC = pad([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
]);
const HTML = pad(Buffer.from('<!DOCTYPE html><script>alert(1)</script>', 'latin1'));
const SVG = pad(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'latin1'));
const ZIP = pad([0x50, 0x4b, 0x03, 0x04]);

describe('detectFileType', () => {
  it.each([
    ['JPEG', JPEG, 'image/jpeg'],
    ['PNG', PNG, 'image/png'],
    ['PDF', PDF, 'application/pdf'],
    ['WebP', WEBP, 'image/webp'],
    ['HEIC', HEIC, 'image/heic'],
  ])('identifies %s', (_label, buf, mime) => {
    expect(detectFileType(buf).mime).toBe(mime);
  });

  it.each([
    ['HTML', HTML],
    ['SVG', SVG],
    ['ZIP', ZIP],
  ])('does not identify %s', (_label, buf) => {
    expect(detectFileType(buf)).toBeNull();
  });

  it('returns null for a buffer too short to identify', () => {
    expect(detectFileType(Buffer.from([0xff, 0xd8]))).toBeNull();
  });

  it('returns null for non-buffer input without throwing', () => {
    expect(detectFileType('not a buffer')).toBeNull();
    expect(detectFileType(null)).toBeNull();
  });
});

describe('validateUpload rejects forged types', () => {
  it('rejects HTML claiming to be a JPEG', () => {
    const result = validateUpload(HTML, 'wound_image', 'image/jpeg');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/could not be identified/i);
  });

  it('rejects SVG — a scriptable format that is not an accepted image', () => {
    expect(validateUpload(SVG, 'wound_image', 'image/svg+xml').ok).toBe(false);
  });

  it('rejects a ZIP renamed to .pdf', () => {
    expect(validateUpload(ZIP, 'lab_report', 'application/pdf').ok).toBe(false);
  });

  it('flags a MIME mismatch but trusts the bytes', () => {
    const result = validateUpload(PNG, 'wound_image', 'image/jpeg');
    expect(result.ok).toBe(true);
    expect(result.mime).toBe('image/png');
    expect(result.mismatch).toEqual({ declared: 'image/jpeg', actual: 'image/png' });
  });
});

describe('per-type allowlists', () => {
  it('accepts a PDF as a prescription', () => {
    expect(validateUpload(PDF, 'prescription').ok).toBe(true);
  });

  it('accepts a PDF as a lab report', () => {
    expect(validateUpload(PDF, 'lab_report').ok).toBe(true);
  });

  it('REJECTS a PDF as a wound image — a wound photo is never a document', () => {
    const result = validateUpload(PDF, 'wound_image');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/not accepted for wound_image/);
  });

  it('accepts phone-camera formats for wound images', () => {
    expect(validateUpload(HEIC, 'wound_image').ok).toBe(true);
    expect(validateUpload(WEBP, 'wound_image').ok).toBe(true);
  });
});

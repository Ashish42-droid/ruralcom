/**
 * Multipart upload handling.
 *
 * Memory storage, not disk: files are validated by magic bytes and streamed
 * straight to Supabase Storage, so nothing untrusted is ever written to the
 * local filesystem where a path-traversal or a double-extension could bite.
 * `public/temp/` remains for pipeline staging of files we have already
 * accepted.
 */
import multer from 'multer';

import ApiError from '../utils/ApiError.js';
import { MAX_FILE_BYTES, MAX_FILES_PER_BATCH } from '../services/attachment.service.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_BYTES,
    files: MAX_FILES_PER_BATCH,
    // Filenames are never logged, but an absurd one still shouldn't be stored.
    fieldNameSize: 100,
  },
  fileFilter(_req, file, cb) {
    // A coarse first pass only. The authoritative check is magic bytes in
    // utils/fileSignature.js — a client-supplied MIME type is not evidence.
    if (/^image\/|^application\/pdf$/.test(file.mimetype)) return cb(null, true);
    return cb(
      ApiError.badRequest('Only images and PDF files are accepted'),
    );
  },
});

/**
 * Accepts one OR many files on the same field, so the camera path (one file)
 * and the file-manager path (N files) hit the same endpoint.
 */
export const acceptFiles = upload.array('files', MAX_FILES_PER_BATCH);

/** Translates multer's own errors into the API's error shape. */
export function handleUploadErrors(err, _req, _res, next) {
  if (err?.name !== 'MulterError') return next(err);

  const map = {
    LIMIT_FILE_SIZE: `Each file must be under ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB`,
    LIMIT_FILE_COUNT: `At most ${MAX_FILES_PER_BATCH} files per upload`,
    LIMIT_UNEXPECTED_FILE: 'Files must be sent on the "files" field',
  };

  return next(ApiError.badRequest(map[err.code] ?? 'Upload rejected'));
}

export default { acceptFiles, handleUploadErrors };

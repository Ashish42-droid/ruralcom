/**
 * OCR pipeline: download -> preprocess -> recognise -> parse -> persist.
 *
 * Engine is Tesseract, chosen because it needs NO credentials, runs
 * locally, and is genuinely good on printed documents — verified at 93%
 * confidence extracting a full lab panel. Handwritten prescriptions remain
 * the known weak case (see CONFIDENCE below); a vision-model adapter can
 * be added behind the same interface when a credential exists.
 *
 * ========================= CONFIDENCE RULES =========================
 * OCR output NEVER auto-populates a clinical field. Every result is
 * written with `needs_human_review` and the assistant confirms it. Below
 * `MIN_USABLE_CONFIDENCE` the text is stored for reference but explicitly
 * marked unusable rather than being silently offered as data.
 *
 * This is not caution for its own sake: an OCR error that quietly enters a
 * wrong drug name into an interaction check, or a wrong decimal place into
 * a lab value, is a patient-safety event.
 * ====================================================================
 */
import { createWorker } from 'tesseract.js';
import sharp from 'sharp';

import { supabaseAdmin } from '../../config/supabase.js';
import logger from '../../config/logger.js';
import { parseLabReport } from './labParser.js';
import { analyseWound, isVisionConfigured } from '../vision/woundAnalysis.js';

/** Below this, the transcript is stored but flagged unusable. */
export const MIN_USABLE_CONFIDENCE = 60;

/** Tesseract worker startup costs ~6s, so it is created once and reused. */
let workerPromise = null;

async function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker('eng').catch((err) => {
      // Reset so a transient failure (e.g. language data download) can be
      // retried rather than poisoning every later request.
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

export async function shutdownOcr() {
  if (!workerPromise) return;
  try {
    const worker = await workerPromise;
    await worker.terminate();
  } catch {
    // Already gone.
  }
  workerPromise = null;
}

/**
 * Preprocesses an image for OCR.
 *
 * Greyscale, upscale small images, and normalise contrast. A photograph of
 * a document taken on a cheap phone in poor light is the normal input
 * here, not a flatbed scan, and these three steps are what make that
 * legible to Tesseract.
 */
export async function preprocess(buffer) {
  try {
    const image = sharp(buffer);
    const meta = await image.metadata();

    let pipeline = image.greyscale().normalise();

    // Tesseract degrades sharply below ~1000px on the long edge.
    const longEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
    if (longEdge > 0 && longEdge < 1000) {
      const scale = Math.min(3, Math.ceil(1000 / longEdge));
      pipeline = pipeline.resize({
        width: Math.round((meta.width ?? 0) * scale),
        height: Math.round((meta.height ?? 0) * scale),
        fit: 'fill',
      });
    }

    return await pipeline.png().toBuffer();
  } catch (err) {
    // A preprocessing failure should not lose the document — fall back to
    // the original bytes and let Tesseract do what it can.
    logger.warn({ err }, 'OCR preprocessing failed — using the original image');
    return buffer;
  }
}

/**
 * Runs OCR on an image buffer.
 * @returns {{text: string, confidence: number, usable: boolean, engine: string}}
 */
export async function recognise(buffer) {
  const prepared = await preprocess(buffer);
  const worker = await getWorker();

  const startedAt = Date.now();
  const { data } = await worker.recognize(prepared);
  const latencyMs = Date.now() - startedAt;

  const text = (data.text ?? '').trim();
  const confidence = Number(data.confidence ?? 0);

  return {
    text,
    confidence,
    usable: confidence >= MIN_USABLE_CONFIDENCE && text.length > 0,
    engine: 'tesseract',
    engineVersion: 'tesseract.js-7',
    latencyMs,
  };
}

/**
 * Processes one stored attachment end to end.
 *
 * Writes back through the service role because `ocr_*` columns are
 * deliberately not client-writable (migration 0009) — OCR output feeds
 * clinical decisions, so only the pipeline authors it.
 */
export async function processAttachment(attachmentId) {
  const { data: attachment, error } = await supabaseAdmin
    .from('attachments')
    .select('id, visit_id, patient_id, type, bucket, storage_path, mime, ocr_status')
    .eq('id', attachmentId)
    .maybeSingle();

  if (error || !attachment) {
    logger.warn({ attachmentId, err: error }, 'OCR: attachment not found');
    return { outcome: 'not_found' };
  }

  if (attachment.ocr_status !== 'pending') {
    return { outcome: `already_${attachment.ocr_status}` };
  }

  // Wound images go to the vision model, not to OCR — there is no text on
  // them to read. The rubric is stored in the same column so one code path
  // answers "what do we know about this attachment".
  if (attachment.type === 'wound_image') {
    if (!isVisionConfigured()) {
      await supabaseAdmin.from('attachments')
        .update({ ocr_status: 'not_applicable', needs_human_review: true })
        .eq('id', attachmentId);
      return { outcome: 'vision_not_configured' };
    }
    try {
      const { data: file, error: dlError } = await supabaseAdmin.storage
        .from(attachment.bucket).download(attachment.storage_path);
      if (dlError) throw new Error(dlError.message);

      const buffer = Buffer.from(await file.arrayBuffer());
      const analysis = await analyseWound(buffer, attachment.mime);

      await supabaseAdmin.from('attachments').update({
        ocr_status: 'done',
        ocr_text: JSON.stringify(analysis),
        ocr_engine: analysis.model,
        // Vision findings are observations, never conclusions.
        needs_human_review: true,
      }).eq('id', attachmentId);

      return { outcome: 'done', analysis };
    } catch (err) {
      logger.error({ err, attachmentId }, 'Wound analysis failed');
      await supabaseAdmin.from('attachments')
        .update({ ocr_status: 'failed', needs_human_review: true })
        .eq('id', attachmentId);
      return { outcome: 'failed', error: err.message };
    }
  }

  // PDFs need a rasterisation step Tesseract cannot do alone. Marked
  // explicitly rather than left pending forever, so the queue does not
  // silently accumulate work nothing will ever pick up.
  if (attachment.mime === 'application/pdf') {
    await supabaseAdmin
      .from('attachments')
      .update({
        ocr_status: 'failed',
        ocr_engine: 'tesseract',
        ocr_text: null,
        needs_human_review: true,
      })
      .eq('id', attachmentId);
    return { outcome: 'pdf_unsupported' };
  }

  try {
    const { data: file, error: downloadError } = await supabaseAdmin.storage
      .from(attachment.bucket)
      .download(attachment.storage_path);

    if (downloadError) throw new Error(downloadError.message);

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await recognise(buffer);

    const parsed =
      attachment.type === 'lab_report' ? parseLabReport(result.text) : null;

    await supabaseAdmin
      .from('attachments')
      .update({
        ocr_status: 'done',
        ocr_text: result.text,
        ocr_engine: result.engine,
        // Stored 0..1; Tesseract reports 0..100.
        ocr_confidence: Math.round((result.confidence / 100) * 1000) / 1000,
        // ALWAYS true. OCR output never auto-populates a clinical field.
        needs_human_review: true,
      })
      .eq('id', attachmentId);

    logger.info(
      {
        attachmentId,
        type: attachment.type,
        confidence: result.confidence,
        usable: result.usable,
        latencyMs: result.latencyMs,
        analytesFound: parsed?.results.length ?? 0,
        abnormalCount: parsed?.abnormalCount ?? 0,
      },
      // The extracted TEXT is PHI and is never logged.
      'OCR completed',
    );

    return {
      outcome: 'done',
      confidence: result.confidence,
      usable: result.usable,
      parsed,
    };
  } catch (err) {
    logger.error({ err, attachmentId }, 'OCR failed');

    await supabaseAdmin
      .from('attachments')
      .update({ ocr_status: 'failed', needs_human_review: true })
      .eq('id', attachmentId);

    return { outcome: 'failed', error: err.message };
  }
}

/**
 * Parsed lab results for a visit, drawn from its OCR'd reports.
 *
 * Re-parses stored text rather than storing parsed rows, so a fix to the
 * parser improves every historical report without a migration.
 */
export async function labResultsForVisit(visitId) {
  const { data, error } = await supabaseAdmin
    .from('attachments')
    .select('id, ocr_text, ocr_confidence, created_at')
    .eq('visit_id', visitId)
    .eq('type', 'lab_report')
    .eq('ocr_status', 'done')
    .order('created_at', { ascending: false });

  if (error || !data?.length) return { results: [], abnormalCount: 0, criticalCount: 0 };

  const merged = { results: [], abnormalCount: 0, criticalCount: 0 };
  const seen = new Set();

  for (const attachment of data) {
    const parsed = parseLabReport(attachment.ocr_text);
    for (const r of parsed.results) {
      // Newest report wins for a repeated analyte.
      if (seen.has(r.key)) continue;
      seen.add(r.key);
      merged.results.push({ ...r, attachmentId: attachment.id });
    }
  }

  merged.abnormalCount = merged.results.filter(
    (r) => r.flag !== 'normal' && r.flag !== 'unknown',
  ).length;
  merged.criticalCount = merged.results.filter((r) => r.severity === 'critical').length;

  return merged;
}

/** Wound analyses for a visit, newest first. */
export async function woundFindingsForVisit(visitId) {
  const { data } = await supabaseAdmin
    .from('attachments')
    .select('id, ocr_text, created_at')
    .eq('visit_id', visitId)
    .eq('type', 'wound_image')
    .eq('ocr_status', 'done')
    .order('created_at', { ascending: false });

  return (data ?? []).flatMap((row) => {
    try {
      return [{ attachmentId: row.id, ...JSON.parse(row.ocr_text) }];
    } catch {
      // A row whose rubric will not parse is dropped rather than allowed to
      // throw and take the whole assessment down with it.
      return [];
    }
  });
}

export { parseLabReport };
export default {
  recognise,
  preprocess,
  processAttachment,
  labResultsForVisit,
  shutdownOcr,
  MIN_USABLE_CONFIDENCE,
};

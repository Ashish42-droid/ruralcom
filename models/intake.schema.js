/**
 * Zod schemas for the intake pipeline.
 */
import { z } from 'zod';

import { SUPPORTED_LANGUAGES } from '../services/stt/index.js';

export const ATTACHMENT_TYPES = ['prescription', 'wound_image', 'lab_report', 'other'];
export const CAPTURE_SOURCES = ['camera', 'file_manager', 'device'];
export const LANGUAGE_CODES = Object.keys(SUPPORTED_LANGUAGES);

export const visitIdParamSchema = z.object({
  visitId: z.string().uuid('Not a valid visit id'),
});

export const attachmentIdParamSchema = z.object({
  attachmentId: z.string().uuid('Not a valid attachment id'),
});

export const uploadBodySchema = z.object({
  type: z.enum(ATTACHMENT_TYPES),
  // Both entry points hit the same endpoint; this only records provenance.
  captureSource: z.enum(CAPTURE_SOURCES).default('file_manager'),
});

export const listAttachmentsQuerySchema = z.object({
  type: z.enum(ATTACHMENT_TYPES).optional(),
});

export const recordSymptomSchema = z.object({
  rawText: z.string().trim().min(2, 'Describe the symptom').max(5000),
  language: z.enum(LANGUAGE_CODES).default('hi'),
  // Voice entries are accepted by the schema but the STT path is not wired
  // yet; the API rejects inputMode 'voice' until an adapter exists rather
  // than silently storing an untranscribed entry.
  inputMode: z.enum(['text', 'voice']).default('text'),
  durationDays: z.coerce.number().int().min(0).max(36500).optional(),
  onsetDate: z.coerce.date().optional(),
  severityReported: z.coerce.number().int().min(0).max(10).optional(),
});

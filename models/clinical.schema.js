/**
 * Zod schemas for vitals and assessments.
 *
 * Bounds here MIRROR the database CHECK constraints in migration 0010 and
 * the plausibility ranges in services/iot/DeviceDriver.js. Duplication is
 * deliberate: the API layer should reject an implausible value with a clear
 * message rather than surfacing a raw constraint violation, but the database
 * remains the authority so no write path can bypass it.
 */
import { z } from 'zod';

export const CAPTURE_METHODS = ['camera', 'file_manager', 'device'];

export const visitIdParamSchema = z.object({
  visitId: z.string().uuid('Not a valid visit id'),
});

export const assessmentIdParamSchema = z.object({
  assessmentId: z.string().uuid('Not a valid assessment id'),
});

export const recordVitalsSchema = z
  .object({
    temperatureC: z.coerce.number().min(25).max(45).optional(),
    spo2: z.coerce.number().int().min(50).max(100).optional(),
    systolic: z.coerce.number().int().min(40).max(300).optional(),
    diastolic: z.coerce.number().int().min(20).max(200).optional(),
    pulseBpm: z.coerce.number().int().min(20).max(300).optional(),
    respiratoryRate: z.coerce.number().int().min(4).max(90).optional(),
    weightKg: z.coerce.number().min(0.5).max(400).optional(),
    heightCm: z.coerce.number().min(20).max(250).optional(),
    captureMethod: z.enum(CAPTURE_METHODS).default('file_manager'),
    deviceId: z.string().uuid().optional(),
  })
  .refine(
    (v) =>
      [
        v.temperatureC, v.spo2, v.systolic, v.diastolic,
        v.pulseBpm, v.respiratoryRate, v.weightKg, v.heightCm,
      ].some((x) => x !== undefined),
    { message: 'Record at least one measurement' },
  )
  .refine(
    (v) => v.systolic === undefined || v.diastolic === undefined || v.systolic > v.diastolic,
    {
      path: ['systolic'],
      // Almost always means the two were entered the wrong way round.
      message: 'Systolic must be higher than diastolic — check the two values are not swapped',
    },
  );

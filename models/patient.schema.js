/**
 * Zod schemas for patient intake.
 *
 * Deliberately permissive about what is *unknown* and strict about what is
 * *malformed*. A rural intake flow must never block on a field the patient
 * cannot answer — but a wrong age silently accepted becomes a wrong
 * paediatric dose later.
 */
import { z } from 'zod';
import { normaliseRhid, isValidRhid } from '../utils/rhid.js';

export const SEXES = ['female', 'male', 'other', 'undisclosed'];
export const DATA_SOURCES = [
  'stated',
  'ocr',
  'device',
  'assistant_observed',
  'doctor_confirmed',
];
export const ALLERGY_SEVERITIES = ['mild', 'moderate', 'severe', 'unknown'];

/** Accepts "1234 5678 9012" and "1234-5678-9012" as health workers type them. */
export const rhidSchema = z
  .string()
  .transform(normaliseRhid)
  .refine(isValidRhid, 'Not a valid 12-digit health ID (check-digit failed)');

const name = z.string().trim().min(2, 'Name is too short').max(120);
const optionalText = z.string().trim().max(200).optional();

const ageFields = {
  dateOfBirth: z.coerce.date().max(new Date(), 'Date of birth is in the future').optional(),
  ageYears: z.coerce.number().int().min(0).max(130).optional(),
};

export const createPatientSchema = z
  .object({
    fullName: name,
    sex: z.enum(SEXES).default('undisclosed'),
    ...ageFields,
    preferredLanguage: z.string().trim().min(2).max(10).default('hi'),
    village: optionalText,
    phone: z.string().trim().regex(/^[0-9+\-\s]{6,20}$/, 'Invalid phone').optional(),
    abhaId: z.string().trim().regex(/^[0-9]{14}$/, 'ABHA id is 14 digits').optional(),
    history: z
      .array(
        z.object({
          condition: z.string().trim().min(2).max(200),
          since: optionalText,
          notes: optionalText,
          source: z.enum(DATA_SOURCES).default('stated'),
        }),
      )
      .max(50)
      .optional(),
    allergies: z
      .array(
        z.object({
          substance: z.string().trim().min(2).max(120),
          reaction: optionalText,
          severity: z.enum(ALLERGY_SEVERITIES).default('unknown'),
          source: z.enum(DATA_SOURCES).default('stated'),
        }),
      )
      .max(50)
      .optional(),
  })
  .refine((v) => v.dateOfBirth || v.ageYears !== undefined, {
    path: ['ageYears'],
    // Age is not optional anywhere downstream: paediatric dosing, IMCI danger
    // signs and the risk score all branch on it.
    message: 'Either dateOfBirth or ageYears is required — age drives dosing and triage',
  });

/**
 * Emergency registration.
 *
 * Only a name is required. Everything else is completed later. The urgent
 * path must never be blocked on paperwork — that is the entire point of it.
 */
export const emergencyRegisterSchema = z.object({
  fullName: name,
  sex: z.enum(SEXES).default('undisclosed'),
  ageYears: z.coerce.number().int().min(0).max(130).optional(),
  chiefComplaint: z.string().trim().min(2).max(500),
});

export const updatePatientSchema = z
  .object({
    fullName: name.optional(),
    sex: z.enum(SEXES).optional(),
    ...ageFields,
    preferredLanguage: z.string().trim().min(2).max(10).optional(),
    village: optionalText,
    phone: z.string().trim().regex(/^[0-9+\-\s]{6,20}$/).optional(),
    abhaId: z.string().trim().regex(/^[0-9]{14}$/).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'No updatable fields supplied');

export const searchPatientQuerySchema = z
  .object({
    rhid: z.string().trim().optional(),
    name: z.string().trim().min(2).max(120).optional(),
    phone: z.string().trim().min(4).max(20).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .refine(
    (v) => v.rhid || v.name || v.phone,
    'Supply at least one of rhid, name or phone',
  );

export const addHistorySchema = z.object({
  condition: z.string().trim().min(2).max(200),
  since: optionalText,
  notes: optionalText,
  source: z.enum(DATA_SOURCES).default('stated'),
});

export const addAllergySchema = z.object({
  substance: z.string().trim().min(2).max(120),
  reaction: optionalText,
  severity: z.enum(ALLERGY_SEVERITIES).default('unknown'),
  source: z.enum(DATA_SOURCES).default('stated'),
});

export const openVisitSchema = z.object({
  chiefComplaint: z.string().trim().min(2).max(500).optional(),
});

export const patientIdParamSchema = z.object({
  patientId: z.string().uuid('Not a valid patient id'),
});

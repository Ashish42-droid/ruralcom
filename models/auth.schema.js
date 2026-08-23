/**
 * Zod schemas for auth and provisioning payloads.
 *
 * In plain JavaScript these are the only guarantee about request shape, so
 * every auth route validates through them. See middlewares/validate.js.
 */
import { z } from 'zod';

export const ROLES = [
  'super_admin',
  'state_admin',
  'district_admin',
  'doctor',
  'senior_doctor',
  'clinical_assistant',
  'auditor',
];

/** Roles an admin may provision. `super_admin` is bootstrap-only. */
export const PROVISIONABLE_ROLES = ROLES.filter((r) => r !== 'super_admin');

export const ADMIN_ROLES = ['super_admin', 'state_admin', 'district_admin'];

const email = z.string().trim().toLowerCase().email('A valid email is required');

const password = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(128)
  .refine((v) => /[a-z]/.test(v), 'Must contain a lowercase letter')
  .refine((v) => /[A-Z]/.test(v), 'Must contain an uppercase letter')
  .refine((v) => /[0-9]/.test(v), 'Must contain a digit');

const uuid = z.string().uuid();

export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Password is required'),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(10),
});

export const provisionAccountSchema = z
  .object({
    email,
    fullName: z.string().trim().min(2).max(120),
    role: z.enum(PROVISIONABLE_ROLES),
    phone: z.string().trim().min(6).max(20).optional(),
    preferredLanguage: z.string().trim().min(2).max(10).default('en'),

    // Doctor / senior_doctor
    registrationNo: z.string().trim().min(3).max(50).optional(),
    specialities: z.array(z.string().trim().min(2)).max(10).optional(),
    districtId: uuid.optional(),
    facilityId: uuid.optional(),

    // Admin roles
    scopeLevel: z.enum(['national', 'state', 'district']).optional(),
    stateId: uuid.optional(),

    // Clinical assistant
    certificationRef: z.string().trim().max(80).optional(),
  })
  .superRefine((val, ctx) => {
    const needsDistrict = ['doctor', 'senior_doctor'].includes(val.role);
    if (needsDistrict && !val.districtId) {
      ctx.addIssue({
        code: 'custom',
        path: ['districtId'],
        message: 'districtId is required for doctor roles',
      });
    }
    if (needsDistrict && !val.registrationNo) {
      ctx.addIssue({
        code: 'custom',
        path: ['registrationNo'],
        message: 'registrationNo is required for doctor roles',
      });
    }
    if (val.role === 'clinical_assistant' && !val.facilityId) {
      ctx.addIssue({
        code: 'custom',
        path: ['facilityId'],
        message: 'facilityId is required for a clinical assistant',
      });
    }
    if (['state_admin', 'district_admin'].includes(val.role)) {
      if (val.role === 'state_admin' && !val.stateId) {
        ctx.addIssue({
          code: 'custom',
          path: ['stateId'],
          message: 'stateId is required for a state admin',
        });
      }
      if (val.role === 'district_admin' && !val.districtId) {
        ctx.addIssue({
          code: 'custom',
          path: ['districtId'],
          message: 'districtId is required for a district admin',
        });
      }
    }
  });

export const acceptInvitationSchema = z.object({
  token: z.string().min(20),
  password,
});

export const updateOwnProfileSchema = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  phone: z.string().trim().min(6).max(20).optional(),
  preferredLanguage: z.string().trim().min(2).max(10).optional(),
});

export const setActiveSchema = z.object({
  isActive: z.boolean(),
  reason: z.string().trim().min(3).max(500),
});

export const listStaffQuerySchema = z.object({
  role: z.enum(ROLES).optional(),
  districtId: uuid.optional(),
  stateId: uuid.optional(),
  isActive: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

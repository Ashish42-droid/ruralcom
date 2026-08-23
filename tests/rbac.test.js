/**
 * RBAC guard unit tests.
 *
 * These cover the SECOND line of defence. Database-level isolation is
 * covered separately in rls.test.js — a guard bug must never be the only
 * thing preventing a data leak.
 */
import { jest } from '@jest/globals';

jest.unstable_mockModule('../services/audit.service.js', () => ({
  recordAudit: jest.fn(async () => {}),
  recordAuditAsync: jest.fn(() => {}),
  default: {},
}));

const { requireRole, requireAdmin, requireSuperAdmin, denyAdminClinicalWrite } =
  await import('../middlewares/rbac.js');
const { recordAuditAsync } = await import('../services/audit.service.js');

function mockReq(role) {
  return {
    user: role ? { id: 'user-1', role } : undefined,
    method: 'POST',
    originalUrl: '/api/v1/test',
    get: () => 'jest',
    ip: '127.0.0.1',
    id: 'req-1',
  };
}

describe('requireRole', () => {
  it('allows a permitted role through', () => {
    const next = jest.fn();
    requireRole('doctor')(mockReq('doctor'), {}, next);
    expect(next).toHaveBeenCalledWith();
  });

  it('rejects a role that is not listed', () => {
    const next = jest.fn();
    requireRole('doctor')(mockReq('clinical_assistant'), {}, next);
    expect(next.mock.calls[0][0].statusCode).toBe(403);
  });

  it('rejects an unauthenticated caller with 401, not 403', () => {
    const next = jest.fn();
    requireRole('doctor')(mockReq(null), {}, next);
    expect(next.mock.calls[0][0].statusCode).toBe(401);
  });

  it('records an audit entry when access is denied', () => {
    requireRole('doctor')(mockReq('auditor'), {}, jest.fn());
    expect(recordAuditAsync).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'permission_denied', severity: 'warning' }),
    );
  });
});

describe('role sets are not inheritance chains', () => {
  it('does not let senior_doctor through a clinical_assistant-only guard', () => {
    const next = jest.fn();
    requireRole('clinical_assistant')(mockReq('senior_doctor'), {}, next);
    expect(next.mock.calls[0][0].statusCode).toBe(403);
  });

  it('does not let super_admin through a doctor-only guard', () => {
    const next = jest.fn();
    requireRole('doctor')(mockReq('super_admin'), {}, next);
    expect(next.mock.calls[0][0].statusCode).toBe(403);
  });
});

describe('requireAdmin', () => {
  it.each(['super_admin', 'state_admin', 'district_admin'])('allows %s', (role) => {
    const next = jest.fn();
    requireAdmin(mockReq(role), {}, next);
    expect(next).toHaveBeenCalledWith();
  });

  it.each(['doctor', 'senior_doctor', 'clinical_assistant', 'auditor'])(
    'rejects %s',
    (role) => {
      const next = jest.fn();
      requireAdmin(mockReq(role), {}, next);
      expect(next.mock.calls[0][0].statusCode).toBe(403);
    },
  );
});

describe('requireSuperAdmin', () => {
  it('rejects a state_admin', () => {
    const next = jest.fn();
    requireSuperAdmin(mockReq('state_admin'), {}, next);
    expect(next.mock.calls[0][0].statusCode).toBe(403);
  });
});

describe('denyAdminClinicalWrite', () => {
  it.each(['super_admin', 'state_admin', 'district_admin'])(
    'blocks %s from writing clinical data',
    (role) => {
      const next = jest.fn();
      denyAdminClinicalWrite(mockReq(role), {}, next);
      expect(next.mock.calls[0][0].statusCode).toBe(403);
    },
  );

  it('allows a clinical assistant', () => {
    const next = jest.fn();
    denyAdminClinicalWrite(mockReq('clinical_assistant'), {}, next);
    expect(next).toHaveBeenCalledWith();
  });
});

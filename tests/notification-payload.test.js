/**
 * The no-PHI-in-notifications rule.
 *
 * Notification payloads travel over websockets and may be cached
 * client-side, so they must carry ids and enum values only. This suite
 * pins that rule so a future "just include the patient name, it's
 * convenient" change fails loudly instead of quietly leaking.
 *
 * No database or socket needed — this is pure payload validation.
 */
import { jest } from '@jest/globals';

// Stub the socket layer so nothing tries to open a real connection.
jest.unstable_mockModule('../sockets/index.js', () => ({
  emitToUser: () => false,
  EVENTS: new Proxy({}, { get: (_t, k) => String(k) }),
}));

const mockInsert = jest.fn();
jest.unstable_mockModule('../config/supabase.js', () => ({
  supabaseAdmin: {
    from: () => ({
      insert: (row) => {
        mockInsert(row);
        return {
          select: () => ({
            single: async () => ({
              data: { id: 'notif-1', created_at: new Date().toISOString() },
              error: null,
            }),
          }),
        };
      },
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
  },
  supabaseAsUser: () => ({}),
}));

const { notify } = await import('../services/notification.service.js');

beforeEach(() => {
  mockInsert.mockClear();
});

describe('PHI is rejected from notification payloads', () => {
  it.each([
    ['a patient name', { fullName: 'Ramesh Kumar' }],
    ['a snake_case name', { full_name: 'Ramesh Kumar' }],
    ['symptom text', { rawText: 'crushing chest pain' }],
    ['model reasoning', { reasoning: 'Likely acute MI' }],
    ['a differential', { differential: [{ condition: 'MI' }] }],
    ['a clinical note', { clinicalNote: 'Recheck the BP' }],
    ['a health ID', { rhid: '123456789012' }],
    ['a phone number', { phone: '9876543210' }],
    ['a village', { village: 'Rampur' }],
  ])('rejects %s', async (_label, payload) => {
    const id = await notify({
      recipientId: 'user-1',
      type: 'assessment_ready',
      payload,
    });

    // notify() swallows the throw and returns null rather than failing the
    // clinical action it is a side effect of — but nothing is persisted.
    expect(id).toBeNull();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it.each([
    ['ids only', { consultationId: 'c-1', doctorId: 'd-1' }],
    ['an enum value', { action: 'flag_to_assistant' }],
    ['a timestamp', { toleranceExpiresAt: '2026-08-24T10:00:00Z' }],
    ['a count', { reassignCount: 2 }],
    ['nothing at all', {}],
  ])('accepts %s', async (_label, payload) => {
    const id = await notify({
      recipientId: 'user-1',
      type: 'consultation_ringing',
      payload,
    });

    expect(id).toBe('notif-1');
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });
});

describe('notify never throws into the caller', () => {
  it('returns null instead of throwing when the recipient is missing', async () => {
    // A notification is a side effect of a clinical action. Failing the
    // action because a notification could not be sent would be worse.
    await expect(notify({ recipientId: null, type: 'assessment_ready' })).resolves.toBeNull();
  });
});

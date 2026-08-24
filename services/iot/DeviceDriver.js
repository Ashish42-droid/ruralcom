/**
 * Device driver interface and the normalised observation shape.
 *
 * The point of this layer is that we did not "integrate two devices" — we
 * built a device abstraction and implemented drivers against it. Adding
 * hardware later means writing one `parse()` and registering it; nothing
 * above this file changes.
 *
 * Observations are shaped on FHIR `Observation` with LOINC codes. That
 * costs nothing now and means ABDM/FHIR interoperability later is a mapping
 * exercise rather than a rewrite.
 */

/** LOINC codes for the observations this system handles. */
export const LOINC = Object.freeze({
  SPO2: { code: '59408-5', display: 'Oxygen saturation in Arterial blood by Pulse oximetry', unit: '%' },
  PULSE: { code: '8867-4', display: 'Heart rate', unit: '/min' },
  BODY_TEMPERATURE: { code: '8310-5', display: 'Body temperature', unit: 'Cel' },
  RESPIRATORY_RATE: { code: '9279-1', display: 'Respiratory rate', unit: '/min' },
  SYSTOLIC: { code: '8480-6', display: 'Systolic blood pressure', unit: 'mm[Hg]' },
  DIASTOLIC: { code: '8462-4', display: 'Diastolic blood pressure', unit: 'mm[Hg]' },
});

/**
 * Physiological plausibility bounds.
 *
 * A reading outside these is rejected, not stored. An uncalibrated or
 * misparsed device feeding the triage engine is a real hazard: a bogus
 * SpO2 of 100 would MASK hypoxia, which is worse than no reading at all.
 */
export const PLAUSIBLE_RANGE = Object.freeze({
  SPO2: [50, 100],
  PULSE: [20, 300],
  BODY_TEMPERATURE: [25, 45],
  RESPIRATORY_RATE: [4, 90],
  SYSTOLIC: [40, 300],
  DIASTOLIC: [20, 200],
});

export class DeviceError extends Error {
  constructor(message, { driver, code } = {}) {
    super(message);
    this.name = 'DeviceError';
    this.driver = driver;
    this.code = code;
  }
}

/**
 * Builds a normalised observation, or returns a rejection.
 *
 * @returns {{ok: true, observation: object} | {ok: false, reason: string}}
 */
export function makeObservation({ kind, value, effectiveAt, deviceId, driver, meta = {} }) {
  const loinc = LOINC[kind];
  if (!loinc) {
    return { ok: false, reason: `Unknown observation kind: ${kind}` };
  }

  if (value === null || value === undefined) {
    return { ok: false, reason: `${kind} reading was unavailable (device reported no value)` };
  }

  if (!Number.isFinite(value)) {
    return { ok: false, reason: `${kind} reading was not a finite number` };
  }

  const [min, max] = PLAUSIBLE_RANGE[kind];
  if (value < min || value > max) {
    return {
      ok: false,
      reason: `${kind} reading ${value} is outside the plausible range ${min}-${max}`,
    };
  }

  return {
    ok: true,
    observation: {
      resourceType: 'Observation',
      status: 'final',
      code: { coding: [{ system: 'http://loinc.org', ...loinc }] },
      valueQuantity: { value, unit: loinc.unit, system: 'http://unitsofmeasure.org' },
      effectiveDateTime: (effectiveAt ?? new Date()).toISOString(),
      device: { identifier: deviceId ?? null, driver },
      // Distinguishes a certified-device reading from a typed one. The risk
      // scorer should weight these differently.
      captureMethod: 'iot_device',
      meta,
    },
  };
}

/**
 * Base driver.
 *
 * Subclasses implement `parse(raw)` and declare `capabilities` — the
 * observation kinds they can produce. The registry uses that declaration
 * to route payloads without hardcoding device names.
 */
export class DeviceDriver {
  /**
   * @param {object} spec
   * @param {string} spec.id            stable driver id, e.g. 'ble-plx'
   * @param {string} spec.displayName
   * @param {'ble'|'serial'|'http'|'simulated'} spec.transport
   * @param {string[]} spec.capabilities observation kinds produced
   * @param {string} [spec.gattService]  BLE service UUID, when applicable
   */
  constructor(spec) {
    if (new.target === DeviceDriver) {
      throw new TypeError('DeviceDriver is abstract');
    }
    this.id = spec.id;
    this.displayName = spec.displayName;
    this.transport = spec.transport;
    this.capabilities = spec.capabilities;
    this.gattService = spec.gattService ?? null;
  }

  /**
   * Parses one raw payload into observations.
   *
   * @param {Buffer} raw
   * @param {{deviceId?: string}} [context]
   * @returns {{observations: object[], rejected: Array<{reason: string}>}}
   */
  /* eslint-disable-next-line no-unused-vars */
  parse(raw, context) {
    throw new DeviceError('parse() must be overridden', { driver: this.id });
  }

  /** Describes the driver for the device registry and API docs. */
  describe() {
    return {
      id: this.id,
      displayName: this.displayName,
      transport: this.transport,
      capabilities: this.capabilities,
      gattService: this.gattService,
    };
  }
}

export default DeviceDriver;

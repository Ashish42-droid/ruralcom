/**
 * IoT driver layer.
 *
 * These tests use spec-format byte payloads, so they verify the real BLE
 * parsers without any hardware. When physical devices arrive, add captured
 * payloads from them as additional cases — that is the only regression
 * protection a driver ever gets in CI.
 */
import { readSFloat, readFloat, readDateTime } from '../services/iot/ieee11073.js';
import { BlePulseOximeterDriver } from '../services/iot/drivers/blePulseOximeter.js';
import { BleThermometerDriver } from '../services/iot/drivers/bleThermometer.js';
import {
  SimulatedDeviceDriver,
  encodeSFloat,
  encodeFloat,
  buildPlxPayload,
  buildTemperaturePayload,
} from '../services/iot/drivers/simulated.js';
import { createDeviceRegistry } from '../services/iot/registry.js';
import { makeObservation, PLAUSIBLE_RANGE } from '../services/iot/DeviceDriver.js';

describe('IEEE 11073 SFLOAT', () => {
  it('round-trips whole numbers', () => {
    for (const value of [0, 1, 60, 98, 100, 220, 2045]) {
      expect(readSFloat(encodeSFloat(value)).value).toBe(value);
    }
  });

  it('cannot represent 2046-2047, because those mantissas ARE the sentinels', () => {
    // 0x07FE is +infinity and 0x07FF is NaN, so the top of the 12-bit range
    // is unusable by design. Not a bug — decoding them as 2046/2047 would be
    // the bug, and it is the exact failure the sentinel tests below guard.
    expect(readSFloat(encodeSFloat(2047)).special).toBe('nan');
    expect(readSFloat(encodeSFloat(2046)).special).toBe('positive_infinity');
  });

  it('round-trips one decimal place', () => {
    expect(readSFloat(encodeSFloat(97.5, -1)).value).toBeCloseTo(97.5, 5);
  });

  it('handles negative values', () => {
    expect(readSFloat(encodeSFloat(-40)).value).toBe(-40);
  });

  it.each([
    ['NaN', 0x07ff, 'nan'],
    ['+infinity', 0x07fe, 'positive_infinity'],
    ['-infinity', 0x0802, 'negative_infinity'],
    ['not-at-this-resolution', 0x0800, 'not_at_this_resolution'],
    ['reserved', 0x0801, 'reserved'],
  ])('surfaces the %s sentinel as null rather than a number', (_label, mantissa, expected) => {
    const buf = Buffer.alloc(2);
    buf.writeUInt16LE(mantissa, 0);
    const result = readSFloat(buf);

    // The classic bug: NaN (0x07FF) read as a number becomes 2047, a
    // plausible-looking pulse rate.
    expect(result.value).toBeNull();
    expect(result.special).toBe(expected);
  });

  it('throws rather than reading past the buffer', () => {
    expect(() => readSFloat(Buffer.alloc(1))).toThrow(RangeError);
  });
});

describe('IEEE 11073 FLOAT', () => {
  it('round-trips body temperatures at 0.1 resolution', () => {
    for (const value of [35.0, 36.6, 37.0, 38.4, 40.1]) {
      expect(readFloat(encodeFloat(value, -1)).value).toBeCloseTo(value, 3);
    }
  });

  it('does not leak floating-point artefacts into clinical values', () => {
    // 36.9 via exponent arithmetic can yield 36.90000000000001.
    expect(readFloat(encodeFloat(36.9, -1)).value).toBe(36.9);
  });

  it.each([
    ['NaN', 0x007fffff, 'nan'],
    ['+infinity', 0x007ffffe, 'positive_infinity'],
    ['not-at-this-resolution', 0x00800000, 'not_at_this_resolution'],
  ])('surfaces the %s sentinel as null', (_label, mantissa, expected) => {
    const buf = Buffer.alloc(4);
    buf[0] = mantissa & 0xff;
    buf[1] = (mantissa >> 8) & 0xff;
    buf[2] = (mantissa >> 16) & 0xff;
    buf[3] = 0;

    expect(readFloat(buf)).toEqual({ value: null, special: expected });
  });
});

describe('BLE DateTime', () => {
  it('decodes a valid timestamp', () => {
    const buf = Buffer.alloc(7);
    buf.writeUInt16LE(2026, 0);
    buf[2] = 8; buf[3] = 24; buf[4] = 14; buf[5] = 30; buf[6] = 5;

    expect(readDateTime(buf).toISOString()).toBe('2026-08-24T14:30:05.000Z');
  });

  it('returns null for an unknown year rather than year zero', () => {
    expect(readDateTime(Buffer.alloc(7))).toBeNull();
  });
});

describe('BLE pulse oximeter driver', () => {
  const driver = new BlePulseOximeterDriver();

  it('declares the standard PLX service', () => {
    expect(driver.gattService).toBe('00001822-0000-1000-8000-00805f9b34fb');
    expect(driver.capabilities).toEqual(['SPO2', 'PULSE']);
  });

  it('parses a spot-check measurement into FHIR-shaped observations', () => {
    const { observations, rejected } = driver.parse(
      buildPlxPayload({ spo2: 97, pulse: 72 }),
      { deviceId: 'oximeter-01' },
    );

    expect(rejected).toHaveLength(0);
    expect(observations).toHaveLength(2);

    const spo2 = observations.find((o) => o.code.coding[0].code === '59408-5');
    expect(spo2.valueQuantity).toEqual({
      value: 97,
      unit: '%',
      system: 'http://unitsofmeasure.org',
    });
    expect(spo2.resourceType).toBe('Observation');
    expect(spo2.captureMethod).toBe('iot_device');
    expect(spo2.device.identifier).toBe('oximeter-01');
  });

  it('parses a payload carrying a timestamp', () => {
    const ts = Buffer.alloc(7);
    ts.writeUInt16LE(2026, 0);
    ts[2] = 8; ts[3] = 24; ts[4] = 10; ts[5] = 0; ts[6] = 0;

    const payload = Buffer.concat([
      Buffer.from([0x01]), // timestamp flag
      encodeSFloat(95),
      encodeSFloat(88),
      ts,
    ]);

    const { observations } = driver.parse(payload);
    expect(observations[0].effectiveDateTime).toBe('2026-08-24T10:00:00.000Z');
  });

  it('REJECTS a reading the device flagged as poor perfusion', () => {
    const payload = Buffer.concat([
      Buffer.from([0x02]), // measurement status present
      encodeSFloat(99),
      encodeSFloat(70),
      Buffer.from([0x00, 0x01]), // 0x0100 = poor perfusion
    ]);

    const { observations, rejected } = driver.parse(payload);

    // A spurious SpO2 of 99% would MASK hypoxia. Storing nothing is safer
    // than storing a number the device itself does not trust.
    expect(observations).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/poor_perfusion/);
  });

  it('rejects an implausible SpO2 rather than storing it', () => {
    const { observations, rejected } = driver.parse(buildPlxPayload({ spo2: 140, pulse: 70 }));

    expect(observations.map((o) => o.code.coding[0].code)).not.toContain('59408-5');
    expect(rejected.some((r) => /outside the plausible range/.test(r.reason))).toBe(true);
  });

  it('rejects a truncated payload without throwing', () => {
    const { observations, rejected } = driver.parse(Buffer.from([0x00, 0x01]));
    expect(observations).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/too short/i);
  });

  it('rejects a non-buffer without throwing', () => {
    expect(() => driver.parse('nonsense')).not.toThrow();
  });
});

describe('BLE thermometer driver', () => {
  const driver = new BleThermometerDriver();

  it('declares the standard HTS service', () => {
    expect(driver.gattService).toBe('00001809-0000-1000-8000-00805f9b34fb');
  });

  it('parses a Celsius measurement', () => {
    const { observations } = driver.parse(buildTemperaturePayload({ celsius: 38.4 }));

    expect(observations[0].valueQuantity.value).toBeCloseTo(38.4, 2);
    expect(observations[0].valueQuantity.unit).toBe('Cel');
  });

  it('CONVERTS Fahrenheit to Celsius', () => {
    const payload = Buffer.concat([
      Buffer.from([0x01]), // Fahrenheit flag
      encodeFloat(101.2, -1),
    ]);

    const { observations } = driver.parse(payload);

    // Passed through unconverted, 101.2 would be rejected as implausible —
    // and 98.6 would read as a fever that isn't there.
    expect(observations[0].valueQuantity.value).toBeCloseTo(38.44, 1);
    expect(observations[0].meta.convertedFrom).toBe('fahrenheit');
  });

  it('records the measurement site when the device reports it', () => {
    const payload = Buffer.concat([
      Buffer.from([0x04]), // temperature type present
      encodeFloat(37.2, -1),
      Buffer.from([0x09]), // tympanum
    ]);

    expect(driver.parse(payload).observations[0].meta.site).toBe('tympanum');
  });

  it('rejects an implausible temperature', () => {
    const { observations, rejected } = driver.parse(buildTemperaturePayload({ celsius: 55 }));
    expect(observations).toHaveLength(0);
    expect(rejected[0].reason).toMatch(/outside the plausible range/);
  });
});

describe('simulated driver', () => {
  const driver = new SimulatedDeviceDriver();

  it('drives the real parsers, not a shortcut', () => {
    const { observations } = driver.simulate({ spo2: 96, pulse: 80, celsius: 37.1 });
    expect(observations).toHaveLength(3);
  });

  it('marks every observation as SIMULATED', () => {
    const { observations } = driver.simulate({ spo2: 96, pulse: 80 });
    for (const o of observations) {
      expect(o.captureMethod).toBe('simulated');
      expect(o.meta.SIMULATED).toBe(true);
    }
  });

  it('is still subject to the plausibility gate', () => {
    const { observations, rejected } = driver.simulate({ spo2: 200, pulse: 80 });
    expect(observations.map((o) => o.code.coding[0].code)).not.toContain('59408-5');
    expect(rejected.length).toBeGreaterThan(0);
  });
});

describe('device registry — the ports layer', () => {
  const registry = createDeviceRegistry();

  it('lists the registered drivers', () => {
    expect(registry.list().map((d) => d.id).sort()).toEqual([
      'ble-hts',
      'ble-plx',
      'simulated',
    ]);
  });

  it('routes by GATT service UUID', () => {
    expect(registry.findByGattService('00001822-0000-1000-8000-00805F9B34FB').id).toBe(
      'ble-plx',
    );
    expect(registry.findByGattService('0000ffff-0000-1000-8000-00805f9b34fb')).toBeNull();
  });

  it('finds drivers by capability', () => {
    expect(registry.findByCapability('SPO2').map((d) => d.id).sort()).toEqual([
      'ble-plx',
      'simulated',
    ]);
  });

  it('ingests through a named driver', () => {
    const result = registry.ingest({
      driverId: 'ble-plx',
      raw: buildPlxPayload({ spo2: 98, pulse: 66 }),
      deviceId: 'dev-1',
    });
    expect(result.observations).toHaveLength(2);
  });

  it('throws for an unknown driver', () => {
    expect(() => registry.ingest({ driverId: 'nope', raw: Buffer.alloc(5) })).toThrow(
      /Unknown driver/,
    );
  });

  it('does not throw when a driver blows up on a bad payload', () => {
    // A malformed reading from a cheap device must not take down the
    // ingest endpoint for every other clinic.
    const result = registry.ingest({
      driverId: 'simulated',
      raw: Buffer.from('not json'),
    });
    expect(result.observations).toHaveLength(0);
    expect(result.rejected[0].reason).toMatch(/could not be parsed/);
  });

  it('rejects registering the same driver twice', () => {
    expect(() => registry.register(new BlePulseOximeterDriver())).toThrow(/already registered/);
  });
});

describe('plausibility gate', () => {
  it.each(Object.entries(PLAUSIBLE_RANGE))(
    '%s rejects values outside %p',
    (kind, [min, max]) => {
      expect(makeObservation({ kind, value: min - 1, driver: 't' }).ok).toBe(false);
      expect(makeObservation({ kind, value: max + 1, driver: 't' }).ok).toBe(false);
      expect(makeObservation({ kind, value: (min + max) / 2, driver: 't' }).ok).toBe(true);
    },
  );

  it('rejects a null value with a clear reason', () => {
    const result = makeObservation({ kind: 'SPO2', value: null, driver: 't' });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/unavailable/);
  });

  it('rejects NaN and Infinity', () => {
    expect(makeObservation({ kind: 'SPO2', value: NaN, driver: 't' }).ok).toBe(false);
    expect(makeObservation({ kind: 'SPO2', value: Infinity, driver: 't' }).ok).toBe(false);
  });

  it('rejects an unknown observation kind', () => {
    expect(makeObservation({ kind: 'BLOOD_MAGIC', value: 1, driver: 't' }).ok).toBe(false);
  });
});

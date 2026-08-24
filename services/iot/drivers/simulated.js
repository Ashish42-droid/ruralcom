/**
 * Simulated device driver.
 *
 * Exists so the whole ingestion path — transport, driver, normalisation,
 * plausibility gate, persistence, realtime push — is exercisable in CI and
 * demonstrable before any hardware arrives. It emits spec-compliant BLE
 * payloads, so it drives the REAL parsers rather than bypassing them.
 *
 * CLEARLY MARKED AS SIMULATED on every observation, all the way into the
 * database. Nothing it produces may ever be shown as a real measurement.
 */
import { DeviceDriver } from '../DeviceDriver.js';
import { BlePulseOximeterDriver } from './blePulseOximeter.js';
import { BleThermometerDriver } from './bleThermometer.js';

/** Encodes a value as a 16-bit IEEE-11073 SFLOAT. */
export function encodeSFloat(value, exponent = 0) {
  const mantissa = Math.round(value / 10 ** exponent);
  if (mantissa < -2048 || mantissa > 2047) {
    throw new RangeError(`Mantissa ${mantissa} does not fit in 12 bits`);
  }
  const m = mantissa < 0 ? mantissa + 4096 : mantissa;
  const e = exponent < 0 ? exponent + 16 : exponent;
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(((e & 0x0f) << 12) | (m & 0x0fff), 0);
  return buf;
}

/** Encodes a value as a 32-bit IEEE-11073 FLOAT. */
export function encodeFloat(value, exponent = -1) {
  const mantissa = Math.round(value / 10 ** exponent);
  if (mantissa < -8388608 || mantissa > 8388607) {
    throw new RangeError(`Mantissa ${mantissa} does not fit in 24 bits`);
  }
  const m = mantissa < 0 ? mantissa + 0x1000000 : mantissa;
  const buf = Buffer.alloc(4);
  buf[0] = m & 0xff;
  buf[1] = (m >> 8) & 0xff;
  buf[2] = (m >> 16) & 0xff;
  buf[3] = exponent < 0 ? exponent + 256 : exponent;
  return buf;
}

/** Builds a spec-compliant PLX spot-check payload. */
export function buildPlxPayload({ spo2, pulse }) {
  return Buffer.concat([
    Buffer.from([0x00]), // no optional fields present
    encodeSFloat(spo2),
    encodeSFloat(pulse),
  ]);
}

/** Builds a spec-compliant temperature payload in Celsius. */
export function buildTemperaturePayload({ celsius }) {
  return Buffer.concat([Buffer.from([0x00]), encodeFloat(celsius, -1)]);
}

export class SimulatedDeviceDriver extends DeviceDriver {
  constructor() {
    super({
      id: 'simulated',
      displayName: 'Simulated device (NOT REAL DATA)',
      transport: 'simulated',
      capabilities: ['SPO2', 'PULSE', 'BODY_TEMPERATURE'],
    });
    this.plx = new BlePulseOximeterDriver();
    this.hts = new BleThermometerDriver();
  }

  /** @param {object} reading { spo2, pulse, celsius } */
  simulate(reading, context = {}) {
    const observations = [];
    const rejected = [];

    if (reading.spo2 !== undefined && reading.pulse !== undefined) {
      const out = this.plx.parse(
        buildPlxPayload({ spo2: reading.spo2, pulse: reading.pulse }),
        context,
      );
      observations.push(...out.observations);
      rejected.push(...out.rejected);
    }

    if (reading.celsius !== undefined) {
      const out = this.hts.parse(
        buildTemperaturePayload({ celsius: reading.celsius }),
        context,
      );
      observations.push(...out.observations);
      rejected.push(...out.rejected);
    }

    return {
      observations: observations.map((o) => ({
        ...o,
        captureMethod: 'simulated',
        meta: { ...o.meta, SIMULATED: true },
      })),
      rejected,
    };
  }

  parse(raw, context) {
    // Accepts JSON so an HTTP harness can drive it directly.
    const reading = JSON.parse(raw.toString('utf8'));
    return this.simulate(reading, context);
  }
}

export default SimulatedDeviceDriver;

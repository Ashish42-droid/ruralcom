/**
 * BLE Health Thermometer Service driver.
 *
 * Implements the Bluetooth SIG standard profile:
 *   Service 0x1809 — Health Thermometer Service
 *   Characteristic 0x2A1C — Temperature Measurement
 *
 * Layout:
 *   byte 0      flags
 *                 bit 0: units  (0 = Celsius, 1 = Fahrenheit)
 *                 bit 1: timestamp present
 *                 bit 2: temperature type present
 *   bytes 1-4   temperature (FLOAT, 32-bit IEEE-11073)
 *   [7 bytes]   timestamp         if flags bit 1
 *   [1 byte]    temperature type  if flags bit 2
 *
 * Written from the specification, so it works with any compliant device and
 * is testable without hardware.
 */
import { DeviceDriver, makeObservation } from '../DeviceDriver.js';
import { readFloat, readDateTime } from '../ieee11073.js';

const FLAG_FAHRENHEIT = 0x01;
const FLAG_TIMESTAMP = 0x02;
const FLAG_TEMPERATURE_TYPE = 0x04;

/** Measurement site, from the spec's temperature-type enumeration. */
const TEMPERATURE_TYPE = {
  1: 'armpit',
  2: 'body_general',
  3: 'ear',
  4: 'finger',
  5: 'gastrointestinal_tract',
  6: 'mouth',
  7: 'rectum',
  8: 'toe',
  9: 'tympanum',
};

export class BleThermometerDriver extends DeviceDriver {
  constructor() {
    super({
      id: 'ble-hts',
      displayName: 'BLE Health Thermometer (SIG standard profile)',
      transport: 'ble',
      capabilities: ['BODY_TEMPERATURE'],
      gattService: '00001809-0000-1000-8000-00805f9b34fb',
    });
  }

  parse(raw, context = {}) {
    if (!Buffer.isBuffer(raw) || raw.length < 5) {
      return {
        observations: [],
        rejected: [{ reason: 'Payload too short for a temperature measurement' }],
      };
    }

    const flags = raw[0];
    const reading = readFloat(raw, 1);

    let offset = 5;
    let effectiveAt = null;

    if (flags & FLAG_TIMESTAMP) {
      if (raw.length >= offset + 7) effectiveAt = readDateTime(raw, offset);
      offset += 7;
    }

    let site = null;
    if (flags & FLAG_TEMPERATURE_TYPE && raw.length >= offset + 1) {
      site = TEMPERATURE_TYPE[raw[offset]] ?? 'unknown';
    }

    if (reading.special) {
      return {
        observations: [],
        rejected: [{ reason: `Device reported ${reading.special}` }],
      };
    }

    // Normalise to Celsius. The triage rules are written in Celsius, and a
    // Fahrenheit value passed through unconverted would read as profound
    // hypothermia — 98.6 would be nonsense and 37 would look like a fever
    // that isn't there.
    let celsius = reading.value;
    let convertedFrom = null;

    if (flags & FLAG_FAHRENHEIT) {
      celsius = Math.round((((reading.value - 32) * 5) / 9) * 100) / 100;
      convertedFrom = 'fahrenheit';
    }

    const result = makeObservation({
      kind: 'BODY_TEMPERATURE',
      value: celsius,
      effectiveAt,
      deviceId: context.deviceId,
      driver: this.id,
      meta: { site, convertedFrom, flags },
    });

    return result.ok
      ? { observations: [result.observation], rejected: [] }
      : { observations: [], rejected: [{ reason: result.reason }] };
  }
}

export default BleThermometerDriver;

/**
 * BLE Pulse Oximeter Service driver.
 *
 * Implements the Bluetooth SIG standard profile:
 *   Service 0x1822 — Pulse Oximeter Service (PLX)
 *   Characteristic 0x2A5E — PLX Spot-Check Measurement
 *   Characteristic 0x2A5F — PLX Continuous Measurement
 *
 * Spot-check layout:
 *   byte 0        flags
 *   bytes 1-2     SpO2   (SFLOAT, percent)
 *   bytes 3-4     Pulse  (SFLOAT, bpm)
 *   [7 bytes]     timestamp        if flags bit 0
 *   [2 bytes]     measurement status if flags bit 1
 *   [3 bytes]     device+sensor status if flags bit 2
 *   [2 bytes]     pulse amplitude index if flags bit 3
 *
 * This is written from the specification, so it works with ANY compliant
 * device and is fully testable without hardware.
 *
 * IMPORTANT: many cheap consumer oximeters are NOT compliant — they expose
 * proprietary characteristics instead. Those need their own driver, which is
 * exactly what this abstraction is for. Send me the make and model and the
 * nRF Connect characteristic dump and it is a short file.
 */
import { DeviceDriver, makeObservation } from '../DeviceDriver.js';
import { readSFloat, readDateTime } from '../ieee11073.js';

const FLAG_TIMESTAMP = 0x01;
const FLAG_MEASUREMENT_STATUS = 0x02;
const FLAG_DEVICE_SENSOR_STATUS = 0x04;
const FLAG_PULSE_AMPLITUDE_INDEX = 0x08;

/** Measurement-status bits that mean the reading is not trustworthy. */
const UNRELIABLE_STATUS_BITS = {
  0x0020: 'questionable_pulse_detected',
  0x0040: 'signal_processing_irregularity',
  0x0080: 'inadequate_signal',
  0x0100: 'poor_perfusion',
  0x0400: 'artefact_detected',
  0x0800: 'low_perfusion',
};

export class BlePulseOximeterDriver extends DeviceDriver {
  constructor() {
    super({
      id: 'ble-plx',
      displayName: 'BLE Pulse Oximeter (SIG standard profile)',
      transport: 'ble',
      capabilities: ['SPO2', 'PULSE'],
      gattService: '00001822-0000-1000-8000-00805f9b34fb',
    });
  }

  parse(raw, context = {}) {
    const observations = [];
    const rejected = [];

    if (!Buffer.isBuffer(raw) || raw.length < 5) {
      return {
        observations,
        rejected: [{ reason: 'Payload too short for a PLX spot-check measurement' }],
      };
    }

    const flags = raw[0];
    const spo2 = readSFloat(raw, 1);
    const pulse = readSFloat(raw, 3);

    let offset = 5;
    let effectiveAt = null;

    if (flags & FLAG_TIMESTAMP) {
      if (raw.length >= offset + 7) {
        effectiveAt = readDateTime(raw, offset);
      }
      offset += 7;
    }

    let measurementStatus = null;
    const qualityWarnings = [];

    if (flags & FLAG_MEASUREMENT_STATUS) {
      if (raw.length >= offset + 2) {
        measurementStatus = raw.readUInt16LE(offset);
        for (const [bit, label] of Object.entries(UNRELIABLE_STATUS_BITS)) {
          if (measurementStatus & Number(bit)) qualityWarnings.push(label);
        }
      }
      offset += 2;
    }

    if (flags & FLAG_DEVICE_SENSOR_STATUS) offset += 3;
    if (flags & FLAG_PULSE_AMPLITUDE_INDEX) offset += 2;

    // A device that flags poor perfusion or inadequate signal is telling us
    // the number is unreliable. Storing it as a normal reading would be
    // worse than storing nothing — a spurious SpO2 of 99% MASKS hypoxia.
    if (qualityWarnings.length > 0) {
      return {
        observations,
        rejected: [
          {
            reason: `Device reported an unreliable measurement: ${qualityWarnings.join(', ')}`,
            measurementStatus,
          },
        ],
      };
    }

    const meta = { measurementStatus, flags };

    for (const [kind, reading] of [
      ['SPO2', spo2],
      ['PULSE', pulse],
    ]) {
      if (reading.special) {
        rejected.push({
          reason: `${kind}: device reported ${reading.special}`,
        });
        continue;
      }

      const result = makeObservation({
        kind,
        value: reading.value,
        effectiveAt,
        deviceId: context.deviceId,
        driver: this.id,
        meta,
      });

      if (result.ok) observations.push(result.observation);
      else rejected.push({ reason: result.reason });
    }

    return { observations, rejected };
  }
}

export default BlePulseOximeterDriver;

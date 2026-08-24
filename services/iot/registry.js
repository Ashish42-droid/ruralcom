/**
 * Device registry — the "ports" half of the IoT layer.
 *
 * Drivers register their transport, GATT service and capabilities here.
 * Routing a payload is then a lookup, not a switch statement, so adding
 * hardware never touches the ingest path.
 *
 * PROCEDURE FOR ADDING A DEVICE (repeatable, ~1 file):
 *   1. Identify the transport. For BLE, dump services/characteristics with
 *      nRF Connect or similar.
 *   2. Check whether it implements a standard SIG health service. If it
 *      does, the existing ble-plx / ble-hts driver already works — just
 *      register the device.
 *   3. If proprietary, subclass DeviceDriver and implement parse().
 *   4. Register it below with its capability declaration.
 *   5. Add parser unit tests using CAPTURED RAW PAYLOADS. This is the
 *      critical step: CI has no physical hardware, so a saved byte buffer
 *      is the only regression protection the driver will ever get.
 *   6. Confirm the plausibility bounds in DeviceDriver.js suit its outputs.
 */
import { BlePulseOximeterDriver } from './drivers/blePulseOximeter.js';
import { BleThermometerDriver } from './drivers/bleThermometer.js';
import { SimulatedDeviceDriver } from './drivers/simulated.js';
import { DeviceError } from './DeviceDriver.js';
import logger from '../../config/logger.js';

export class DeviceRegistry {
  constructor() {
    this.drivers = new Map();
  }

  register(driver) {
    if (this.drivers.has(driver.id)) {
      throw new DeviceError(`Driver already registered: ${driver.id}`);
    }
    this.drivers.set(driver.id, driver);
    return this;
  }

  get(driverId) {
    const driver = this.drivers.get(driverId);
    if (!driver) {
      throw new DeviceError(`Unknown driver: ${driverId}`, { code: 'UNKNOWN_DRIVER' });
    }
    return driver;
  }

  /** Finds a driver by BLE GATT service UUID. */
  findByGattService(uuid) {
    const target = String(uuid).toLowerCase();
    for (const driver of this.drivers.values()) {
      if (driver.gattService?.toLowerCase() === target) return driver;
    }
    return null;
  }

  /** Drivers producing a given observation kind. */
  findByCapability(kind) {
    return [...this.drivers.values()].filter((d) => d.capabilities.includes(kind));
  }

  list() {
    return [...this.drivers.values()].map((d) => d.describe());
  }

  /**
   * Parses a payload through the named driver.
   *
   * Never throws on a bad payload — a malformed reading from a cheap device
   * must not take down the ingest endpoint. Rejections come back as data so
   * the assistant can be told to re-measure.
   */
  ingest({ driverId, raw, deviceId, requestId }) {
    const driver = this.get(driverId);

    try {
      const { observations, rejected } = driver.parse(raw, { deviceId });

      logger.info(
        {
          driver: driver.id,
          deviceId,
          accepted: observations.length,
          rejected: rejected.length,
          requestId,
        },
        // Values themselves are clinical data and are not logged here.
        'Device payload parsed',
      );

      return { driver: driver.id, observations, rejected };
    } catch (err) {
      logger.error(
        { err, driver: driver.id, deviceId, requestId },
        'Driver threw while parsing a payload',
      );
      return {
        driver: driver.id,
        observations: [],
        rejected: [{ reason: 'Payload could not be parsed by this driver' }],
      };
    }
  }
}

/** The default registry: two standard BLE profiles plus the simulator. */
export function createDeviceRegistry() {
  return new DeviceRegistry()
    .register(new BlePulseOximeterDriver())
    .register(new BleThermometerDriver())
    .register(new SimulatedDeviceDriver());
}

export default { DeviceRegistry, createDeviceRegistry };

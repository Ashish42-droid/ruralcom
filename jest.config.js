/**
 * Jest config for native ESM.
 *
 * `npm test` sets NODE_OPTIONS=--experimental-vm-modules via cross-env,
 * which is what lets Jest load `"type": "module"` sources without Babel.
 */
export default {
  testEnvironment: 'node',
  transform: {},
  testMatch: ['**/tests/**/*.test.js'],
  setupFiles: ['<rootDir>/tests/setup.js'],
  collectCoverageFrom: [
    'controllers/**/*.js',
    'services/**/*.js',
    'middlewares/**/*.js',
    'utils/**/*.js',
    'jobs/**/*.js',
    'sockets/**/*.js',
  ],
  coverageDirectory: 'coverage',
  clearMocks: true,
  // Surfaces handles left open by a test (pools, timers, sockets) instead of
  // letting the run hang.
  detectOpenHandles: true,
  forceExit: false,
  // Suites hold long transactions against a REMOTE Postgres. Round-trip
  // latency makes a tight timeout flaky in a way that looks like a real
  // failure and wastes an afternoon.
  testTimeout: 60_000,
  // Cap parallelism for the same reason: several workers each holding open
  // transactions against one remote database is how the suite starves.
  maxWorkers: 2,
};

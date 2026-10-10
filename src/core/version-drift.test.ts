import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  VERSION_DRIFT_LOG_MSG,
  VERSION_HEADERS,
  createVersionDriftMonitor,
  describeVersionDrift,
  detectVersionDrift,
  pathApiVersion,
} from './version-drift.js';
import { createFakeRedactor } from './fakes/index.js';
import type { LogFields, Logger } from './types.js';

interface Entry {
  readonly level: string;
  readonly msg: string;
  readonly fields?: LogFields;
}

function recordingLogger(): Logger & { readonly entries: readonly Entry[] } {
  const entries: Entry[] = [];
  const at =
    (level: string) =>
    (msg: string, fields?: LogFields): void => {
      entries.push({ level, msg, fields });
    };
  return {
    entries,
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
  };
}

const AUTO_UPGRADE =
  'The call has been auto-upgraded to v25.0 as v24.0 has been deprecated';

test('detectVersionDrift: X-Ad-Api-Version-Warning is a signal on any response', () => {
  const signals = detectVersionDrift(
    { [VERSION_HEADERS.adApiVersionWarning]: AUTO_UPGRADE },
    'v24.0',
    'marketing',
  );
  assert.deepEqual(signals, [
    {
      kind: 'ad-api-version-warning',
      header: 'x-ad-api-version-warning',
      value: AUTO_UPGRADE,
      requestedVersion: 'v24.0',
      api: 'marketing',
    },
  ]);
});

test('detectVersionDrift: a served version different from the requested one is a mismatch', () => {
  const signals = detectVersionDrift(
    { 'facebook-api-version': 'v24.0' },
    'v23.0',
    undefined,
  );
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.kind, 'served-version-mismatch');
  assert.equal(signals[0]?.value, 'v24.0');
  assert.equal(signals[0]?.requestedVersion, 'v23.0');
  // No family on the request means the Graph pin.
  assert.equal(signals[0]?.api, 'graph');
});

test('detectVersionDrift: a matching or absent served version is no signal', () => {
  assert.deepEqual(detectVersionDrift({}, 'v23.0', 'graph'), []);
  assert.deepEqual(
    detectVersionDrift({ 'facebook-api-version': 'v23.0' }, 'v23.0', 'graph'),
    [],
  );
  // `v23` and `v23.0` name the same version.
  assert.deepEqual(
    detectVersionDrift({ 'facebook-api-version': 'v23' }, 'v23.0', 'graph'),
    [],
  );
  assert.deepEqual(
    detectVersionDrift({ 'facebook-api-version': ' ' }, 'v23.0', 'graph'),
    [],
  );
  assert.deepEqual(
    detectVersionDrift({ 'x-ad-api-version-warning': '' }, 'v26.0', 'marketing'),
    [],
  );
});

test('detectVersionDrift: both headers on one response yield both signals', () => {
  const signals = detectVersionDrift(
    { 'x-ad-api-version-warning': AUTO_UPGRADE, 'facebook-api-version': 'v25.0' },
    'v24.0',
    'marketing',
  );
  assert.deepEqual(
    signals.map((s) => s.kind),
    ['ad-api-version-warning', 'served-version-mismatch'],
  );
});

test('pathApiVersion reads the version a path forces, and nothing else', () => {
  assert.equal(pathApiVersion('/v19.0/act_1/campaigns'), 'v19.0');
  assert.equal(pathApiVersion('v20/me'), 'v20');
  assert.equal(pathApiVersion('/v21.0'), 'v21.0');
  assert.equal(pathApiVersion('/act_1/campaigns'), undefined);
  assert.equal(pathApiVersion('/video/v19.0'), undefined);
});

test('the monitor logs one structured warn per (header, value) and keeps the signal', () => {
  const logger = recordingLogger();
  const monitor = createVersionDriftMonitor({ logger, redactor: createFakeRedactor() });
  for (let i = 0; i < 5; i += 1) {
    monitor.observe({ 'x-ad-api-version-warning': AUTO_UPGRADE }, 'v24.0', 'marketing');
  }
  assert.equal(logger.entries.length, 1);
  const entry = logger.entries[0];
  assert.equal(entry?.level, 'warn');
  assert.equal(entry?.msg, VERSION_DRIFT_LOG_MSG);
  assert.equal(entry?.fields?.['kind'], 'ad-api-version-warning');
  assert.equal(entry?.fields?.['header'], 'x-ad-api-version-warning');
  assert.equal(entry?.fields?.['value'], AUTO_UPGRADE);
  assert.equal(entry?.fields?.['requestedVersion'], 'v24.0');
  assert.equal(entry?.fields?.['api'], 'marketing');
  assert.match(String(entry?.fields?.['advice']), /FB_ADS_API_VERSION/);
  assert.equal(monitor.signals().length, 1);
});

test('the monitor logs a NEW value of a header it has already seen', () => {
  const logger = recordingLogger();
  const monitor = createVersionDriftMonitor({ logger, redactor: createFakeRedactor() });
  monitor.observe({ 'facebook-api-version': 'v24.0' }, 'v23.0', 'graph');
  monitor.observe({ 'facebook-api-version': 'v24.0' }, 'v23.0', 'graph');
  monitor.observe({ 'facebook-api-version': 'v25.0' }, 'v23.0', 'graph');
  assert.deepEqual(
    logger.entries.map((e) => e.fields?.['value']),
    ['v24.0', 'v25.0'],
  );
  assert.match(String(logger.entries[0]?.fields?.['advice']), /FB_API_VERSION/);
  assert.equal(monitor.signals().length, 2);
});

test('the monitor redacts the header value before logging or keeping it (C3)', () => {
  const secret = 'EAAsecretTOKEN0123456789';
  const logger = recordingLogger();
  const redactor = createFakeRedactor({ secrets: [secret] });
  const monitor = createVersionDriftMonitor({ logger, redactor });
  monitor.observe(
    { 'x-ad-api-version-warning': `auto-upgraded; token=${secret}` },
    'v24.0',
    'marketing',
  );
  const logged = JSON.stringify(logger.entries);
  assert.ok(!logged.includes(secret));
  assert.match(logged, /\[REDACTED\]/);
  assert.ok(!JSON.stringify(monitor.signals()).includes(secret));
  assert.ok(!describeVersionDrift(monitor.signals()[0]!).includes(secret));
});

test('the monitor clips an oversized header value', () => {
  const logger = recordingLogger();
  const monitor = createVersionDriftMonitor({ logger, redactor: createFakeRedactor() });
  monitor.observe({ 'x-ad-api-version-warning': 'x'.repeat(5000) }, 'v24.0', 'marketing');
  assert.equal(monitor.signals()[0]?.value.length, 300);
});

test('the monitor never throws, even when the logger does', () => {
  const throwing: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => {
      throw new Error('logger down');
    },
    error: () => undefined,
  };
  const monitor = createVersionDriftMonitor({
    logger: throwing,
    redactor: createFakeRedactor(),
  });
  assert.doesNotThrow(() => {
    monitor.observe({ 'x-ad-api-version-warning': AUTO_UPGRADE }, 'v24.0', 'marketing');
  });
});

test('describeVersionDrift names the header, the value, the request and the fix', () => {
  const [signal] = detectVersionDrift(
    { 'x-ad-api-version-warning': AUTO_UPGRADE },
    'v24.0',
    'marketing',
  );
  assert.ok(signal);
  const line = describeVersionDrift(signal);
  assert.match(line, /x-ad-api-version-warning/);
  assert.match(line, /requested v24\.0, Marketing API/);
  assert.match(line, /FB_ADS_API_VERSION/);
  assert.match(line, /app-upkeep\.md §2/);
});

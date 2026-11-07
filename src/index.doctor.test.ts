// Tests for the server bootstrap: the doctor as the bootstrap wires it.
//
// Split out of `index.test.ts` (R17). Shared fixtures, fakes and
// helpers live in `src/testing/harness/server.ts`; the suite-level notes are at its top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFakeClock,
  createFakeFbRequest,
  createFakeRedactor,
  fbErr,
  type FakeFbRequest,
} from './core/fakes/index.js';
import { GraphApiError, loadSettings } from './core/index.js';
import {
  createRegistry,
  renderDoctorReport,
  runDoctor,
  type DoctorReport,
} from './mcp/index.js';
import { createCorePackage } from './tools/index.js';
import {
  adAccountProbe,
  loadedPackages,
  metricProbe,
  serverStartedFields,
} from './index.js';
import {
  ACCESS_TOKEN,
  DEFAULT_PROFILE_SCOPES,
  bootstrapPackages,
  doctorOverBootstrapPackages,
  probePages,
  silentLogger,
} from './testing/harness/server.js';

// ---------------------------------------------------------------------------
// The doctor as the bootstrap wires it
// ---------------------------------------------------------------------------

/** Run the doctor with BOTH bootstrap probes wired, exactly as `main` wires them. */
async function runWiredDoctor(
  fb: FakeFbRequest,
  env: Record<string, string> = {},
): Promise<{ report: DoctorReport; rendered: string }> {
  const { settings } = loadSettings({ env, loadEnvFile: false });
  const redactor = createFakeRedactor({ secrets: [settings.accessToken ?? ''] });
  const report = await runDoctor({
    fbRequest: fb.fn,
    settings,
    clock: createFakeClock(1_760_000_000_000),
    logger: silentLogger,
    redactor,
    packages: [
      createCorePackage({ serverVersion: '1.2.3-test', sdkVersion: '1.29.0-test' }),
    ],
    serverVersion: '1.2.3-test',
    metricProbe: metricProbe(probePages()),
    adAccountProbe: adAccountProbe(),
  });
  return { report, rendered: renderDoctorReport(report) };
}

test('the doctor names the missing credential instead of failing', async () => {
  const fb = createFakeFbRequest();

  // No FB_* at all — the state a first-run operator is actually in.
  const { report, rendered } = await runWiredDoctor(fb, {});

  assert.equal(report.token.configured, false);
  assert.match(report.token.error ?? '', /FB_ACCESS_TOKEN/);
  assert.match(rendered, /facebook-mcp doctor/);
  // No check spends a call it already knows will fail: the token inspection,
  // the ad-account probe and — with no credential to send — the metric probe
  // all stay off the wire, so the only verdict line is the missing token.
  assert.equal(report.adAccount.available, false);
  assert.match(report.adAccount.summary, /FB_AD_ACCOUNT_ID/);
  assert.match(report.metricProbe.summary, /skipped \(no token configured/);
  assert.deepEqual(
    fb.calls.map((call) => call.path),
    [],
  );
});

test('the doctor folds a rejected token into the report rather than throwing', async () => {
  const fb = createFakeFbRequest();
  // Every call fails the way a revoked token fails, including the probes'.
  fb.on(
    () => true,
    fbErr(
      new GraphApiError('Error validating access token: the session is invalid', {
        code: 190,
        type: 'OAuthException',
        httpStatus: 401,
      }),
    ),
  );

  const { report, rendered } = await runWiredDoctor(fb, {
    FB_ACCESS_TOKEN: ACCESS_TOKEN,
  });

  // The whole point of `doctor` is that it still prints when auth is broken.
  assert.equal(report.token.configured, true);
  assert.equal(report.token.valid, false);
  assert.equal(report.metricProbe.available, false);
  assert.match(report.metricProbe.summary, /failed/);
  assert.equal(report.adAccount.available, false);
  // The rendered report is what an operator pastes into an issue — the
  // configured token must not ride along with it.
  assert.ok(
    !rendered.includes(ACCESS_TOKEN),
    'the doctor report leaked the access token',
  );
});

test('a correctly provisioned default install verdicts ok, --strict included', async () => {
  const { report, exitCode } = await doctorOverBootstrapPackages(DEFAULT_PROFILE_SCOPES, [
    '--strict',
  ]);

  // `ads` is off by default, so its scopes are not part of "correctly
  // provisioned" and its row must not exist to be judged.
  assert.equal(
    report.matrix.some((matrixRow) => matrixRow.package === 'ads'),
    false,
    'the doctor judged a package the registry never loads',
  );
  assert.deepEqual(
    report.summary.findings.map((finding) => finding.detail),
    [],
  );
  assert.equal(report.summary.verdict, 'ok');
  // The point of `--strict`: an out-of-box install must be able to pass it, or
  // the flag is one nobody can put in a pipeline.
  assert.equal(exitCode, 0);
});

test('the package narrowing follows the registry, and never costs a report', () => {
  const packages = bootstrapPackages();
  const named = (env: Record<string, string>): readonly string[] => {
    const { settings } = loadSettings({
      env: { FB_SYSTEM_TOKEN: 'EAA-system-token', ...env },
      loadEnvFile: false,
    });
    return loadedPackages(packages, settings).map((pkg) => pkg.name);
  };

  assert.deepEqual(named({ FB_TOOL_PACKAGES: 'ads' }), ['core', 'ads']);
  assert.deepEqual(named({ FB_TOOL_PACKAGES_DENY: 'messages' }), [
    'core',
    'reader',
    'insights',
    'moderation',
    'posts',
  ]);

  // An unknown selection name is a startup error, but the doctor's whole value
  // is that it still prints for an operator whose config is broken — so the
  // narrowing falls back to the full array instead of propagating the throw.
  const { settings: broken } = loadSettings({
    env: { FB_SYSTEM_TOKEN: 'EAA-system-token', FB_TOOL_PACKAGES: 'reader,typo' },
    loadEnvFile: false,
  });
  assert.throws(() => createRegistry(packages, broken));
  assert.deepEqual(
    loadedPackages(packages, broken).map((pkg) => pkg.name),
    packages.map((pkg) => pkg.name),
  );
});

test('the "server started" line names the packages the registry loaded, not every package built', () => {
  const packages = bootstrapPackages();
  const { settings } = loadSettings({
    env: { FB_SYSTEM_TOKEN: 'EAA-system-token' },
    loadEnvFile: false,
  });

  const fields = serverStartedFields('stdio', '1.2.3', packages, settings);

  // `ads` is built on every start but off by default: logging it as started
  // tells the operator the ads tools are there when tools/list has none.
  assert.deepEqual(fields['packages'], [
    'core',
    'reader',
    'insights',
    'moderation',
    'messages',
    'posts',
  ]);
  assert.equal(fields['transport'], 'stdio');
  assert.equal(fields['version'], '1.2.3');
  // Doc 12 H1: both pins are logged, so a support ticket shows which version
  // each API family was called on.
  assert.equal(fields['apiVersion'], 'v26.0');
  assert.equal(fields['adsApiVersion'], 'v26.0');

  const { settings: adsOnly } = loadSettings({
    env: { FB_SYSTEM_TOKEN: 'EAA-system-token', FB_TOOL_PACKAGES: 'ads' },
    loadEnvFile: false,
  });
  assert.deepEqual(serverStartedFields('stdio', '1.2.3', packages, adsOnly)['packages'], [
    'core',
    'ads',
  ]);
});

test('the doctor names an unresolvable package selection instead of judging the full array', async () => {
  // The narrowing above falls back to every package so the report still prints.
  // That is right, and on its own it is also a lie: the operator gets a matrix
  // over seven packages for an install that starts none of them. The command
  // asks separately why the selection failed and folds the answer into the
  // verdict, so `doctor --strict` in a pipeline goes red for a config that
  // cannot boot.
  const { report, text, exitCode } = await doctorOverBootstrapPackages(
    [...DEFAULT_PROFILE_SCOPES],
    ['--strict'],
    { FB_PACKAGES_DENY: 'reeder' },
  );

  assert.equal(report.summary.verdict, 'fail');
  assert.equal(exitCode, 2);
  const finding = report.summary.findings.find((f) => f.area === 'configuration');
  assert.ok(finding, 'expected a configuration finding');
  // Which variable — the deny list, not the allow list that is perfectly fine.
  assert.match(finding.detail, /FB_PACKAGES_DENY/);
  assert.match(finding.detail, /"reeder"/);
  assert.match(text, /WILL NOT START/);
});

test('a resolvable selection leaves the doctor with nothing to say about configuration', async () => {
  const { report, text } = await doctorOverBootstrapPackages(
    [...DEFAULT_PROFILE_SCOPES],
    [],
    {
      FB_TOOL_PACKAGES_DENY: 'messages',
    },
  );

  assert.equal(
    report.summary.findings.some((f) => f.area === 'configuration'),
    false,
  );
  assert.doesNotMatch(text, /WILL NOT START/);
});

test('a configuration the server refuses to start on fails the doctor, --strict included (wave 9)', async () => {
  // `loadSettings` is the bootstrap's own judgement of the configuration, and
  // `assertStartupOk` refuses to start the server on any error in it. The
  // doctor runs BEFORE that assertion (so it can still report on a broken
  // install) — which meant the startup report was computed and then thrown
  // away on the doctor path, and `doctor --strict` exited 0 for a server that
  // would not start. FB_TRANSPORT=http without FB_HTTP_TOKEN is such an error.
  const { report, text, exitCode } = await doctorOverBootstrapPackages(
    [...DEFAULT_PROFILE_SCOPES],
    ['--strict'],
    { FB_TRANSPORT: 'http' },
  );

  const finding = report.summary.findings.find((f) => f.area === 'configuration');
  assert.ok(finding, 'expected a configuration finding for the startup error');
  assert.equal(finding.severity, 'fail');
  assert.match(finding.detail, /FB_HTTP_TOKEN/);
  assert.equal(report.summary.verdict, 'fail');
  assert.equal(exitCode, 2);
  assert.match(text, /WILL NOT START/);
  assert.match(text, /\[FAIL {3}\] configuration: .*FB_HTTP_TOKEN/);

  // A warning-severity startup problem the doctor does not judge on its own
  // (no app secret) is a warning here as well: on a real start the server
  // logs it, and the doctor is the one path where it was said nowhere.
  const warned = await doctorOverBootstrapPackages(
    [...DEFAULT_PROFILE_SCOPES],
    ['--strict'],
    {
      FB_APP_SECRET: '',
    },
  );
  const warning = warned.report.summary.findings.find((f) => f.area === 'configuration');
  assert.ok(warning, 'expected a configuration finding for the startup warning');
  assert.equal(warning.severity, 'warn');
  assert.match(warning.detail, /FB_APP_SECRET/);
  assert.equal(warned.report.summary.verdict, 'warn');
  assert.equal(warned.exitCode, 1);
});

test('an ads scope on a default install is over-scope', async () => {
  const { report } = await doctorOverBootstrapPackages([
    ...DEFAULT_PROFILE_SCOPES,
    'ads_management',
  ]);

  // The over-scope check exists to catch a runtime token carrying a privilege
  // nothing loaded can use. `ads_management` on an install whose `ads` package
  // is off is exactly that, and it stays exactly that until the operator turns
  // the package on.
  assert.deepEqual(report.overScopePermissions, ['ads_management']);
});

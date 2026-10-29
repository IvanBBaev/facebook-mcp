// main — the real process bootstrap: resolves Settings from the environment,
// constructs the concrete core collaborators, assembles the package array,
// then runs `doctor` / `setup-token` or starts the selected transport with
// SIGINT/SIGTERM graceful shutdown. `runCli` wraps it with the top-level
// failure handling; the self-run guard lives in `src/index.ts`.

import {
  assertStartupOk,
  createFbRequest,
  createHostSemaphores,
  createLogger,
  createPagesRegistry,
  createRedactor,
  createSavedReplyStore,
  createUploadHandler,
  createVersionDriftMonitor,
  defaultActivityStatePath,
  errorMessageOf,
  loadSettings,
  savedRepliesPath,
  setHintLaunchCommand,
  type Clock,
  type FbRequestFn,
  type LogFields,
  type Logger,
  type PackageSpec,
  type Redactor,
  type Settings,
  type StartupReport,
  type UsageSnapshot,
  type VersionDriftMonitor,
} from '../core/index.js';
import {
  createActivityStateStore,
  createJournal,
  parseSetupTokenArgs,
  renderSetupTokenReport,
  runSetupToken,
  startTransport,
} from '../mcp/index.js';
import { resolveLaunchCommand } from '../mcp/launch-command.js';
import {
  createAdsPackage,
  createCorePackage,
  createInsightsPackage,
  createMessagesPackage,
  createModerationPackage,
  createPageAdminPackage,
  createPostsPackage,
  createReaderPackage,
} from '../tools/index.js';
import { createUsageTracker } from '../tools/core.js';
import { cliLogLevel, isVersionFlag, usageText, wantsHelp } from './cli-args.js';
import {
  adAccountProbe,
  loadedPackages,
  metricProbe,
  runDoctorCommand,
} from './doctor.js';
import { buildServer } from './handlers.js';
import {
  resolvePackageName,
  resolveServerVersion,
  resolveSdkVersion,
  versionLine,
} from './version.js';

// ---------------------------------------------------------------------------
// main — the real process bootstrap
// ---------------------------------------------------------------------------

/**
 * System clock: real time + an abortable sleep (mirrors the transport fixture).
 * A completed sleep detaches its abort listener: callers pass the long-lived
 * per-request signal, and a polling loop would otherwise accumulate one listener
 * per sleep for the lifetime of the request.
 */
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('aborted'));
        return;
      }
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};

/**
 * Hand every warning-severity startup problem to the logger, one WARN each.
 *
 * `assertStartupOk` renders the warnings only inside the error it throws, so on
 * a clean start — the common case — an operator whose Page token is bound to no
 * Page, or whose app secret is unset, saw nothing at all. The fields mirror
 * `StartupProblem` so a log consumer can key on the stable `code`.
 */
export function logStartupWarnings(logger: Logger, report: StartupReport): void {
  for (const problem of report.warnings) {
    logger.warn('startup config warning', {
      code: problem.code,
      ...(problem.field !== undefined ? { field: problem.field } : {}),
      message: problem.message,
    });
  }
}

/** Collect every configured secret VALUE so the redactor can scrub it (C3). */
function collectSecrets(settings: Settings): string[] {
  const secrets: string[] = [];
  const push = (value: string | undefined): void => {
    if (typeof value === 'string' && value.length > 0) secrets.push(value);
  };
  push(settings.accessToken);
  push(settings.systemToken);
  push(settings.pageToken);
  push(settings.appSecret);
  push(settings.httpToken);
  push(settings.confirmToken);
  if (settings.appId !== undefined && settings.appSecret !== undefined) {
    push(`${settings.appId}|${settings.appSecret}`);
  }
  for (const profile of Object.values(settings.profiles)) {
    push(profile.tokenOverride);
  }
  return secrets;
}

/**
 * The fields of the one `facebook-mcp server started` line.
 *
 * `packages` names what the registry actually LOADED, not every package the
 * bootstrap built: selection, the deny-list and the default expansion all
 * happen inside the registry, so the built array always lists `ads` — which
 * is off by default. An operator reading this line to learn why a tool is
 * missing was told the package serving it was running.
 */
export function serverStartedFields(
  transport: string,
  serverVersion: string,
  packages: readonly PackageSpec[],
  settings: Settings,
): LogFields {
  return {
    transport,
    version: serverVersion,
    apiVersion: settings.apiVersion,
    adsApiVersion: settings.adsApiVersion,
    packages: loadedPackages(packages, settings).map((pkg) => pkg.name),
  };
}

/**
 * The production Graph transport: the JSON client with the multipart / rupload
 * handler wired in, both sharing ONE per-host semaphore set so upload traffic
 * and JSON calls honor a single concurrency budget. Without the upload handler
 * every local-file photo, video chunk and reel upload rejects before it is sent.
 * `onUsage` receives the usage headers of every response on both paths, and
 * ONE `versionDrift` monitor reads the version headers on both, so a drift
 * signal is logged once per process however many calls carry it.
 */
export function createTransport(deps: {
  readonly settings: Settings;
  readonly clock: Clock;
  readonly redactor: Redactor;
  readonly logger: Logger;
  readonly onUsage?: (snapshot: UsageSnapshot) => void;
  readonly versionDrift?: VersionDriftMonitor;
}): FbRequestFn {
  const versionDrift =
    deps.versionDrift ??
    createVersionDriftMonitor({ logger: deps.logger, redactor: deps.redactor });
  const semaphores = createHostSemaphores(deps.settings.hostConcurrency);
  const uploadHandler = createUploadHandler({ ...deps, semaphores, versionDrift });
  return createFbRequest({ ...deps, semaphores, uploadHandler, versionDrift });
}

/**
 * Real bootstrap: resolve settings, build collaborators, then run `doctor` or
 * start the transport. Never called by tests (they drive {@link buildServer}).
 * `onStarted` is called once the transport is up, so {@link runCli} can tell a
 * server that never came up from one that stopped later.
 */
async function main(onStarted: () => void = () => undefined): Promise<void> {
  const serverVersion = resolveServerVersion();
  const sdkVersion = resolveSdkVersion();

  // `--version` answers BEFORE settings are loaded: a bug reporter asked for the
  // version is usually looking at an install that will not start, and a flag that
  // needs a working credential to tell you its own version is useless exactly
  // then. stdout is right here — nothing else will ever be written to it on this
  // path, so no JSON-RPC frame can be corrupted (G-TOOL-5).
  if (isVersionFlag(process.argv[2])) {
    process.stdout.write(`${versionLine(serverVersion, sdkVersion)}\n`);
    process.exit(0);
  }
  // Hints — the help, the CLI reports and the Graph error texts — name the
  // command the operator can actually type. Resolved before `--help`, which
  // prints it, and injected into the core classifier, which cannot import it.
  const launchCommand = resolveLaunchCommand({
    env: process.env,
    argv: process.argv,
    packageName: resolvePackageName(),
  });
  setHintLaunchCommand(launchCommand);
  if (wantsHelp(process.argv.slice(2))) {
    process.stdout.write(usageText(resolvePackageName(), launchCommand));
    process.exit(0);
  }

  const { settings, report } = loadSettings();

  const clock = systemClock;
  const redactor = createRedactor({ secrets: collectSecrets(settings) });
  const logger = createLogger({
    clock,
    redactor,
    level: cliLogLevel(process.argv[2], settings.logLevel),
  });
  // Every Graph response feeds facebook_usage, not only its own `/me` probe:
  // the probe never carries the Page and ads buckets that throttle real work.
  const usageTracker = createUsageTracker();
  // One version-drift monitor per process: the transport logs each distinct
  // signal once, and `doctor` reports what its own probes saw.
  const versionDrift = createVersionDriftMonitor({ logger, redactor });
  const fbRequest = createTransport({
    settings,
    clock,
    redactor,
    logger,
    onUsage: usageTracker.record,
    versionDrift,
  });
  const journal = createJournal({ clock, redactor, journalPath: settings.journalPath });
  const activityState = createActivityStateStore({
    statePath: settings.activityStatePath ?? defaultActivityStatePath(),
  });
  const savedReplies = createSavedReplyStore({ filePath: savedRepliesPath(), clock });
  const pages = createPagesRegistry({ settings, fbRequest, clock, redactor, logger });

  // --- Package assembly -----------------------------------------------------
  // Declaration order is the order tools are advertised to the client, so it runs
  // read-only-first (core, reader, insights) before the write-gated packages. The
  // registry then applies selection / deny-list / read-only posture from
  // `settings`; no other change here is required as further packages land.
  const packages: PackageSpec[] = [
    createCorePackage({
      serverVersion,
      sdkVersion,
      observedUsage: usageTracker.observed,
    }),
    createReaderPackage(),
    createInsightsPackage(),
    createModerationPackage(),
    createMessagesPackage(),
    createPostsPackage(),
    createAdsPackage(),
    createPageAdminPackage(),
  ];

  // `doctor` subcommand: emit the diagnostic report to STDERR (never stdout) and
  // exit BEFORE the fail-closed assertion, so it still reports when the token is
  // missing (the doctor never throws for an auth/scope problem). What that
  // assertion would have thrown on still reaches the verdict: the startup
  // report is handed to the doctor rather than dropped on this path. The exit
  // code stays 0 unless `--strict` was passed — see {@link doctorExitCode}.
  if (process.argv[2] === 'doctor') {
    const doctor = await runDoctorCommand(
      {
        fbRequest,
        settings,
        clock,
        logger,
        redactor,
        packages,
        serverVersion,
        metricProbe: metricProbe(pages),
        adAccountProbe: adAccountProbe(),
        versionDrift,
        launchCommand,
      },
      process.argv.slice(3),
      report,
    );
    process.stderr.write(`${doctor.text}\n`);
    process.exit(doctor.exitCode);
  }

  // `setup-token` subcommand: the guided onboarding that MINTS the credential,
  // so like `doctor` it must run before the fail-closed assertion — requiring a
  // configured token to obtain a token would be a deadlock. Report to STDERR
  // (stdout belongs to the stdio transport) and exit non-zero when the flow
  // failed, so a wrapper script can branch on it.
  if (process.argv[2] === 'setup-token') {
    const setupResult = await runSetupToken({
      fbRequest,
      settings,
      clock,
      logger,
      redactor,
      input: parseSetupTokenArgs(process.argv.slice(3), process.env, launchCommand),
      launchCommand,
    });
    process.stderr.write(`${renderSetupTokenReport(setupResult)}\n`);
    process.exit(setupResult.ok ? 0 : 2);
  }

  // Fail closed on error-severity config problems (missing token; http w/o token).
  assertStartupOk(report);
  // Then surface the warning-severity ones, which the assertion never prints on
  // a start it lets through (stderr — stdout is the stdio channel, CC-CFG-1).
  logStartupWarnings(logger, report);

  const controller = new AbortController();
  const server = buildServer({
    settings,
    packages,
    serverVersion,
    clock,
    logger,
    redactor,
    journal,
    activityState,
    savedReplies,
    fbRequest,
    pages,
  });

  const handle = await startTransport(server, settings, {
    logger,
    signal: controller.signal,
  });

  // Graceful shutdown: aborting the controller drives the transport's own
  // shutdown path (close listener + unwind in-flight work — CC-MCP-5). The
  // handlers go in BEFORE the "server started" line: that line is the readiness
  // signal a supervisor acts on, and a signal landing between it and the
  // registration would hit Node's default handler and kill the process uncleanly.
  const requestShutdown = (signal: NodeJS.Signals): void => {
    logger.info('shutdown signal received', { signal });
    controller.abort();
  };
  process.once('SIGINT', requestShutdown);
  process.once('SIGTERM', requestShutdown);

  logger.info(
    'facebook-mcp server started',
    serverStartedFields(handle.kind, serverVersion, packages, settings),
  );
  onStarted();

  await handle.closed;
}

/**
 * Process entry point, with the top-level failure handling attached.
 *
 * Exported because the published binary is `bin/facebook-mcp.mjs`, which imports
 * `src/index.ts`: through that launcher `process.argv[1]` is the shim's path,
 * never the entry module's, so its self-run guard cannot fire. The launcher therefore
 * calls this explicitly. Both paths funnel through one function so a packaged
 * install and a `node build/index.js` run behave identically — a silently
 * exiting binary is the worst possible first impression.
 */
export async function runCli(
  entry: CliEntry = main,
  io: CliIo = processIo,
): Promise<void> {
  // Everything after the transport came up — a transport that dies mid-session,
  // a shutdown that throws — is not a startup failure, and calling it one sends
  // the operator to check the token and settings of a server that started fine.
  let started = false;
  try {
    await entry(() => {
      started = true;
    });
  } catch (err: unknown) {
    const what = started ? 'stopped unexpectedly' : 'failed to start';
    io.writeStderr(`facebook-mcp ${what}: ${errorMessageOf(err)}\n`);
    io.exit(1);
  }
}

/** What {@link runCli} runs: a bootstrap that reports when it has started. */
export type CliEntry = (onStarted: () => void) => Promise<void>;

/** The process seams {@link runCli} reports a fatal error through. */
export interface CliIo {
  readonly writeStderr: (text: string) => void;
  readonly exit: (code: number) => void;
}

/** The real process streams and exit. */
const processIo: CliIo = {
  writeStderr: (text) => {
    process.stderr.write(text);
  },
  exit: (code) => {
    process.exit(code);
  },
};

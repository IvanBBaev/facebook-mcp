// Public surface of the server layer (top of `core <- api <- mcp <- tools <-
// cli <- server`). `src/index.ts` re-exports exactly this set.

export { buildServer, type BuildServerDeps } from './handlers.js';
export {
  systemClock,
  logStartupWarnings,
  serverStartedFields,
  createTransport,
  runCli,
  type CliEntry,
  type CliIo,
} from './bootstrap.js';
export { resolveSdkVersion, versionLine, type SdkVersionSources } from './version.js';
export {
  isVersionFlag,
  isHelpFlag,
  wantsHelp,
  usageText,
  cliLogLevel,
  isStrictFlag,
} from './cli-args.js';
export {
  loadedPackages,
  packageSelectionFault,
  runDoctorCommand,
  adAccountProbe,
  metricProbe,
} from './doctor.js';

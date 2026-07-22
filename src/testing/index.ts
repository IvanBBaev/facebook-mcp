// Public barrel for shared test infrastructure (task F03).
//
// Colocated `*.test.ts` files (this task's and downstream Wave-2+ tasks') import
// these helpers from here. NOTE: the C13 network fence (`./network-fence.js`) is
// intentionally NOT re-exported, because importing it installs a throwing global
// `fetch` as a side effect. Import the fence directly (or wire it via
// `node --import`) only where that baseline is intended.

export { withEnv, type EnvOverrides } from './with-env.js';
export {
  withFetch,
  type FetchMock,
  type FetchMatcher,
  type RecordedRequest,
  type ResponseSpec,
  type CapturedBody,
  type CapturedFilePart,
} from './with-fetch.js';
export {
  loadFixture,
  fixtureUrl,
  findSecrets,
  assertNoSecrets,
  lintFixtureDir,
  assertFixturesClean,
  FixtureSecretError,
  FIXTURES_DIR,
  type SecretFinding,
  type SecretRule,
} from './fixtures.js';

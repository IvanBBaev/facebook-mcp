// Test-only in-memory fakes for the core contracts (task F02).
//
// Other tasks' tests import these instead of hand-rolling mocks of a sibling's
// internals (coordination rule 6). Fakes depend only on core contract TYPES —
// no api/mcp/tools imports, no network, no real timers.

export { createFakeClock, type FakeClock } from './fakeClock.js';
export { createFakeRedactor, type FakeRedactor } from './fakeRedactor.js';
export { createMemoryJournal, type MemoryJournal } from './memoryJournal.js';
export {
  createFakePageResolver,
  type FakePageResolver,
  type FakePageResolverConfig,
} from './fakePageResolver.js';
export {
  createFakeFbRequest,
  fbOk,
  fbErr,
  type FakeFbRequest,
  type FbMatcher,
  type FbStubResult,
} from './fakeFbRequest.js';

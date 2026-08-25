# Graph API fixtures

Committed JSON captures of **real** Graph API responses, redacted, used by the
hermetic unit suite. They exist so tests assert against shapes Meta actually
returns rather than shapes we imagined (task F03).

Anything in this directory is **public repository content**. Treat every byte
here as published.

## What belongs here

- A response body from a **read** edge, recorded once and pruned to what a test
  needs. `graph-me.json` (`/me`) and `graph-feed.json` (`/{page-id}/feed`) are
  the current set.
- Synthetic bodies are fine too — a fixture does not have to come from the wire.
  What matters is that a fixture never claims to be a recording it is not.

## What does not

- **No secrets.** Not a token, not an app secret, not an `appsecret_proof`, not
  a paging `next` URL that still carries `access_token=…`. This is enforced, not
  merely asked for — see the lint below.
- **No write-endpoint recordings.** Recording a write means performing one; that
  is the live smoke harness's job (`scripts/smoke/`), which has a sweeper to
  clean up after itself. The recorder here is GET-only by construction.
- **No real Page or person data** you did not intend to publish — names, message
  bodies, comment text, profile IDs. Redaction scrubs secret _shapes_; it cannot
  know that a post message was private.

## Recording one

```bash
npm run build   # the recorder imports the compiled client from build/
FB_RECORD_FIXTURE=1 node scripts/record-fixture.mjs \
  --endpoint "me?fields=id,name" --out graph-me.json
```

`scripts/record-fixture.mjs` reaches Graph through the **same** `createFbRequest`
the server uses, so the host allowlist, the pinned API version, token placement
and the error matrix cannot fork from what we ship. It refuses to run without
`FB_RECORD_FIXTURE=1`, takes its credential from the environment only (never a
`--token` flag — a token on a command line is visible via `ps` and lands in shell
history), and will not overwrite an existing fixture without `--force`.

Every recording is passed through value-based redaction and then through the
fixture-lint **before** it is written, so a capture that would fail the suite is
never put on disk. That is not a licence to skip reading the diff: always eyeball
a new fixture before committing it.

## The fixture-lint

`src/testing/fixtures.ts` scans every `*.json` file in this directory and fails
the test suite on five secret shapes:

| Rule                    | Fires on                                           |
| ----------------------- | -------------------------------------------------- |
| `eaa-access-token`      | `EAA` followed by 16+ token characters             |
| `appsecret-proof-64hex` | a bounded 64-hex run                               |
| `app-secret-32hex`      | a bounded 32-hex run                               |
| `access-token-field`    | any `access_token` key with a non-empty string     |
| `app-access-token-pipe` | the `{app-id}\|{app-secret}` app-access-token form |

Findings report a **non-leaking** description (length + first four characters),
never the value. Value-based redaction in `core` is the primary defense; this
lint is the belt-and-braces guard that stops a raw recording from ever being
committed.

Consequence for test authors: placeholder tokens in fixtures and in tests must
not look like the real thing. Use short, obviously-fake strings.

## Using one in a test

```ts
import { loadFixture } from '../testing/fixtures.js';

const me = await loadFixture<{ id: string; name: string }>('graph-me.json');
```

`fixtureUrl(name)` resolves a name against this directory if you need the path
itself. Both resolve relative to the **compiled** module location, so they work
unchanged from `build/`.

Tests run behind a network fence (`build/testing/network-fence.js`) that throws
on any real network call — a fixture is the only way a test sees a Graph-shaped
response. Live-only checks belong in `scripts/smoke/`, outside the test glob.

## When the API version moves

Shape-diffing these fixtures against the new version's responses is a required
step of the pin bump — a field that changed type or disappeared is the entire
point of it. See [`../../docs/runbooks/app-upkeep.md`](../../docs/runbooks/app-upkeep.md).

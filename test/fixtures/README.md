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

## Recording the ads set

The `ads` tools ride a separate Marketing API pin (`FB_ADS_API_VERSION`), so
their fixtures are versioned by that pin, one directory per version:

```text
test/fixtures/ads/<ads-version>/   e.g. test/fixtures/ads/v26.0/
  ads-account.json     GET /act_<id>                 (account read)
  ads-campaigns.json   GET /act_<id>/campaigns       (listing, limit 5)
  ads-adsets.json      GET /act_<id>/adsets          (listing, limit 5)
  ads-ads.json         GET /act_<id>/ads             (listing, limit 5)
  ads-campaign.json    GET /<first listed campaign>  (object read)
  ads-adset.json       GET /<first listed ad set>    (object read)
  ads-ad.json          GET /<first listed ad>        (object read)
  ads-insights.json    GET /act_<id>/insights        (sync insights, last_30d)
```

```bash
npm run build
FB_RECORD_FIXTURE=1 FB_AD_ACCOUNT_ID=act_<id> node scripts/record-fixture.mjs --ads
```

`--ads` records that fixed read set in one run, with the field sets the tools
request (taken from the compiled `build/api/ads-read.js`, so a recording cannot
drift from what we ship), every request tagged for the ads pin. It is read-only:
the async report start (`POST /act_<id>/insights`) is deliberately not recorded.
The same gate, credential rules, `--force` rule and lint-before-write apply; the
directory is refused as a whole if any of its files exists without `--force`.

- **No ad account, no run.** Without `FB_AD_ACCOUNT_ID` (environment or env
  file) the run prints `skipped: …` and exits `0` before touching a credential
  or the network. A malformed value is refused without echoing it.
- **Anonymised, not just redacted.** Ad data is business data, so after the
  secret redaction every ad identifier is replaced: ids (`id`, `*_id`, and any
  6+ digit run inside other strings or keys) become consistent fake ids across
  the whole run (`act_` prefix kept), `name` becomes `REDACTED_NAME_<n>`, paging
  URLs and cursors become placeholders, and every numeric string — budgets,
  bids, spend, impressions — becomes `"100"` (or `"1.5"` when it has a decimal
  point). JSON types are preserved, so the shape-diff still sees the real shape.
  Free text the anonymiser cannot recognise (e.g. a `body`, a creative title) is
  still yours to read and prune before committing.
- **An empty listing** (an account with no ad sets, say) skips that level's
  object read, says so, and records the rest.

## The fixture-lint

`src/testing/fixtures.ts` scans every `*.json` file in this directory (and its
subdirectories, so `ads/<ads-version>/` is covered) and fails
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

`npm run fixtures:shape-diff` (`scripts/fixture-shape-diff.mjs`) does the
comparison. It is offline: it compares two fixture sets you already have and
never touches the network. Produce the candidate set by snapshotting the current
fixtures and re-recording each one against the new version:

```bash
npm run build
cp -R test/fixtures "${TMPDIR:-/tmp}/fixtures-baseline"   # the known-good shapes
FB_RECORD_FIXTURE=1 FB_API_VERSION=v24.0 node scripts/record-fixture.mjs \
  --endpoint "me?fields=id,name,category,tasks" --out graph-me.json --force
# ...repeat for every fixture, with the endpoint and fields it was recorded from
npm run fixtures:shape-diff -- \
  --baseline "${TMPDIR:-/tmp}/fixtures-baseline" --candidate test/fixtures
git checkout -- test/fixtures   # unless you mean to keep (and prune) the new captures
```

For an **ads** pin bump no snapshot is needed: the ads fixtures are already
versioned by directory, so record the new version next to the old one and diff
the two directories:

```bash
npm run build
FB_RECORD_FIXTURE=1 FB_AD_ACCOUNT_ID=act_<id> FB_ADS_API_VERSION=v27.0 \
  node scripts/record-fixture.mjs --ads
npm run fixtures:shape-diff -- \
  --baseline test/fixtures/ads/v26.0 --candidate test/fixtures/ads/v27.0
```

If there is no baseline directory for the current ads pin yet, record one first
(the same command without `FB_ADS_API_VERSION`, which then defaults to the pin).

Directories are matched by file name (two files are compared directly); `--json`
gives a machine-readable report. Only **shapes** are compared — keys and JSON
types, with every string (ids, numeric strings, timestamps) one type and id-valued
keys collapsed to `<id>` — and no fixture value is ever printed.

| Category                | Meaning                                    | Fails the run |
| ----------------------- | ------------------------------------------ | ------------- |
| `removed`               | a baseline field is gone                   | yes           |
| `type-changed`          | a field's non-null JSON type changed       | yes           |
| `array-element-changed` | an array's element type changed            | yes           |
| `nullability-changed`   | a field became, or stopped being, nullable | no (warning)  |
| `added`                 | a field only the candidate has             | no (info)     |

Exit status: `0` no breaking difference, `1` breaking difference, `2` usage or
input error (bad arguments, unreadable path, invalid JSON, no common file name).
A fresh recording is unpruned, so expect `added` lines; and shapes are inferred
from samples, so a `removed` field may only be absent from this sample (a feed
with no shared links has no `story`). Explain every breaking line before moving
the pin.

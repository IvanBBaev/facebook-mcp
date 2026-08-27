// Metadata SSOT for facebook-mcp (task R01).
//
// This file is the ONE place identity, distribution metadata and the `FB_*`
// environment surface are written down. `gen-metadata.mjs` projects it into
// every artifact that would otherwise drift apart:
//
//   package.json            (metadata fields only — never scripts/dependencies)
//   server.json             (official MCP registry manifest)
//   manifest.json           (MCPB / Claude Desktop bundle manifest)
//   .claude-plugin/*.json   (Claude Code plugin + marketplace manifests)
//   .env.example            (the operator-facing env template)
//   README.md               (the `<!-- BEGIN GENERATED: … -->` blocks)
//
// Nothing here is read at runtime by the server: the server resolves its own
// version from `package.json` and its settings from `src/core/settings.ts`.
// The drift test (`src/metadata.test.ts`) checks the projection stayed true.
//
// RULE: when a new `FB_*` variable is added to `src/core/settings.ts`, add it
// to `env` below. The drift test parses the settings source and fails if the
// two disagree — that is the point.

/**
 * @typedef {object} EnvVar
 * @property {string} name                 The `FB_*` variable name.
 * @property {string} group                Section heading in `.env.example`.
 * @property {'one-of' | 'no' | 'http'} required
 *   `one-of` — at least one of the token trio; `http` — required only when
 *   `FB_TRANSPORT=http`; `no` — optional.
 * @property {boolean} secret              Never logged, never in a tool result.
 * @property {string} [default]            Documented default, as text.
 * @property {boolean} [defaultIsProse]    The `default` above DESCRIBES the default
 *                                         instead of quoting it ("XDG state path"),
 *                                         so it must never be projected into
 *                                         `server.json` / `manifest.json`: an
 *                                         installer pre-fills those fields and the
 *                                         operator would save a value the server
 *                                         refuses to start with.
 * @property {readonly string[]} [choices] Enumerated values, when applicable.
 * @property {'string' | 'number' | 'filepath'} format  Registry value format.
 * @property {string} summary              One line for the README table.
 * @property {string} description          Full text for server.json / .env.example.
 * @property {string} [example]            Placeholder value in `.env.example`.
 * @property {string} [userConfig]         MCPB `user_config` key; omitted ⇒ not exposed.
 * @property {string} [userConfigTitle]    MCPB `user_config` display title.
 * @property {boolean} [setupOnly]         Read by a subcommand, never by the running
 *                                         server ⇒ documented for the operator but
 *                                         kept out of `server.json`, so no MCP client
 *                                         prompts for it as a runtime value.
 */

/** Identity + distribution metadata. */
export const identity = Object.freeze({
  /**
   * npm package name (scoped fallback per doc 02 §Naming).
   *
   * The scope is the npm account `ivanbaev` — ONE `b`, unlike the GitHub user
   * `IvanBBaev`. Publishing under a scope the account does not own fails with a
   * 404 on PUT, which npm returns instead of a 403 so it does not leak which
   * scopes exist; the error is indistinguishable from a token with too narrow a
   * permission set. Do not "correct" this to match the repository owner.
   */
  packageName: '@ivanbaev/facebook-mcp',
  /** Official MCP registry identity; must ship in the first npm publish. */
  mcpName: 'io.github.IvanBBaev/facebook-mcp',
  /** Bare name used by the plugin manifests, the MCPB bundle and the binary. */
  shortName: 'facebook-mcp',
  /** Human-facing name in client UIs. */
  displayName: 'Facebook Pages MCP',
  /** The key an MCP client uses in its `mcpServers` map. */
  serverKey: 'facebook',
  version: '0.7.0',
  license: 'MIT',
  nodeEngine: '>=22',
  author: {
    name: 'Ivan Baev',
    email: 'ivanbbaev@gmail.com',
    url: 'https://github.com/IvanBBaev',
  },
  repository: 'https://github.com/IvanBBaev/facebook-mcp',
  homepage: 'https://github.com/IvanBBaev/facebook-mcp#readme',
  documentation: 'https://ivanbbaev.github.io/facebook-mcp/',
  issues: 'https://github.com/IvanBBaev/facebook-mcp/issues',
  /** Long form — package.json, plugin.json, MCPB `long_description`. */
  description:
    'Local-first TypeScript MCP server for the Meta Graph API that lets an MCP ' +
    'client publish, read and moderate Facebook Pages through your own Meta ' +
    'developer app, with least-privilege tokens, plan-and-apply write safety and ' +
    'no telemetry.',
  /**
   * Short form — registry listings and directory cards. The MCP registry schema
   * caps `description` at 100 characters, so this must stay under that.
   */
  shortDescription:
    'Facebook Pages MCP server for the Meta Graph API — publishing, insights, moderation, messaging',
  keywords: [
    'mcp',
    'model-context-protocol',
    'facebook',
    'meta',
    'graph-api',
    'pages',
    'llm',
    'ai',
  ],
  trademark:
    'This is an independent, community-built project and is not affiliated with, ' +
    'endorsed by, or sponsored by Meta Platforms, Inc. Facebook, Meta and related ' +
    'marks are trademarks of Meta Platforms, Inc., used here only nominatively to ' +
    'indicate compatibility.',
});

/**
 * The `FB_*` surface, in `.env.example` order. Must stay in lockstep with
 * `src/core/settings.ts` — enforced by `src/metadata.test.ts`.
 * @type {readonly EnvVar[]}
 */
export const env = Object.freeze([
  // --- Credentials ---------------------------------------------------------
  {
    name: 'FB_SYSTEM_TOKEN',
    group: 'Credentials — provide at least one token',
    required: 'one-of',
    secret: true,
    format: 'string',
    summary:
      '**Secret.** System User token (Business Manager). Recommended; wins over the other two.',
    description:
      'System-user access token (Business Manager). Takes precedence over FB_ACCESS_TOKEN and FB_PAGE_TOKEN when several are set.',
    example: '',
    userConfig: 'system_token',
    userConfigTitle: 'System User token',
  },
  {
    name: 'FB_ACCESS_TOKEN',
    group: 'Credentials — provide at least one token',
    required: 'one-of',
    secret: true,
    format: 'string',
    summary: '**Secret.** Meta user access token (a long-lived one preferred).',
    description:
      'Primary user access token. At least one of FB_SYSTEM_TOKEN, FB_ACCESS_TOKEN or FB_PAGE_TOKEN must be set.',
    example: '',
    userConfig: 'access_token',
    userConfigTitle: 'User access token',
  },
  {
    name: 'FB_PAGE_TOKEN',
    group: 'Credentials — provide at least one token',
    required: 'one-of',
    secret: true,
    format: 'string',
    summary: '**Secret.** Long-lived Page token — the no-Business-Manager fallback.',
    description:
      'Long-lived Page access token used as a fallback credential when no user or system-user token is configured.',
    example: '',
    userConfig: 'page_token',
    userConfigTitle: 'Page access token',
  },
  {
    name: 'FB_APP_ID',
    group: 'Meta app',
    required: 'no',
    secret: false,
    format: 'string',
    summary:
      'Meta app ID. With `FB_APP_SECRET` it forms the app token used to inspect tokens.',
    description:
      'Meta app ID; combined with FB_APP_SECRET it forms the app access token used to authorize /debug_token inspection.',
    example: '',
    userConfig: 'app_id',
    userConfigTitle: 'Meta app ID',
  },
  {
    name: 'FB_APP_SECRET',
    group: 'Meta app',
    required: 'no',
    secret: true,
    format: 'string',
    summary:
      '**Secret.** When set, `appsecret_proof` is attached so a stolen bare token is unusable.',
    description:
      'Meta app secret. When set, appsecret_proof is attached to every call so a stolen bare token cannot be used on its own.',
    example: '',
    userConfig: 'app_secret',
    userConfigTitle: 'Meta app secret',
  },

  // --- Page topology -------------------------------------------------------
  {
    name: 'FB_PAGE_ID',
    group: 'Page topology',
    required: 'no',
    secret: false,
    format: 'string',
    summary: 'Default Page ID for Page-scoped tools when a call omits `profile`.',
    description:
      'Default Facebook Page ID, used when a tool call omits an explicit profile argument.',
    example: '',
    userConfig: 'page_id',
    userConfigTitle: 'Default Page ID',
  },

  // --- Wire ----------------------------------------------------------------
  {
    name: 'FB_API_VERSION',
    group: 'Graph API wire',
    required: 'no',
    secret: false,
    default: 'v23.0',
    format: 'string',
    summary:
      'Graph API version to pin. Off-default values are accepted, but only the default is tested.',
    description:
      'Graph API version to target. Defaults to the tested pinned version; other values are accepted verbatim as an escape hatch but are not tested.',
    example: 'v23.0',
  },
  {
    name: 'FB_REQUEST_TIMEOUT_MS',
    group: 'Graph API wire',
    required: 'no',
    secret: false,
    default: '60000',
    format: 'number',
    summary: 'Per-request timeout in milliseconds (1–600000).',
    description: 'Per-request timeout in milliseconds; integer in [1, 600000].',
    example: '60000',
  },
  {
    name: 'FB_HOST_CONCURRENCY',
    group: 'Graph API wire',
    required: 'no',
    secret: false,
    default: '4',
    format: 'number',
    summary: 'Max parallel requests per Graph host (1–64).',
    description:
      'Maximum number of in-flight requests per Graph host; integer in [1, 64].',
    example: '4',
  },
  {
    name: 'FB_MAX_RESULT_CHARS',
    group: 'Graph API wire',
    required: 'no',
    secret: false,
    default: '25000',
    format: 'number',
    summary: 'Character budget before a tool result is truncated (500–10000000).',
    description:
      'Character budget applied by the result shaper before a tool result is truncated; integer in [500, 10000000].',
    example: '25000',
  },

  // --- Write safety --------------------------------------------------------
  {
    name: 'FB_WRITE_MODE',
    group: 'Write safety',
    required: 'no',
    secret: false,
    default: 'plan',
    choices: ['plan', 'apply'],
    format: 'string',
    summary:
      '`plan` (default) previews a write without mutating; `apply` executes. Never covers the irreversible/spend tiers.',
    description:
      'Write gating mode: plan (validating dry-run preview, the default) or apply. It never covers the irreversible and spend tiers, which always need a per-call apply plus a plan_id.',
    example: 'plan',
    userConfig: 'write_mode',
    userConfigTitle: 'Write mode',
  },
  {
    name: 'FB_CONFIRM_TOKEN',
    group: 'Write safety',
    required: 'no',
    secret: true,
    format: 'string',
    summary:
      '**Secret.** Out-of-band confirmation token authorizing gated write / spend actions, for clients that cannot prompt.',
    description:
      'Operator confirmation token for out-of-band approval of irreversible or spend actions. The server prompts through MCP elicitation where the client supports it; otherwise the caller passes this value as the confirm_token tool argument.',
    example: '',
  },
  {
    name: 'FB_MEDIA_DIR',
    group: 'Write safety',
    required: 'no',
    secret: false,
    format: 'filepath',
    summary:
      'Directory permitted as a source for local media uploads. Unset ⇒ URL-only, local file access disabled.',
    description:
      'Directory permitted for local media uploads. Unset means URL-only uploads and no local file access at all.',
    example: '',
    userConfig: 'media_dir',
    userConfigTitle: 'Local media directory',
  },
  {
    name: 'FB_JOURNAL_PATH',
    group: 'Write safety',
    required: 'no',
    secret: false,
    default: 'XDG / %APPDATA% state path',
    defaultIsProse: true,
    format: 'filepath',
    summary: 'Path to the append-only, rotating write journal (0600).',
    description:
      'Path to the append-only write journal. Defaults to the XDG/%APPDATA% state path; the file is created owner-only (0600) and rotates by size.',
    example: '',
  },

  // --- Tool surface --------------------------------------------------------
  {
    name: 'FB_TOOL_PACKAGES',
    group: 'Tool surface',
    required: 'no',
    secret: false,
    default: 'core profile (all packages except `ads`)',
    defaultIsProse: true,
    format: 'string',
    summary:
      'Comma-separated packages or profiles to enable. `core` is always forced on; `ads` is opt-in.',
    description:
      'Comma-separated tool packages or profiles to expose (e.g. core,posts,reader, or the profiles core|all|reader|publisher|moderator|ads). Omit for the default profile, which excludes ads.',
    example: '',
    userConfig: 'tool_packages',
    userConfigTitle: 'Tool packages',
  },
  {
    name: 'FB_PACKAGES_DENY',
    group: 'Tool surface',
    required: 'no',
    secret: false,
    format: 'string',
    summary: 'Packages to exclude even if enabled by `FB_TOOL_PACKAGES`.',
    description:
      'Comma-separated packages to exclude even when FB_TOOL_PACKAGES enables them. Deny wins over allow.',
    example: '',
  },
  {
    name: 'FB_PACKAGES_READONLY',
    group: 'Tool surface',
    required: 'no',
    secret: false,
    format: 'string',
    summary: 'Packages whose write tools are not registered; their read tools stay.',
    description:
      'Comma-separated packages whose write tools are not registered at all; the read tools of those packages stay available.',
    example: '',
  },

  // --- Transport -----------------------------------------------------------
  {
    name: 'FB_TRANSPORT',
    group: 'Transport',
    required: 'no',
    secret: false,
    default: 'stdio',
    choices: ['stdio', 'http'],
    format: 'string',
    summary:
      '`stdio` (default) or `http` (loopback-only Streamable HTTP for local agent clients).',
    description:
      'Transport protocol: stdio (default) or http. The http transport binds 127.0.0.1 only and fails closed without FB_HTTP_TOKEN.',
    example: 'stdio',
  },
  {
    name: 'FB_HTTP_TOKEN',
    group: 'Transport',
    required: 'http',
    secret: true,
    format: 'string',
    summary:
      '**Secret.** Bearer token required by the `http` transport; it fails closed without it.',
    description:
      'Bearer token guarding the HTTP transport; required when FB_TRANSPORT=http (the server refuses to start without it).',
    example: '',
  },
  {
    name: 'FB_HTTP_PORT',
    group: 'Transport',
    required: 'no',
    secret: false,
    default: '3000',
    format: 'number',
    summary:
      'TCP port for the `http` transport (the bind host is fixed to loopback `127.0.0.1`).',
    description:
      'Port for the HTTP transport (loopback only); used when FB_TRANSPORT=http. Integer in [1, 65535].',
    example: '3000',
  },

  // --- Ads (opt-in) --------------------------------------------------------
  {
    name: 'FB_AD_ACCOUNT_ID',
    group: 'Ads (opt-in package, off by default)',
    required: 'no',
    secret: false,
    format: 'string',
    summary: 'Ad account ID for the opt-in `ads` package.',
    description:
      'Default ad account ID (act_… or the bare numeric id) for the opt-in ads package.',
    example: '',
  },
  {
    name: 'FB_ADS_BUDGET_CEILING',
    group: 'Ads (opt-in package, off by default)',
    required: 'no',
    secret: false,
    format: 'number',
    summary:
      'Hard budget ceiling for ads writes, in minor currency units (non-negative integer).',
    description:
      'Hard ceiling for any ads budget write, in minor currency units (e.g. cents). Non-negative integer; a write above it is refused.',
    example: '',
  },

  // --- Diagnostics ---------------------------------------------------------
  {
    name: 'FB_LOG_LEVEL',
    group: 'Diagnostics',
    required: 'no',
    secret: false,
    default: 'info',
    choices: ['debug', 'info', 'warn', 'error'],
    format: 'string',
    summary: 'Stderr log verbosity: `debug`, `info`, `warn`, `error`.',
    description:
      'Stderr log verbosity: debug, info, warn or error. Logs never go to stdout — that is the stdio protocol channel.',
    example: 'info',
  },

  // --- Setup only ----------------------------------------------------------
  // Read by the `setup-token` subcommand, never by the running server, so it is
  // documented for the operator but kept out of server.json — an MCP client has
  // no business prompting for a value the server never looks up.
  {
    name: 'FB_SETUP_TOKEN',
    group: 'Setup only — read by the `setup-token` subcommand, not by the server',
    required: 'no',
    secret: true,
    setupOnly: true,
    format: 'string',
    summary:
      '**Secret.** Short-lived user token consumed once by `setup-token`; the safe alternative to passing it as a CLI argument.',
    description:
      'Short-lived user access token read by the setup-token subcommand when exchanging it for a long-lived Page token. Prefer this over passing the token as a command-line argument, where ps and the shell history can see it. The running server never reads this variable.',
    example: '',
  },
]);

/**
 * Variables whose NAME is dynamic, so they cannot be listed literally. They are
 * documented in `.env.example` as commented placeholders and are deliberately
 * excluded from the strict settings ↔ `.env.example` set comparison (the
 * placeholder `<NAME>` makes them unparseable as a concrete key).
 * @type {readonly {pattern: string, description: string, secret: boolean}[]}
 */
export const dynamicEnv = Object.freeze([
  {
    pattern: 'FB_PROFILE_<NAME>_PAGE_ID',
    description:
      'Page ID for a named profile, e.g. FB_PROFILE_BRAND_A_PAGE_ID. The profile key is the lower-cased <NAME>; pass it as the `profile` argument of a Page-scoped tool.',
    secret: false,
  },
  {
    pattern: 'FB_PROFILE_<NAME>_TOKEN',
    description:
      'Optional per-profile token override for the matching FB_PROFILE_<NAME>_PAGE_ID.',
    secret: true,
  },
]);

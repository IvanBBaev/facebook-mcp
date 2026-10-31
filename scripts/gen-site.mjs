// Marker splicing plus the GitHub Pages site and onboarding-runbook blocks of the
// metadata generator (task I-A4, DX-01 / DX-04 / DX-07).
//
// `docs/index.html` is hand-written HTML, and for a long time it was also the
// one public surface outside the generator: it went on advertising a version, a
// tool count and a package count the server had long outgrown. Its prose stays
// hand-written; every FACT on it — version, release stage, Node floor, Graph
// API pin, tool / package / tier counts, the package and permission tables, the
// env table, the install and client snippets, the `.mcpb` attestation filename
// and the JSON-LD — lives between `<!-- BEGIN GENERATED: id -->` and
// `<!-- END GENERATED -->` markers and is rewritten from the SSOT here.
//
// Everything in this module is pure: `gen-metadata.mjs` gathers the facts
// (SSOT + compiled inventory) and owns the file I/O.

/** Thrown for expected, operator-actionable failures: reported without a stack. */
export class GenError extends Error {}

const BEGIN_RE = /<!-- BEGIN GENERATED: ([a-z0-9-]+) -->/g;
const END = '<!-- END GENERATED -->';

/**
 * Replace the body of every `<!-- BEGIN GENERATED: id -->` … `<!-- END GENERATED -->`
 * pair in `text`. An id may appear any number of times; every occurrence gets
 * the same body.
 *
 * A body is either
 * - a string — inserted verbatim between the markers, wrapped in `pad`
 *   (`'\n\n'` for markdown, `''` for inline HTML such as a number inside a
 *   sentence or the contents of a `<pre>`), or
 * - `{ lines: string[] }` — a block: each line is indented to the column of its
 *   BEGIN marker, which must then stand alone at the start of its line.
 *
 * Fails loudly on a marker the caller does not own, an unclosed marker, and a
 * block the text never mentions: a silently skipped block is exactly the drift
 * this generator exists to prevent.
 *
 * @param {string | undefined} text
 * @param {Record<string, string | {lines: string[]}>} blocks
 * @param {{label: string, pad?: string}} options
 */
export function spliceBlocks(text, blocks, { label, pad = '' }) {
  if (text === undefined) throw new GenError(`${label} is missing.`);
  const seen = new Set();
  let out = '';
  let cursor = 0;
  BEGIN_RE.lastIndex = 0;
  let match;
  while ((match = BEGIN_RE.exec(text)) !== null) {
    const [begin, id] = match;
    const bodyStart = match.index + begin.length;
    const stop = text.indexOf(END, bodyStart);
    const nextBegin = text.indexOf('<!-- BEGIN GENERATED:', bodyStart);
    if (stop === -1 || (nextBegin !== -1 && nextBegin < stop)) {
      throw new GenError(`${label}: \`${begin}\` is never closed by \`${END}\`.`);
    }
    if (!Object.hasOwn(blocks, id)) {
      throw new GenError(
        `${label}: unknown generated block \`${id}\` — this generator does not own it.`,
      );
    }
    seen.add(id);
    const body = blocks[id];
    let rendered;
    if (typeof body === 'string') {
      rendered = `${pad}${body}${pad}`;
    } else {
      const lineStart = text.lastIndexOf('\n', match.index) + 1;
      const indent = text.slice(lineStart, match.index);
      if (!/^[ \t]*$/.test(indent)) {
        throw new GenError(
          `${label}: block \`${id}\` must start on its own line (it renders as lines).`,
        );
      }
      const lines = body.lines.map((line) => (line === '' ? '' : `${indent}${line}`));
      rendered = `\n${lines.join('\n')}\n${indent}`;
    }
    out += text.slice(cursor, bodyStart) + rendered;
    cursor = stop;
    BEGIN_RE.lastIndex = stop;
  }
  out += text.slice(cursor);
  for (const id of Object.keys(blocks)) {
    if (!seen.has(id)) {
      throw new GenError(
        `${label} has no \`<!-- BEGIN GENERATED: ${id} -->\` marker. Add the marker ` +
          'pair around the section this generator owns.',
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

/** Escape text for an HTML text node or a double-quoted attribute. */
export function esc(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The tiny markdown subset the SSOT uses (`code`, **strong**) → escaped HTML. */
export function mdInline(text) {
  return String(text)
    .split('`')
    .map((part, i) =>
      i % 2 === 1
        ? `<code>${esc(part)}</code>`
        : esc(part).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>'),
    )
    .join('');
}

/** Visible text of an HTML fragment: comments and tags dropped, entities decoded. */
export function textOf(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
];

/** `8` → `eight` (falls back to digits past twelve). */
export function numberWord(n) {
  return WORDS[n] ?? String(n);
}

const capitalize = (s) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const code = (s) => `<code>${esc(s)}</code>`;

/** `a`, `a and b`, `a, b and c`. */
function listOf(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Wrap prose to `width` columns (the site's hand-written paragraphs are wrapped
 * at roughly 88). Breaks only on spaces, never inside a tag.
 */
function wrap(html, width = 76) {
  const words = html.split(' ');
  const lines = [];
  let line = '';
  let inTag = false;
  for (const word of words) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (line !== '' && !inTag && candidate.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
    // A space inside an open tag (`<a href=…>`) is not a safe break point.
    const opens = (word.match(/</g) ?? []).length;
    const closes = (word.match(/>/g) ?? []).length;
    if (opens > closes) inTag = true;
    else if (closes > opens) inTag = false;
  }
  if (line !== '') lines.push(line);
  return lines;
}

/** A `<p>` with wrapped, indented content. */
function paragraph(html, attrs = '') {
  return [`<p${attrs}>`, ...wrap(html).map((l) => `  ${l}`), '</p>'];
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

/** `read` for a read-only tool, otherwise the declared write tier. */
function tierOf(tool) {
  return tool.annotations?.readOnlyHint === true ? 'read' : (tool.writeTier ?? 'write');
}

/**
 * Everything the site states as a fact, computed once.
 *
 * @param {{identity: object, inventory: object, graphVersion: string}} input
 */
export function siteFacts({ identity, inventory, graphVersion }) {
  const packages = inventory.packages;
  const tools = packages.flatMap((p) => p.tools);
  const tiers = { read: 0, reversible: 0, irreversible: 0, spend: 0 };
  for (const tool of tools) {
    const tier = tierOf(tool);
    if (!Object.hasOwn(tiers, tier)) {
      throw new GenError(`tool ${tool.name} has unknown tier \`${tier}\`.`);
    }
    tiers[tier] += 1;
  }
  const major = Number(identity.version.split('.')[0]);
  const nodeFloor = /^>=\s*(\d+)/.exec(identity.nodeEngine)?.[1];
  if (nodeFloor === undefined) {
    throw new GenError(`identity.nodeEngine \`${identity.nodeEngine}\` is not ">=N".`);
  }
  return {
    version: identity.version,
    stage: major === 0 ? 'pre-1.0' : `v${major}`,
    nodeFloor,
    graphVersion,
    toolCount: tools.length,
    readCount: tiers.read,
    writeCount: tools.length - tiers.read,
    tiers,
    packageCount: packages.length,
    defaultOn: packages.filter((p) => p.enabledByDefault).map((p) => p.name),
    optIn: packages.filter((p) => !p.enabledByDefault).map((p) => p.name),
    coreProfileSize: inventory.defaultPackages.length,
    launch: `npx -y ${identity.packageName}`,
    bundleName: `${identity.packageName.split('/').pop()}-${identity.version}.mcpb`,
  };
}

// ---------------------------------------------------------------------------
// Site blocks
// ---------------------------------------------------------------------------

function renderMetaDescription(f) {
  return {
    lines: [
      '<meta',
      '  name="description"',
      `  content="An open-source, local-first MCP server that lets your AI assistant drive a Facebook Page through the Meta Graph API — publishing, insights, moderation and Messenger replies, with least-privilege tokens and tiered plan-and-apply writes. TypeScript, MIT, Node ${f.nodeFloor}+."`,
      '/>',
    ],
  };
}

function renderBadges(f) {
  return {
    lines: [
      '<span class="badge hi">TypeScript</span>',
      '<span class="badge">MIT</span>',
      `<span class="badge">Node ${f.nodeFloor}+</span>`,
      `<span class="badge">Graph API ${esc(f.graphVersion)}</span>`,
      `<span class="badge">${f.toolCount} tools · ${f.packageCount} packages</span>`,
      `<span class="badge warn">v${esc(f.version)} on npm · ${f.stage}</span>`,
    ],
  };
}

function renderStats(f) {
  return {
    lines: [
      `<div><b>${f.toolCount}</b><span>tools in ${f.packageCount} packages</span></div>`,
      `<div><b>${f.readCount} / ${f.writeCount}</b><span>read tools / write tools</span></div>`,
      '<div><b>3</b><span>hosts the process may reach</span></div>',
      '<div><b>0</b><span>telemetry calls, by design</span></div>',
    ],
  };
}

function renderStatus(f) {
  return {
    lines: paragraph(
      `<strong>Status, honestly.</strong> All ${numberWord(f.packageCount)} packages ` +
        'are implemented and covered by hermetic tests, but every one of those tests ' +
        'runs against fakes and recorded fixtures behind a network fence. Version ' +
        `${esc(f.version)} is published on npm with provenance — published, implemented ` +
        'and tested in isolation, not proven in production. Nothing has been verified ' +
        `against the live Graph API yet. Treat this as a ${f.stage} project.`,
      ' class="note warn" style="margin-top: 32px"',
    ),
  };
}

function renderInstallIntro(f, identity) {
  return {
    lines: paragraph(
      `The package is on npm as ${code(identity.packageName)} — one <code>b</code> in ` +
        'the scope, unlike the GitHub user <code>IvanBBaev</code> — so <code>npx</code> ' +
        `fetches it and there is no install step. Node ${f.nodeFloor} or newer. ` +
        'Building from source stays supported if you would rather compile it yourself.',
      ' class="sub"',
    ),
  };
}

/** Escape for a text node only (quotes stay literal, as in the hand-written snippets). */
const escText = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A JSON key in the site's syntax-highlighted `<pre>` snippets. */
const key = (k) => `<span class="p">"${escText(k)}"</span>`;

/** Render a client config as highlighted JSON (keys wrapped, values escaped). */
function highlightedJson(value, depth = 0) {
  const pad = '  '.repeat(depth + 1);
  const close = '  '.repeat(depth);
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v !== 'object')) {
      return `[${value.map((v) => escText(JSON.stringify(v))).join(', ')}]`;
    }
    return `[\n${value.map((v) => `${pad}${highlightedJson(v, depth + 1)}`).join(',\n')}\n${close}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).map(
      ([k, v]) => `${pad}${key(k)}: ${highlightedJson(v, depth + 1)}`,
    );
    return `{\n${entries.join(',\n')}\n${close}}`;
  }
  return escText(JSON.stringify(value));
}

function clientConfigs(identity) {
  const args = ['-y', identity.packageName];
  const placeholderToken = '<system-user-token>';
  const pageId = '1234567890';
  return {
    claude: {
      mcpServers: {
        [identity.serverKey]: {
          command: 'npx',
          args,
          env: {
            FB_SYSTEM_TOKEN: placeholderToken,
            FB_PAGE_ID: pageId,
            FB_WRITE_MODE: 'plan',
          },
        },
      },
    },
    // VS Code keys servers under `servers` (not `mcpServers`) and can prompt
    // for a secret through `inputs` instead of storing it in the file.
    vscode: {
      inputs: [
        {
          type: 'promptString',
          id: 'fb-system-token',
          description: 'Facebook System User token',
          password: true,
        },
      ],
      servers: {
        [identity.serverKey]: {
          type: 'stdio',
          command: 'npx',
          args,
          env: {
            FB_SYSTEM_TOKEN: '${input:fb-system-token}',
            FB_PAGE_ID: pageId,
          },
        },
      },
    },
    cursor: {
      mcpServers: {
        [identity.serverKey]: {
          command: 'npx',
          args,
          env: { FB_SYSTEM_TOKEN: placeholderToken, FB_PAGE_ID: pageId },
        },
      },
    },
  };
}

function packageRows(inventory) {
  const lines = [];
  for (const pkg of inventory.packages) {
    const reads = pkg.tools.filter((t) => tierOf(t) === 'read').length;
    const writes = pkg.tools.length - reads;
    const tags = [
      ...(reads > 0 ? [`<span class="tag read">${reads} read</span>`] : []),
      ...(writes > 0 ? [`<span class="tag write">${writes} write</span>`] : []),
    ];
    lines.push(
      '<tr>',
      `  <td>${code(pkg.name)}</td>`,
      pkg.enabledByDefault
        ? '  <td><span class="tag on">on</span></td>'
        : '  <td><span class="tag">opt-in</span></td>',
      tags.length === 1 ? `  <td>${tags[0]}</td>` : '  <td>',
      ...(tags.length === 1 ? [] : [...tags.map((t) => `    ${t}`), '  </td>']),
      `  <td>${pkg.writeModeDefault === undefined ? '—' : code(pkg.writeModeDefault)}</td>`,
      '  <td>',
      ...wrap(mdInline(pkg.description ?? '')).map((l) => `    ${l}`),
      '  </td>',
      '</tr>',
    );
  }
  return { lines };
}

function permissionRows(inventory) {
  const lines = [];
  for (const pkg of inventory.packages) {
    const perms = inventory.packagePermissions[pkg.name] ?? [];
    lines.push(
      '<tr>',
      `  <td>${code(pkg.name)}</td>`,
      '  <td>',
      ...wrap(
        perms.length === 0 ? '<em>(not mapped)</em>' : perms.map(code).join(', '),
      ).map((l) => `    ${l}`),
      '  </td>',
      '</tr>',
    );
  }
  return { lines };
}

function envRows(env, dynamicEnv, firstSentence) {
  const lines = [];
  const row = (name, def, description) =>
    lines.push(
      '<tr>',
      `  <td>${code(name)}</td>`,
      `  <td>${def}</td>`,
      '  <td>',
      ...wrap(description).map((l) => `    ${l}`),
      '  </td>',
      '</tr>',
    );
  for (const v of env) {
    const def =
      v.default === undefined
        ? '—'
        : v.defaultIsProse
          ? mdInline(v.default)
          : code(v.default);
    row(v.name, def, mdInline(v.summary));
  }
  for (const v of dynamicEnv) {
    row(
      v.pattern,
      '—',
      mdInline(`${v.secret ? '**Secret.** ' : ''}${firstSentence(v.description)}`),
    );
  }
  return { lines, count: env.length + dynamicEnv.length };
}

function renderFaqStatus(f) {
  const names = listOf([...f.defaultOn, ...f.optIn].map(code));
  const optIn = listOf(f.optIn.map(code));
  return {
    lines: [
      ...paragraph(
        `All ${numberWord(f.packageCount)} tool packages are implemented: ` +
          `${f.toolCount} tools across ${names}. ${capitalize(numberWord(f.defaultOn.length))} ` +
          `are on by default; ${optIn} ${f.optIn.length === 1 ? 'is' : 'are'} opt-in via ` +
          '<code>FB_TOOL_PACKAGES</code>.',
      ),
      ...paragraph(
        `Version ${esc(f.version)} is published on npm, but the project is still ` +
          `${f.stage} and the automated test suite runs entirely against fakes and ` +
          'recorded fixtures behind a network fence — no behaviour has been verified ' +
          'against the live Graph API yet. A manual smoke harness exists for exactly ' +
          'that, gated behind <code>FB_SMOKE=1</code> and never run in CI.',
      ),
    ],
  };
}

function renderFaqNpm(f, identity) {
  return {
    lines: [
      ...paragraph(
        `Yes. The package is ${code(identity.packageName)} — the npm scope carries one ` +
          '<code>b</code>, unlike the GitHub user <code>IvanBBaev</code> — and version ' +
          `${esc(f.version)} is the current <code>latest</code>, so ${code(f.launch)} runs ` +
          'the server without an install step. It was published with npm provenance by ' +
          'the OIDC release workflow from the tagged commit.',
      ),
      ...paragraph(
        'The same rail ships the <code>.mcpb</code> desktop bundle on the ' +
          `<code>v${esc(f.version)}</code> GitHub Release, with a build-provenance ` +
          'attestation you can check yourself using ' +
          `<code>gh attestation verify ${esc(f.bundleName)} --repo IvanBBaev/facebook-mcp</code>, ` +
          `and the MCP registry listing ${code(identity.mcpName)} is live. It is still a ` +
          `${f.stage} release: published, implemented and tested in isolation, not ` +
          'proven in production. Building from source stays supported as an alternative.',
      ),
    ],
  };
}

/**
 * The JSON-LD graph. The FAQ half is read back from the visible
 * `<details id="faq-…">` entries of the page itself, so the structured data can
 * only ever say what a reader of the page sees.
 */
function renderJsonLd(f, identity, pageHtml) {
  const faq = [];
  const re =
    /<details id="faq-[a-z0-9-]+">\s*<summary>([\s\S]*?)<\/summary>\s*<div class="details-body">([\s\S]*?)<\/div>\s*<\/details>/g;
  let m;
  while ((m = re.exec(pageHtml)) !== null) {
    faq.push({
      '@type': 'Question',
      name: textOf(m[1]),
      acceptedAnswer: { '@type': 'Answer', text: textOf(m[2]) },
    });
  }
  if (faq.length === 0) {
    throw new GenError('docs/index.html: no `<details id="faq-…">` entries to mirror.');
  }
  const graph = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'SoftwareApplication',
        name: identity.shortName,
        alternateName: 'Facebook Pages MCP Server',
        applicationCategory: 'DeveloperApplication',
        applicationSubCategory: 'MCP Server',
        operatingSystem: `Cross-platform (Node.js ${f.nodeFloor}+)`,
        description: identity.description,
        url: identity.documentation,
        codeRepository: identity.repository,
        license: `https://opensource.org/licenses/${identity.license}`,
        programmingLanguage: 'TypeScript',
        softwareVersion: identity.version,
        downloadUrl: `https://www.npmjs.com/package/${identity.packageName}`,
        author: {
          '@type': 'Person',
          name: identity.author.name,
          url: identity.author.url,
        },
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        isAccessibleForFree: true,
      },
      { '@type': 'FAQPage', mainEntity: faq },
    ],
  };
  // `</` would end the script element early; JSON allows the escaped form.
  const json = JSON.stringify(graph, null, 2).replace(/<\//g, '<\\/');
  return {
    lines: [
      '<script type="application/ld+json">',
      ...json.split('\n').map((l) => `  ${l}`),
      '</script>',
    ],
  };
}

/**
 * Rewrite every generated block of `docs/index.html`.
 *
 * @param {string | undefined} currentHtml
 * @param {{identity: object, env: readonly object[], dynamicEnv: readonly object[],
 *   inventory: object, graphVersion: string, firstSentence: (s: string) => string}} input
 */
export function renderSite(currentHtml, input) {
  const { identity, inventory } = input;
  const f = siteFacts(input);
  const env = envRows(input.env, input.dynamicEnv, input.firstSentence);
  const clients = clientConfigs(identity);
  const label = 'docs/index.html';

  const blocks = {
    'meta-description': renderMetaDescription(f),
    stage: f.stage,
    badges: renderBadges(f),
    stats: renderStats(f),
    status: renderStatus(f),
    'install-intro': renderInstallIntro(f, identity),
    launch: escText(f.launch),
    'client-claude': highlightedJson(clients.claude),
    'client-vscode': highlightedJson(clients.vscode),
    'client-cursor': highlightedJson(clients.cursor),
    'packages-heading': `${capitalize(numberWord(f.packageCount))} packages, ${f.toolCount} tools`,
    'core-profile-size': numberWord(f.coreProfileSize),
    'plan-default-packages': listOf(
      inventory.packages
        .filter((p) => p.writeModeDefault === 'plan')
        .map((p) => code(p.name)),
    ),
    'packages-table': packageRows(inventory),
    'tool-count': String(f.toolCount),
    'tier-read': plural(f.tiers.read, 'tool'),
    'tier-reversible': plural(f.tiers.reversible, 'tool'),
    'tier-irreversible': plural(f.tiers.irreversible, 'tool'),
    'tier-spend': plural(f.tiers.spend, 'tool'),
    'permissions-table': permissionRows(inventory),
    'env-count': String(env.count),
    'env-table': { lines: env.lines },
    'faq-status': renderFaqStatus(f),
    'faq-npm': renderFaqNpm(f, identity),
  };

  // Two passes: the JSON-LD mirrors the visible FAQ, so it is rendered from the
  // page AFTER the FAQ blocks have been brought up to date.
  const withoutJsonLd = spliceBlocks(
    currentHtml,
    { ...blocks, jsonld: { lines: [] } },
    {
      label,
    },
  );
  return spliceBlocks(
    withoutJsonLd,
    { ...blocks, jsonld: renderJsonLd(f, identity, withoutJsonLd) },
    { label },
  );
}

// ---------------------------------------------------------------------------
// Onboarding runbook — scope table (DX-07)
// ---------------------------------------------------------------------------

/**
 * Scope → the packages that need it, plus whether `setup-token` refuses
 * without it. Scopes are listed in first-use order across the package order.
 *
 * @returns {string} an unaligned markdown table (the caller formats it)
 */
export function renderOnboardingScopes(inventory, setupBlockingScopes) {
  const byScope = new Map();
  for (const pkg of inventory.packages) {
    for (const scope of inventory.packagePermissions[pkg.name] ?? []) {
      if (!byScope.has(scope)) byScope.set(scope, []);
      byScope.get(scope).push(pkg.name);
    }
  }
  for (const scope of setupBlockingScopes) {
    if (!byScope.has(scope)) byScope.set(scope, []);
  }
  const rows = [...byScope].map(([scope, pkgs]) => [
    `\`${scope}\``,
    pkgs.length === 0 ? '—' : pkgs.map((p) => `\`${p}\``).join(', '),
    setupBlockingScopes.includes(scope)
      ? '**yes** — without it `/me/accounts` returns nothing and no Page token can be derived'
      : 'no',
  ]);
  return [
    '| Scope | Required by package | Blocking? |',
    '| --- | --- | --- |',
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

// The `setup-token` flow: `runSetupToken` classifies the pasted token,
// exchanges it, discovers Pages, derives the Page token and writes the env
// file. Dependency-injected; never throws for a credential problem.

import {
  debugToken,
  envFilePath as defaultEnvFilePath,
  errorMessageOf,
} from '../../core/index.js';
import { DEFAULT_LAUNCH_COMMAND, subcommandHint } from '../../mcp/launch-command.js';
import { trimmed } from './args.js';
import {
  LONG_LIVED_SECONDS,
  MAX_EPOCH_MS,
  MS_PER_DAY,
  PAGE_LIST_LIMIT,
  REQUIRED_SETUP_SCOPES,
  SETUP_TOKEN_ENV_VAR,
} from './constants.js';
import {
  describeDroppedKeys,
  defaultWriter,
  keysDroppedFrom,
  probeEnvTarget,
  readExistingEnvFile,
  renderEnvFile,
  type EnvTargetKind,
} from './env-file.js';
import {
  asString,
  classifyFailureDetail,
  debugCredential,
  derivePageToken,
  findMissingPackageScopes,
  targetPackages,
  toPage,
  UNKNOWN_TOKEN,
  type RawPageAccount,
} from './graph.js';
import { describeShortLifetime } from './report.js';
import type {
  MissingPackageScope,
  SetupTokenClassification,
  SetupTokenDeps,
  SetupTokenExchange,
  SetupTokenPage,
  SetupTokenResult,
  SetupTokenStep,
  SetupTokenWriteReport,
} from './types.js';

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

/**
 * Run the guided setup: classify the pasted token, exchange it for a long-lived
 * one, discover Pages, derive the selected Page's token, and write the env file
 * atomically at 0600. Never throws for a credential, scope, Graph or file
 * problem — every failure is a reported step, so a broken credential still
 * produces a readable explanation.
 */
export async function runSetupToken(deps: SetupTokenDeps): Promise<SetupTokenResult> {
  const now = deps.clock.now();
  const { input, settings, redactor } = deps;
  const launch = deps.launchCommand ?? DEFAULT_LAUNCH_COMMAND;
  const nextCommand = subcommandHint(launch, 'doctor');
  const steps: SetupTokenStep[] = [];
  const warnings: string[] = [...input.notes];
  // Warnings composed BEFORE the write step that describe its outcome. Their
  // final wording is only known once that step has answered (written, dry run,
  // refused, failed), so each is rendered in `finish`, at the position it was
  // pushed — never as a past-tense "was written" for a file nothing touched.
  const writeDependentWarnings = new Map<
    number,
    (write: SetupTokenWriteReport) => string
  >();
  const pushWriteDependentWarning = (
    render: (write: SetupTokenWriteReport) => string,
  ): void => {
    writeDependentWarnings.set(warnings.length, render);
    warnings.push('');
  };
  const envPath =
    input.envFilePath ??
    deps.envFilePath ??
    defaultEnvFilePath(deps.platform !== undefined ? { platform: deps.platform } : {});

  const redact = (err: unknown): string => redactor.redactString(errorMessageOf(err));

  const finish = (parts: {
    token?: SetupTokenClassification;
    exchange?: SetupTokenExchange;
    pages?: readonly SetupTokenPage[];
    selectedPageId?: string;
    missingRequiredScopes?: readonly string[];
    missingPackageScopes?: readonly MissingPackageScope[];
    write: SetupTokenWriteReport;
  }): SetupTokenResult => ({
    ok: !steps.some((step) => step.status === 'failed'),
    generatedAt: now,
    apiVersion: settings.apiVersion,
    tokenSource: input.tokenSource,
    steps,
    token: parts.token ?? UNKNOWN_TOKEN,
    ...(parts.exchange !== undefined ? { exchange: parts.exchange } : {}),
    pages: parts.pages ?? [],
    ...(parts.selectedPageId !== undefined
      ? { selectedPageId: parts.selectedPageId }
      : {}),
    missingRequiredScopes: parts.missingRequiredScopes ?? [],
    missingPackageScopes: parts.missingPackageScopes ?? [],
    write: parts.write,
    warnings: warnings.map(
      (warning, index) => writeDependentWarnings.get(index)?.(parts.write) ?? warning,
    ),
    nextCommand,
  });

  const skippedWrite = (keys: readonly string[] = []): SetupTokenWriteReport => ({
    status: 'skipped',
    path: envPath,
    keys,
    restricted: false,
  });

  // --- 1. Input -------------------------------------------------------------
  const pasted = trimmed(input.token);
  if (pasted === undefined) {
    steps.push({
      id: 'input',
      status: 'failed',
      summary: 'no short-lived token supplied',
      // Name the blocking scope inline: `docs/` is not part of the published
      // package, so an operator who installed from npm cannot open a runbook
      // path, and this is the very first message the flow ever prints.
      detail:
        'Open the Graph API Explorer (developers.facebook.com/tools/explorer), ' +
        'select your app and the "User Token" dropdown, tick at least ' +
        `${REQUIRED_SETUP_SCOPES.join(', ')} (plus the scopes of the packages you ` +
        'enable — the README\'s "Permissions you need to grant" table lists ' +
        'them), generate the token, then run: ' +
        `${SETUP_TOKEN_ENV_VAR}=<token> ${subcommandHint(launch, 'setup-token')}`,
    });
    return finish({ write: skippedWrite() });
  }

  // Register BEFORE anything can log or fail with it in the message (C3).
  redactor.addSecret(pasted);
  deps.logger.debug('setup-token: token received', { source: input.tokenSource });
  steps.push({
    id: 'input',
    status: 'ok',
    summary: `short-lived token received (source: ${input.tokenSource})`,
  });

  // --- 2. Classify ----------------------------------------------------------
  let classification: SetupTokenClassification;
  try {
    const info = await debugToken(pasted, {
      fbRequest: deps.fbRequest,
      accessToken: debugCredential(settings, pasted),
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    });
    classification = {
      valid: info.valid,
      type: info.type,
      ...(info.appId !== undefined ? { appId: info.appId } : {}),
      scopes: info.scopes,
      expiry: info.expiry,
      ...(info.expiresAt !== undefined ? { expiresAt: info.expiresAt } : {}),
      ...(info.userId !== undefined ? { userId: info.userId } : {}),
    };
  } catch (err) {
    const message = redact(err);
    steps.push({
      id: 'classify',
      status: 'failed',
      summary: 'debug_token failed',
      detail: classifyFailureDetail(err, message, deps.settings),
    });
    return finish({ token: { ...UNKNOWN_TOKEN, error: message }, write: skippedWrite() });
  }

  if (!classification.valid) {
    steps.push({
      id: 'classify',
      status: 'failed',
      summary: `token is not valid (type ${classification.type})`,
      detail:
        'Graph API Explorer tokens live 1–2 hours. Generate a fresh User token ' +
        'in the Explorer and re-run. If it was just generated, confirm you picked ' +
        'the same app as FB_APP_ID.',
    });
    return finish({ token: classification, write: skippedWrite() });
  }

  if (classification.type === 'PAGE') {
    steps.push({
      id: 'classify',
      status: 'failed',
      summary: 'this is already a Page token, not a User token',
      detail:
        'setup-token exchanges a USER token. A Page token needs no exchange: set ' +
        'FB_PAGE_TOKEN (and FB_PAGE_ID) directly, then run `' +
        nextCommand +
        '`. ' +
        'To run the guided flow, generate a User token in the Graph API Explorer.',
    });
    return finish({ token: classification, write: skippedWrite() });
  }

  if (classification.type !== 'USER' && classification.type !== 'SYSTEM_USER') {
    steps.push({
      id: 'classify',
      status: 'failed',
      summary: `unsupported token type ${classification.type}`,
      detail:
        'Expected a User token from the Graph API Explorer (or a System-User ' +
        'token). An App token (`{app-id}|{app-secret}`) cannot act on a Page.',
    });
    return finish({ token: classification, write: skippedWrite() });
  }

  const granted = new Set(classification.scopes);
  const missingRequiredScopes = REQUIRED_SETUP_SCOPES.filter(
    (scope) => !granted.has(scope),
  );
  const missingPackageScopes = findMissingPackageScopes(
    targetPackages(settings, warnings, redact),
    granted,
  );

  if (missingRequiredScopes.length > 0) {
    steps.push({
      id: 'classify',
      status: 'failed',
      summary: `token is missing required scope(s): ${missingRequiredScopes.join(', ')}`,
      detail:
        `The core package needs ${missingRequiredScopes.join(', ')} to read ` +
        '/me/accounts — without it no Page can be discovered or given a token. ' +
        'Re-generate the Explorer token with that permission ticked and re-run.',
    });
    return finish({
      token: classification,
      missingRequiredScopes,
      missingPackageScopes,
      write: skippedWrite(),
    });
  }

  steps.push({
    id: 'classify',
    status: 'ok',
    summary: `valid ${classification.type} token, ${String(classification.scopes.length)} scope(s)`,
  });

  for (const missing of missingPackageScopes) {
    warnings.push(
      `Scope ${missing.scope} was not granted; the ${missing.packages.join(', ')} ` +
        `package(s) that need it will be blocked (\`${nextCommand}\` shows the full matrix).`,
    );
  }

  // --- 3. Exchange ----------------------------------------------------------
  let runtimeToken = pasted;
  let exchange: SetupTokenExchange;

  if (classification.type === 'SYSTEM_USER') {
    // A System-User token is already the long-lived (or non-expiring) credential
    // route A produces — exchanging it would be a downgrade, so skip honestly.
    exchange = {
      performed: false,
      envKey: 'FB_SYSTEM_TOKEN',
      ...(classification.expiresAt !== undefined
        ? {
            expiresAt: classification.expiresAt,
            expiresInDays: Math.max(
              0,
              Math.floor((classification.expiresAt - now) / MS_PER_DAY),
            ),
          }
        : {}),
      // Only Graph's explicit `expires_at: 0` is "never"; an answer that named no
      // expiry is a token whose lifetime nobody knows, and it is still written.
      neverExpiring: classification.expiry === 'never',
    };
    if (classification.expiry === 'unknown') {
      warnings.push(
        'Graph did not report an expiry for this System-User token, so whether it ' +
          `expires is unknown; it is written verbatim — verify with \`${nextCommand}\` ` +
          "and check the token in the Graph API Explorer's Access Token Debugger.",
      );
    }
    steps.push({
      id: 'exchange',
      status: 'skipped',
      summary: 'System-User token needs no exchange',
      detail: 'It is written as FB_SYSTEM_TOKEN and used verbatim.',
    });
  } else {
    const appId = settings.appId;
    const appSecret = settings.appSecret;
    if (appId === undefined || appSecret === undefined) {
      steps.push({
        id: 'exchange',
        status: 'failed',
        summary: 'cannot exchange without app credentials',
        detail:
          'The long-lived exchange is server-side and needs both FB_APP_ID and ' +
          'FB_APP_SECRET (App settings → Basic). Export them and re-run — an ' +
          'unexchanged Explorer token expires in 1–2 hours, so nothing was written.',
      });
      return finish({
        token: classification,
        missingPackageScopes,
        write: skippedWrite(),
      });
    }

    try {
      // NOTE: `/oauth/access_token` is the one Graph edge that REQUIRES the app
      // secret and the input token as query params — Meta's contract, and a
      // one-time setup call, never a runtime one. Everything else uses Bearer.
      const res = await deps.fbRequest<{
        access_token?: string;
        expires_in?: number;
      }>({
        protocol: 'json',
        method: 'GET',
        host: 'graph',
        path: '/oauth/access_token',
        params: {
          grant_type: 'fb_exchange_token',
          client_id: appId,
          client_secret: appSecret,
          fb_exchange_token: pasted,
        },
        token: pasted,
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      });
      const longLived = trimmed(res.data.access_token);
      if (longLived === undefined) {
        steps.push({
          id: 'exchange',
          status: 'failed',
          summary: 'Graph returned no long-lived token',
          detail:
            'The exchange succeeded but carried no access_token. Verify FB_APP_ID / ' +
            'FB_APP_SECRET belong to the same app as the pasted token, then re-run.',
        });
        return finish({
          token: classification,
          missingPackageScopes,
          write: skippedWrite(),
        });
      }
      redactor.addSecret(longLived);
      runtimeToken = longLived;

      const expiresIn = res.data.expires_in;
      // `expires_in` is untrusted wire data reached through a cast, and it does
      // not take a malicious Graph to break this — only a wrong one:
      // `JSON.parse('{"expires_in":1e400}')` yields `Infinity`, and a merely
      // enormous finite value lands past {@link MAX_EPOCH_MS}, where a `Date`
      // stops existing. An expiry that cannot be expressed as a date is an
      // expiry we did not get, and the branch below already says that honestly.
      const candidate =
        typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0
          ? now + expiresIn * 1000
          : undefined;
      const expiresAt =
        candidate !== undefined && candidate <= MAX_EPOCH_MS ? candidate : undefined;
      exchange = {
        performed: true,
        envKey: 'FB_ACCESS_TOKEN',
        ...(expiresAt !== undefined
          ? {
              expiresAt,
              expiresInDays: Math.floor((expiresAt - now) / MS_PER_DAY),
            }
          : {}),
        neverExpiring: false,
      };
      if (expiresAt === undefined) {
        warnings.push(
          'Graph did not report an expiry for the exchanged token; assume the ' +
            `standard ~${String(LONG_LIVED_SECONDS / 86_400)} days and verify with \`${nextCommand}\`.`,
        );
      }
      // "Long-lived" is a claim about the wire, not about the endpoint: Graph
      // can answer the exchange with a token that dies within hours (a pasted
      // token that was already long-lived and near its end, for one). Calling
      // that "long-lived token obtained (~0 days)" and writing it in silence
      // hands the operator a credential that is dead by the time they run doctor.
      const shortLifetime =
        expiresAt !== undefined && expiresAt - now < MS_PER_DAY
          ? describeShortLifetime(expiresAt - now)
          : undefined;
      if (shortLifetime !== undefined) {
        warnings.push(
          `Graph reported the exchanged token expires in ${shortLifetime} — that is ` +
            `not a long-lived token (expected ~${String(LONG_LIVED_SECONDS / 86_400)} days). ` +
            'It works until then; generate a fresh User token in the Graph API ' +
            'Explorer and re-run to obtain a long-lived one.',
        );
      }
      steps.push({
        id: 'exchange',
        status: 'ok',
        summary:
          shortLifetime !== undefined
            ? `token obtained, but it expires in ${shortLifetime}`
            : exchange.expiresInDays !== undefined
              ? `long-lived token obtained (~${String(exchange.expiresInDays)} days)`
              : 'long-lived token obtained (expiry not reported)',
      });
    } catch (err) {
      const message = redact(err);
      steps.push({
        id: 'exchange',
        status: 'failed',
        summary: 'fb_exchange_token failed',
        detail:
          `Graph refused the exchange: ${message}. The usual causes are a stale ` +
          'Explorer token (they live 1–2 hours), or FB_APP_ID / FB_APP_SECRET ' +
          'belonging to a different app than the token.',
      });
      return finish({
        token: classification,
        missingPackageScopes,
        write: skippedWrite(),
      });
    }
  }

  // --- 4. Pages -------------------------------------------------------------
  let pages: SetupTokenPage[];
  let selectedPageId: string | undefined;
  let pageToken: string | undefined;

  try {
    const res = await deps.fbRequest<{
      data?: readonly RawPageAccount[];
      paging?: { readonly next?: unknown };
    }>({
      protocol: 'json',
      method: 'GET',
      host: 'graph',
      path: '/me/accounts',
      params: {
        fields: 'id,name,category,tasks,access_token',
        limit: PAGE_LIST_LIMIT,
      },
      token: runtimeToken,
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    });
    const raw = (res.data.data ?? []).filter(
      (account): account is RawPageAccount & { id: string } =>
        typeof account.id === 'string' && account.id.length > 0,
    );

    // EVERY entry carries a live Page token, not only the one we go on to
    // select. Register them all here — before any later step can fail with the
    // payload in its message — so the header's "every derived Page token" holds
    // for the Pages the operator did not pick.
    for (const account of raw) {
      const token = asString(account.access_token);
      if (token !== undefined) redactor.addSecret(token);
    }

    // One page of results only — this flow does NOT follow `paging.next`, so
    // when Graph says there is more, every count and every "not among your
    // Pages" verdict below is about the first PAGE_LIST_LIMIT entries, and must
    // say so rather than claim the operator's Page does not exist.
    const truncated = asString(res.data.paging?.next) !== undefined;

    // Pick the Page: an explicit --page wins; a single Page auto-selects — but
    // only when it is single: a truncated listing with one visible entry is NOT
    // a unique Page, and pinning it would write FB_PAGE_ID for a Page the
    // operator never chose.
    const requested = input.pageId;
    if (requested !== undefined) {
      const match = raw.find((account) => account.id === requested);
      if (match === undefined) {
        steps.push({
          id: 'pages',
          status: 'failed',
          summary: truncated
            ? `Page ${requested} is not among the first ${String(PAGE_LIST_LIMIT)} ` +
              'Pages this token can see (Graph reported more)'
            : `Page ${requested} is not among the Pages this token can see`,
          detail:
            raw.length > 0
              ? `Available Page IDs: ${raw.map((account) => account.id).join(', ')}.`
              : 'This token sees no Pages at all, and pages_show_list IS granted ' +
                '(classify verified it, or the run would have stopped there). ' +
                'Check that the token holder has a role on the Page — for a ' +
                'System-User token, that the Page is assigned to it as an asset.',
        });
        pages = raw.map((account) => toPage(account, undefined));
        return finish({
          token: classification,
          exchange,
          pages,
          missingPackageScopes,
          write: skippedWrite(),
        });
      }
      selectedPageId = match.id;
    } else if (raw.length === 1 && !truncated) {
      selectedPageId = raw[0]?.id;
    }

    pages = raw.map((account) => toPage(account, selectedPageId));

    if (raw.length === 0) {
      pushWriteDependentWarning(
        (write) =>
          'No Pages were returned by /me/accounts, and pages_show_list IS granted ' +
          '(classify verified it), so the scope is not the cause. Either the ' +
          'token holder has no role on any Page, or — for a System-User token — ' +
          'the Page is not assigned to it as an asset, or the token was ' +
          'generated for a different app than the one the Page runs through. ' +
          capitalize(
            writeOutcome(write, {
              written: 'The runtime token is still written',
              planned: 'A real run still writes the runtime token',
              pending: 'it still carries the runtime token',
            }),
          ) +
          '; re-run setup-token once a Page is visible.',
      );
    } else if (truncated) {
      warnings.push(
        `Graph reported more Pages than the ${String(raw.length)} this run listed ` +
          `(it reads one window of up to ${String(PAGE_LIST_LIMIT)}); only that ` +
          'window was considered, so a Page outside it cannot be discovered or ' +
          'pinned with --page=<id> here.',
      );
    }
    if (raw.length > 0 && selectedPageId === undefined) {
      warnings.push(
        `${String(raw.length)} Page(s) found${truncated ? ' of more' : ''} and none ` +
          'selected, so no FB_PAGE_ID / ' +
          'FB_PAGE_TOKEN is included. Re-run with --page=<id> to pin one, and add ' +
          '--force: an env file that already exists — including the one this run ' +
          'leaves behind — is refused without it, and replaced, never merged.',
      );
    }

    let deriveError: string | undefined;
    if (selectedPageId !== undefined) {
      const selected = raw.find((account) => account.id === selectedPageId);
      pageToken = asString(selected?.access_token);
      if (pageToken === undefined) {
        // Graph omits access_token when the field is not returned for this token;
        // derive it explicitly rather than silently writing a Page-token-less config.
        const derived = await derivePageToken(deps, selectedPageId, runtimeToken, redact);
        pageToken = derived.token;
        deriveError = derived.error;
      }
      if (pageToken !== undefined) redactor.addSecret(pageToken);
    }

    steps.push({
      id: 'pages',
      status: 'ok',
      summary:
        selectedPageId !== undefined
          ? `${String(raw.length)} Page(s) found; selected ${selectedPageId}${
              pageToken !== undefined ? ' (Page token derived)' : ' (no Page token)'
            }`
          : `${String(raw.length)} Page(s) found; none selected`,
    });
    if (selectedPageId !== undefined && pageToken === undefined) {
      const pageId = selectedPageId;
      pushWriteDependentWarning(
        (write) =>
          `No Page token could be derived for Page ${pageId}` +
          (deriveError !== undefined ? ` (${deriveError})` : '') +
          '; ' +
          writeOutcome(write, {
            written: 'only the runtime token was written',
            planned: 'a real run writes only the runtime token',
            pending: 'it carries only the runtime token',
          }) +
          '. ' +
          (deriveError !== undefined
            ? 'Resolve that cause (a missing role on the Page is the usual one), then re-run.'
            : 'Confirm your role on the Page, then re-run.'),
      );
    }
  } catch (err) {
    const message = redact(err);
    steps.push({
      id: 'pages',
      status: 'failed',
      summary: '/me/accounts failed',
      detail:
        `Graph refused the Page listing: ${message}. classify already verified ` +
        "pages_show_list is granted, so suspect the token holder's Page role " +
        '(for a System-User token, the Page asset assignment) or an expired ' +
        'token rather than the scope.',
    });
    return finish({
      token: classification,
      exchange,
      missingPackageScopes,
      write: skippedWrite(),
    });
  }

  // --- 5. Write -------------------------------------------------------------
  const entries: (readonly [string, string])[] = [];
  if (settings.appId !== undefined) entries.push(['FB_APP_ID', settings.appId]);
  if (settings.appSecret !== undefined) {
    entries.push(['FB_APP_SECRET', settings.appSecret]);
  }
  entries.push([exchange.envKey, runtimeToken]);
  if (selectedPageId !== undefined) entries.push(['FB_PAGE_ID', selectedPageId]);
  if (pageToken !== undefined) entries.push(['FB_PAGE_TOKEN', pageToken]);
  const keys = entries.map(([key]) => key);

  // Render BEFORE the dry-run branch: the real run refuses a value no env file
  // can hold, so a dry run must not report success and promise the write.
  let contents: string;
  try {
    contents = renderEnvFile(entries, now);
  } catch (err) {
    const message = redact(err);
    steps.push({
      id: 'write',
      status: 'failed',
      summary: 'a value cannot be written to an env file',
      detail: message,
    });
    return finish({
      token: classification,
      exchange,
      pages,
      ...(selectedPageId !== undefined ? { selectedPageId } : {}),
      missingPackageScopes,
      write: { status: 'failed', path: envPath, keys, restricted: false, error: message },
    });
  }

  // Probe BEFORE the dry-run branch, for the same reason the render happens
  // first: a dry run answers "what will the real run do?", and promising a
  // write that run refuses (a symbolic link — refused even with --force — or an
  // existing file without --force) sends the operator into a failing command.
  // The probe is read-only (`lstat`), so a dry run still touches nothing.
  const target: EnvTargetKind =
    deps.fileExists !== undefined
      ? (await deps.fileExists(envPath))
        ? 'present'
        : 'absent'
      : await probeEnvTarget(envPath);

  // Name (never print) what a replacement would lose: the file is replaced
  // wholesale, so a hand-set FB_CONFIRM_TOKEN / FB_WRITE_MODE / FB_TOOL_PACKAGES
  // otherwise vanishes without a word and the next start runs differently.
  const droppedKeys =
    target === 'present'
      ? keysDroppedFrom(await (deps.readEnvFile ?? readExistingEnvFile)(envPath), keys)
      : [];
  const dropped = describeDroppedKeys(droppedKeys);
  const droppedField = droppedKeys.length > 0 ? { droppedKeys } : {};

  if (!input.write && target !== 'symlink') {
    const existing =
      target === 'present'
        ? input.force
          ? ` ${envPath} already exists and will be REPLACED (never merged).${dropped}`
          : ` ${envPath} already exists: add --force to replace it (it is ` +
            `replaced, never merged), or point elsewhere with --env-file=<path>.${dropped}`
        : '';
    steps.push({
      id: 'write',
      status: 'skipped',
      summary: 'dry run — nothing was written',
      detail: `Re-run without --no-write to write ${keys.join(', ')} to ${envPath}.${existing}`,
    });
    return finish({
      token: classification,
      exchange,
      pages,
      ...(selectedPageId !== undefined ? { selectedPageId } : {}),
      missingPackageScopes,
      write: { ...skippedWrite(keys), ...droppedField },
    });
  }

  if (target === 'symlink') {
    // Refused even with --force: replacing the link is never what was asked
    // for, and following it would write the credential wherever the link
    // points. The operator names the real file instead.
    const error = `${envPath} is a symbolic link; refusing to replace it`;
    steps.push({
      id: 'write',
      status: 'failed',
      summary: 'env file path is a symbolic link',
      detail:
        `${error}. An atomic write would replace the LINK, not the file it points ` +
        'to. Pass --env-file=<path> with the real file (the link target) instead.',
    });
    return finish({
      token: classification,
      exchange,
      pages,
      ...(selectedPageId !== undefined ? { selectedPageId } : {}),
      missingPackageScopes,
      write: { status: 'failed', path: envPath, keys, restricted: false, error },
    });
  }
  if (target === 'present' && !input.force) {
    steps.push({
      id: 'write',
      status: 'failed',
      summary: 'env file already exists',
      detail:
        `${envPath} exists and would be REPLACED (never merged). Re-run with ` +
        `--force to overwrite, or point elsewhere with --env-file=<path>.${dropped}`,
    });
    return finish({
      token: classification,
      exchange,
      pages,
      ...(selectedPageId !== undefined ? { selectedPageId } : {}),
      missingPackageScopes,
      write: {
        status: 'needs-force',
        path: envPath,
        keys,
        restricted: false,
        ...droppedField,
      },
    });
  }

  const write = deps.writeEnvFile ?? defaultWriter(deps.platform);
  try {
    const result = await write(envPath, contents);
    const writtenDetail = `${result.note ?? ''}${dropped}`.trim();
    steps.push({
      id: 'write',
      status: 'ok',
      summary: `wrote ${String(keys.length)} key(s) to ${result.path}`,
      ...(writtenDetail !== '' ? { detail: writtenDetail } : {}),
    });
    return finish({
      token: classification,
      exchange,
      pages,
      ...(selectedPageId !== undefined ? { selectedPageId } : {}),
      missingPackageScopes,
      write: {
        status: 'written',
        path: result.path,
        keys,
        restricted: result.restricted,
        ...(result.note !== undefined ? { note: result.note } : {}),
        ...droppedField,
      },
    });
  } catch (err) {
    const message = redact(err);
    steps.push({
      id: 'write',
      status: 'failed',
      summary: 'could not write the env file',
      detail:
        `${envPath}: ${message}. Check the directory exists and is writable, or ` +
        'pass --env-file=<path> to write elsewhere.',
    });
    return finish({
      token: classification,
      exchange,
      pages,
      ...(selectedPageId !== undefined ? { selectedPageId } : {}),
      missingPackageScopes,
      write: {
        status: 'failed',
        path: envPath,
        keys,
        restricted: false,
        error: message,
      },
    });
  }
}

/**
 * The outcome clause of a warning composed before the write step: `written`
 * when the file was written, `planned` plus "this dry run wrote nothing" for a
 * dry run (the only `skipped` write that reaches a warning — every earlier
 * failure returns before one is composed), and an explicit "nothing was
 * written" when the write was refused or failed.
 */
function writeOutcome(
  write: SetupTokenWriteReport,
  wording: {
    readonly written: string;
    readonly planned: string;
    readonly pending: string;
  },
): string {
  switch (write.status) {
    case 'written':
      return wording.written;
    case 'skipped':
      return `${wording.planned} — this dry run wrote nothing`;
    case 'needs-force':
    case 'failed':
      return (
        'nothing was written (see the Env file section); once the write ' +
        `succeeds, ${wording.pending}`
      );
  }
}

/** Upper-case the first character, for a clause that opens a sentence. */
function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

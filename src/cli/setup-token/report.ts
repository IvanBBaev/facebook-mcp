// Rendering of the `setup-token` result: `renderSetupTokenReport` turns a
// `SetupTokenResult` into operator-readable text. No token value is printed.

import { MS_PER_HOUR, MS_PER_MINUTE, SYSTEM_USER_GUIDANCE } from './constants.js';
import type {
  SetupStepStatus,
  SetupTokenPage,
  SetupTokenResult,
  SetupTokenWriteReport,
} from './types.js';

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const STEP_LABEL: Record<SetupStepStatus, string> = {
  ok: 'OK',
  skipped: 'SKIP',
  failed: 'FAIL',
};

/**
 * Render an epoch, or say plainly that it could not be read. `new Date(ms)` is
 * an Invalid Date for a `NaN` or out-of-range epoch, and `toISOString()` on one
 * throws `RangeError: Invalid time value` — from inside the renderer, so a
 * single unreadable number costs the operator not that line but the entire
 * report, at the exact moment they ran this command to find out what was wrong.
 * A bad line is still a diagnosis; a renderer that throws is not.
 */
/** `~N hour(s)` / `~N minute(s)` for a lifetime under a day, never `~0`. */
export function describeShortLifetime(ms: number): string {
  if (ms >= MS_PER_HOUR) {
    const hours = Math.floor(ms / MS_PER_HOUR);
    return `~${String(hours)} hour${hours === 1 ? '' : 's'}`;
  }
  const minutes = Math.max(1, Math.floor(ms / MS_PER_MINUTE));
  return `~${String(minutes)} minute${minutes === 1 ? '' : 's'}`;
}

function iso(ms: number): string {
  const at = new Date(ms);
  return Number.isNaN(at.getTime()) ? '(unreadable timestamp)' : at.toISOString();
}

function describeExchange(result: SetupTokenResult): string[] {
  const exchange = result.exchange;
  if (exchange === undefined) return ['  not reached'];
  const lines: string[] = [];
  if (exchange.neverExpiring) {
    lines.push('  long-lived token: non-expiring (System-User token, used verbatim)');
  } else if (exchange.expiresAt !== undefined) {
    const days = exchange.expiresInDays ?? 0;
    lines.push(
      exchange.performed && days === 0
        ? // The exchange handed back a token that dies within the day — the
          // warnings say how soon; the label must not call it long-lived.
          `  token:            expires ${iso(exchange.expiresAt)} (under a day — NOT long-lived)`
        : `  long-lived token: expires ${iso(exchange.expiresAt)} (~${String(days)} days)`,
    );
  } else if (exchange.performed) {
    lines.push('  long-lived token: obtained, expiry not reported by Graph');
  } else {
    // A System-User token Graph answered without a usable `expires_at`: not
    // exchanged, not known to be non-expiring, and not to be labelled either.
    lines.push('  System-User token: used verbatim, expiry not reported by Graph');
  }
  lines.push(`  written as:       ${exchange.envKey}`);
  if (!exchange.neverExpiring) {
    lines.push(`  note:             ${SYSTEM_USER_GUIDANCE}`);
  }
  return lines;
}

function renderPage(page: SetupTokenPage): string {
  const marker = page.selected ? '*' : ' ';
  const category = page.category !== undefined ? ` [${page.category}]` : '';
  const tasks = page.tasks.length > 0 ? ` tasks: ${page.tasks.join(',')}` : '';
  return `  ${marker} ${page.id.padEnd(18)} ${page.name}${category}${tasks}`;
}

function describeWrite(write: SetupTokenWriteReport): string[] {
  const lines = [`  path:   ${write.path}`];
  switch (write.status) {
    case 'written':
      lines.push(
        `  status: written atomically${write.restricted ? ' (mode 0600, owner only)' : ''}`,
      );
      break;
    case 'skipped':
      lines.push('  status: not written (dry run or an earlier step failed)');
      break;
    case 'needs-force':
      lines.push('  status: NOT written — the file exists; re-run with --force');
      break;
    case 'failed':
      lines.push(`  status: FAILED — ${write.error ?? 'unknown error'}`);
      break;
  }
  lines.push(
    `  keys:   ${write.keys.length > 0 ? write.keys.join(', ') : '(none)'} (values are never printed)`,
  );
  if (write.droppedKeys !== undefined && write.droppedKeys.length > 0) {
    lines.push(
      `  ${write.status === 'written' ? 'dropped' : 'drops'}:  ${write.droppedKeys.join(', ')} ` +
        '(held by the old file, not rewritten — set them again if needed)',
    );
  }
  if (write.note !== undefined) lines.push(`  note:   ${write.note}`);
  return lines;
}

/** Render a {@link SetupTokenResult} as operator-readable text. */
export function renderSetupTokenReport(result: SetupTokenResult): string {
  const lines: string[] = [
    'facebook-mcp setup-token',
    '========================',
    '',
    'Run',
    `  status:       ${result.ok ? 'completed' : 'INCOMPLETE'}`,
    `  API version:  ${result.apiVersion}`,
    `  token source: ${result.tokenSource}`,
    `  generated at: ${iso(result.generatedAt)}`,
    '',
    'Steps',
  ];
  for (const step of result.steps) {
    lines.push(
      `  [${STEP_LABEL[step.status].padEnd(4)}] ${step.id.padEnd(8)} ${step.summary}`,
    );
    if (step.detail !== undefined) lines.push(`           -> ${step.detail}`);
  }

  lines.push(
    '',
    'Token',
    `  type:    ${result.token.type}`,
    `  valid:   ${result.token.valid ? 'yes' : 'no'}`,
    `  app id:  ${result.token.appId ?? '-'}`,
    `  scopes:  ${result.token.scopes.length > 0 ? result.token.scopes.join(', ') : '(none)'}`,
  );
  if (result.missingRequiredScopes.length > 0) {
    lines.push(`  MISSING: ${result.missingRequiredScopes.join(', ')} (setup-blocking)`);
  }
  for (const missing of result.missingPackageScopes) {
    lines.push(`  missing: ${missing.scope} — needed by ${missing.packages.join(', ')}`);
  }

  lines.push('', 'Exchange', ...describeExchange(result));

  lines.push('', 'Pages');
  if (result.pages.length === 0) {
    lines.push('  (none found)');
  } else {
    for (const page of result.pages) lines.push(renderPage(page));
  }

  lines.push('', 'Env file', ...describeWrite(result.write));

  if (result.warnings.length > 0) {
    lines.push('', 'Warnings');
    for (const warning of result.warnings) lines.push(`  - ${warning}`);
  }

  lines.push('', 'Next step:', `  ${result.nextCommand}`);
  return lines.join('\n');
}

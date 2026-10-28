// Wording shared by the findings and the rendered report.

import type { PackageMatrixRow, PackageUsability } from './types.js';

export const STATUS_LABEL: Record<PackageUsability, string> = {
  usable: 'OK',
  partial: 'PARTIAL',
  blocked: 'BLOCKED',
  unknown: 'UNKNOWN',
  unverified: 'NOT CHECKED',
};

export function fmtList(items: readonly string[]): string {
  return items.length > 0 ? items.join(', ') : '(none)';
}

export function matrixRowDetail(row: PackageMatrixRow): string {
  switch (row.status) {
    case 'usable':
      return `required: ${fmtList(row.requiredPermissions)}`;
    case 'blocked':
      return `missing: ${fmtList(row.missingPermissions)}`;
    case 'partial':
      return `missing: ${fmtList(row.missingPermissions)}; blocked tools: ${fmtList(
        row.blockedTools,
      )}`;
    case 'unknown':
      return 'no permission mapping (package not in PACKAGE_PERMISSIONS)';
    case 'unverified':
      return `required: ${fmtList(
        row.requiredPermissions,
      )} — not checked (the token's scopes were never learned; see Token above)`;
  }
}

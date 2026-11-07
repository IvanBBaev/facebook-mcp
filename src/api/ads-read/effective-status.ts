// `effective_status` truth (CC-ADS-2) (X11 split of `ads-read.ts`).

// ---------------------------------------------------------------------------
// 3. effective_status truth (CC-ADS-2)
// ---------------------------------------------------------------------------

/**
 * Model-facing pin repeated in every ads tool description. `status` is what the
 * account holder configured; `effective_status` is what Meta is actually doing
 * with the object once review, parent status and schedule are folded in.
 */
export const EFFECTIVE_STATUS_NOTE =
  '`status` is the configured setting; `effective_status` is the real delivery state after review and parent status are applied. ACTIVE in `status` does NOT mean the object is delivering — read `effective_status` and the `delivering` flag.';

/** Effective statuses under which Meta can actually deliver the object. */
const DELIVERING_STATUSES: ReadonlySet<string> = new Set(['ACTIVE']);

/**
 * One line per effective status explaining what it means for delivery. Keys are
 * the documented values; anything unknown falls back to an explicit
 * "unrecognised" line rather than being silently treated as fine.
 */
export const EFFECTIVE_STATUS_EXPLANATIONS: Readonly<Record<string, string>> = {
  ACTIVE: 'Delivering (subject to schedule, budget and parent status).',
  PAUSED: 'Paused on this object — not delivering until it is resumed.',
  DELETED: 'Deleted — read-only, cannot be edited or resumed.',
  ARCHIVED: 'Archived — read-only, cannot be edited or resumed.',
  CAMPAIGN_PAUSED:
    'The parent CAMPAIGN is paused, so this object is not delivering even though its own status may be ACTIVE. Resume the campaign, not this object.',
  ADSET_PAUSED:
    'The parent AD SET is paused, so this ad is not delivering even though its own status may be ACTIVE. Resume the ad set, not this ad.',
  PENDING_REVIEW: 'Awaiting Meta ad review — not delivering yet.',
  IN_PROCESS: 'Meta is still processing this object — not delivering yet.',
  PENDING_BILLING_INFO: 'Blocked on billing information — not delivering.',
  PREAPPROVED: 'Provisionally approved ahead of its start time — not delivering yet.',
  DISAPPROVED:
    'Rejected by ad review — not delivering. The creative or targeting must change.',
  WITH_ISSUES:
    'Delivery is restricted by a policy or setup issue (partial or stopped). Check the object in Ads Manager for the specific issue.',
  ADSET_PAUSED_BY_AD_RULE: 'Paused automatically by an ad rule — not delivering.',
};

/** Parent-paused effective statuses, mapped to the parent that holds the pause. */
const PARENT_PAUSED_STATUSES: Readonly<Record<string, string>> = {
  CAMPAIGN_PAUSED: 'campaign',
  ADSET_PAUSED: 'ad set',
};

/** True when the effective status means Meta can deliver right now (CC-ADS-2). */
export function isDelivering(effectiveStatus: string | undefined): boolean {
  return effectiveStatus !== undefined && DELIVERING_STATUSES.has(effectiveStatus);
}

/**
 * Explain the effective status, calling out the common trap explicitly: a
 * configured `ACTIVE` that is not delivering because of a parent or review.
 */
export function describeEffectiveStatus(
  effectiveStatus: string | undefined,
  configuredStatus?: string,
): string {
  if (effectiveStatus === undefined) {
    return 'Delivery state unknown: Graph returned no `effective_status` for this object (the `fields` override may have dropped it).';
  }
  const pausedParent = Object.hasOwn(PARENT_PAUSED_STATUSES, effectiveStatus)
    ? PARENT_PAUSED_STATUSES[effectiveStatus]
    : undefined;
  if (pausedParent !== undefined && configuredStatus === 'PAUSED') {
    // "Resume the parent, not this object" is only true while this object's own
    // switch is on. With both paused, resuming the parent alone changes nothing.
    return `The parent ${pausedParent.toUpperCase()} is paused and this object's own status is PAUSED too, so it is not delivering. Resume both this object and its ${pausedParent} — resuming either one alone will not start delivery.`;
  }
  const base =
    EFFECTIVE_STATUS_EXPLANATIONS[effectiveStatus] ??
    `Unrecognised effective status "${effectiveStatus}" — treat delivery as unknown and check Ads Manager.`;
  if (effectiveStatus === 'WITH_ISSUES') {
    // Partial delivery is possible here, so the definitive "NOT delivering" line
    // below would contradict the explanation it is appended to.
    return `${base} It may still be delivering (and spending) in part; \`delivering\` is false only because full delivery cannot be confirmed.`;
  }
  if (
    configuredStatus === 'ACTIVE' &&
    effectiveStatus !== 'ACTIVE' &&
    EFFECTIVE_STATUS_EXPLANATIONS[effectiveStatus] !== undefined
  ) {
    return `${base} Configured status is ACTIVE, so this object is NOT delivering despite its own setting.`;
  }
  return base;
}

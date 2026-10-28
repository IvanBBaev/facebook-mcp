// Annotation fragment for package `ads` — off by default.
//
// Part of the frozen annotation manifest asserted by `../annotations.test.ts`
// (see `./index.ts`). Owned by the `ads` lane: changing a hint on one of this
// package's tools means editing the matching row here — that edit is the review.

import type { AnnotationRow } from './row.js';

export const ANNOTATIONS_ADS: readonly AnnotationRow[] = [
  ['facebook_list_campaigns', true, false, true, true, undefined],
  ['facebook_list_adsets', true, false, true, true, undefined],
  ['facebook_list_ads', true, false, true, true, undefined],
  ['facebook_get_ad_object', true, false, true, true, undefined],
  ['facebook_get_ad_preview', true, false, true, true, undefined],
  ['facebook_ads_insights', true, false, true, true, undefined],
  ['facebook_ads_report_status', true, false, true, true, undefined],
  ['facebook_update_ad_object', false, true, true, true, 'spend'],
  ['facebook_archive_ad_object', false, true, true, true, 'irreversible'],
  ['facebook_delete_ad_object', false, true, true, true, 'irreversible'],
  ['facebook_upload_ad_image', false, false, true, true, 'reversible'],
  ['facebook_get_ad_set_targeting', true, false, true, true, undefined],
  ['facebook_update_ad_set_targeting', false, true, true, true, 'spend'],
  ['facebook_duplicate_ad_object', false, false, false, true, 'irreversible'],
  ['facebook_boost_post', false, false, false, true, 'irreversible'],
];

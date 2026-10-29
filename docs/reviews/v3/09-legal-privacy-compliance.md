# v3 review 09 — Legal, privacy and platform compliance

| | |
|---|---|
| Role | Senior Legal / Privacy & Platform-Compliance Specialist (developer tools) |
| Date | 2026-10-29 |
| Scope commit | `2c8d8bd` (`feat(api): add the stable insights schema (expand only)`), package `@ivanbaev/facebook-mcp` 0.8.0 |
| Method | Static read of source, docs, site and packaging at the scope commit; dependency licence census (`npm ls --omit=dev` and full tree); comparison against the primary texts listed below. No live Graph API calls, no runtime tracing. |
| Not legal advice | This is an engineering-side compliance review written to prioritise work and to frame questions for a qualified lawyer (EU/Bulgaria data protection, trademark). It is not legal advice and creates no lawyer-client relationship. |

**Sources (all checked 2026-10-29):**

| Ref | Source | Notes |
|---|---|---|
| S1 | Meta Platform Terms — https://developers.facebook.com/terms/ | "Last updated Feb 3, 2026"; §3.a, §3.c, §3.d, §4, §5 quoted below |
| S2 | Meta Developer Policies — https://developers.facebook.com/devpolicy/ | Feb 3, 2026; §1.3, §2.4, §6.1.a, §6.2.b |
| S3 | Messenger Platform policy and "Send a Message" docs — https://developers.facebook.com/documentation/business-messaging/messenger-platform/policy | Seen via search excerpts only; bot-disclosure wording **[UNVERIFIED 2026-10-29]** |
| S4 | Meta brand resources, Facebook logo — https://www.meta.com/brand/resources/facebook/logo/ | Logo "complete and unaltered", no use "in your trademark, domain name, username" |
| S5 | Meta Commercial Terms / Self-Serve Ad Terms update, effective 2026-11-20 (moved from 2026-10-30) — press: https://www.relevantaudience.com/meta/meta-commercial-terms-delayed-to-november-20-2026/ , https://ppc.land/meta-delays-website-crawling-terms-to-nov-20-after-publisher-complaints/ , https://wsau.com/2026/10/23/meta-to-delay-new-commercial-terms-criticised-by-publishers-advertisers/ , https://www.beri.net/article/meta-commercial-terms-november-20-2026-advantage-plus-ai-features-advertiser-liability-indemnity-crawling-arbitration-opt-out | Date verified by several reports; primary Meta text **[UNVERIFIED 2026-10-29]** |
| S6 | Anthropic Usage Policy — https://www.anthropic.com/legal/aup | Privacy and profiling prohibitions |
| S7 | Anthropic MCP Directory FAQ / local MCP server submission guide — https://support.claude.com/en/articles/11596036-anthropic-mcp-directory-faq , https://support.claude.com/en/articles/12922832 (localised copies) | Search excerpts: privacy policy required in README **and** manifest `privacy_policies`; missing ⇒ rejection. Manifest version 0.2+ vs 0.3+ conflict **[UNVERIFIED 2026-10-29]** |
| S8 | GDPR (Regulation (EU) 2016/679) Art. 4(7), 5, 6, 9, 12-17, 26, 28, 30 | Primary law, cited from text |
| S9 | CJEU C-210/16 *Wirtschaftsakademie* (2018) | Page admin + Facebook = joint controllers for Page Insights |
| S10 | Regulation (EU) 2024/1689 (AI Act) Art. 50; Regulation (EU) 2024/900 (TTPA, political advertising); Regulation (EU) 2022/2065 (DSA) Art. 26 | Applicability notes; dates **[UNVERIFIED 2026-10-29]** where marked |

## 1. Verdict

**Manageable with changes.** No Blocker.

1. The code is unusually well built for legal risk control. Plan/apply, `plan_id` binding, out-of-band confirmation, PAUSED-only ad creation with hard spend caps, DSA payor enforcement, a client-side 24-hour window check, RESPONSE-only messaging and no telemetry are real, auditable human-in-the-loop controls.
2. The main gap is **privacy documentation, not privacy engineering**. There is no privacy notice, no GDPR role statement and no disclosure that Platform Data and DM content flow to the operator's LLM provider. The Anthropic directory submission (U-A2) **requires** a privacy policy (S7).
3. One factual claim is false: the journal says "no PII", but it stores PSIDs, conversation ids and up to 300 characters of private-reply text, with size-only retention.
4. The site favicon, header mark and og-banner **redraw the Facebook "f" logo**. That is contrary to Meta's brand rules (S4) and Developer Policy 2.4 (S2) and is cheap to fix.
5. `facebook_boost_post` always declares `special_ad_categories: []`. Nothing stops an operator from boosting housing, employment, credit or social-issue content under a false declaration.

Counts: **Blocker 0 · Major 5 · Minor 7 · Nit 4** (16 findings).

## 2. Why this role is in scope now

`docs/reviews/README.md:25` excluded Legal/compliance in 2026-07: "no third-party data processing, single-operator own-assets scope — Meta Platform Specialist covers platform-policy risk". That reasoning no longer fully holds at 0.8.0:

- **Third-party personal data is now processed.** Messenger conversations (`src/api/messaging.ts:67-80`: `participants{id,name}`, `from`, `to`, `message`, attachments), private replies, comment authors and custom labels on people (`src/tools/labels.ts`) all handle data about people other than the operator. That is GDPR personal data, and DMs can carry special-category data (health, religion, sexuality).
- **That data leaves the machine to an LLM provider.** Every read tool returns it to the MCP client, which sends it to the model vendor. Under Platform Terms §3.c / §5.a (S1), that vendor is a recipient of Platform Data.
- **Money is moved.** The ads lane (`src/api/ads-create.ts`, `src/api/ads-control.ts`) creates and controls paid campaigns, so advertising-law and contract exposure (Self-Serve Ad Terms, S5; DSA Art. 26; TTPA) apply.
- **Distribution is wider.** Public registry listings, an MCPB bundle, a public Pages site with Meta-derived branding, and a planned Anthropic directory submission (U-A2) each carry their own policy gates (S4, S7).
- **Calendar.** Meta's Commercial / Self-Serve Ad Terms change on 2026-11-20 (S5), before 1.0.

The Meta Platform Specialist review covers API policy. It does not cover GDPR roles, trademark or distribution-channel requirements, hence this review.

## 3. Data inventory

| # | Category | Source tool(s) | Destination | Retention | Controls today |
|---|---|---|---|---|---|
| D1 | Message text, sender/recipient names and PSIDs, conversation ids | `facebook_list_conversations`, `facebook_get_conversation` (`src/tools/messages.ts:356-383`) | LLM provider (via MCP client) | Provider's retention; none locally | Taint envelope (`src/mcp/taint.ts`); attachments shown as typed placeholders (CC-MSG-6) |
| D2 | Outgoing DM metadata | `facebook_send_message`, reactions (`src/tools/messages.ts:1044-1072, 1210-1225`) | Journal on disk; LLM | Journal: size rotation ~5 MB, 1 generation, **no time limit** | 0600 file; text excluded (char count only); PSID + conversation id **included** |
| D3 | Private-reply text (up to 300 chars) | `facebook_private_reply` (`src/tools/moderation/private-reply.ts:296, 312`) | Journal summary; LLM | As D2 | 0600; **text included in the summary** |
| D4 | Page's own public comment text (80-char excerpt) | comment authoring (`src/tools/moderation/authoring.ts:87, 213`) | Journal | As D2 | Public content of the operator; low risk |
| D5 | Comments, posts, commenter names/ids (UGC) | moderation and content read tools | LLM | Provider | Taint envelope |
| D6 | Custom labels on people (PSID ↔ label) | `src/tools/labels.ts` | Meta (stored there); LLM | Meta-side until removed | Not plan-bound, not taint-wrapped; invisible to the labelled person |
| D7 | Insights aggregates (metric, date, breakdown, value, post id) | insights tools; `output` export (`src/mcp/export-file.ts`) | LLM; CSV/JSON files in `stateDir/exports` (`src/core/config.ts:139-141`) | **Indefinite** (never deleted) | 0700 dir / 0600 files; no overwrite; formula-injection guard. Aggregates, normally not personal data |
| D8 | Saved reply templates | `src/core/saved-replies.ts` | Config dir (`src/core/config.ts:147-149`) | Indefinite | 0600; operator-authored; only `{{page_name}}` placeholder |
| D9 | Activity state | `src/mcp/activity-state.ts` | State dir | Indefinite | Page ids + timestamps only |
| D10 | Structured logs | all tools (`src/core/log.ts`) | stderr → MCP client log | Client-defined | Secret redactor (`src/core/redact.ts`); per-tool `logFields` allowlists. **No PII redaction** |
| D11 | Ad account, campaign, budget, DSA payor/beneficiary | ads tools (`src/api/ads-create.ts:312-316, 446, 608`) | Meta; journal; LLM | Journal as D2 | Plan + confirm; PAUSED; spend caps |
| D12 | Tokens / app secret | env | Never logged | n/a | Value-based redaction choke-point; never written to journal |

There is no telemetry, no hosted backend and no analytics on `docs/index.html`. The author receives no operator or end-user data.

## 4. GDPR roles (basis for several findings)

- **Operator (Page owner running the server) = controller** (Art. 4(7)) for D1-D11. They decide to read DMs, label people, reply and advertise.
- **Operator + Meta = joint controllers** for Page Insights (S9; Art. 26). Meta's "Page Insights Controller Addendum" covers that relationship **[UNVERIFIED 2026-10-29]**.
- **LLM provider = processor** of the operator only if the operator uses a plan whose terms include a DPA and no-training commitment (commercial API, Team/Enterprise). On consumer plans the provider may act as an independent controller for some uses. That is the crux of LEG-01.
- **Author (Ivan Baev) = neither controller nor processor.** He ships software and receives nothing. His exposure is product-claim accuracy (LEG-02), trademark (LEG-03, LEG-12) and the directory's own policy terms (LEG-05). The MIT warranty disclaimer (`LICENSE`) is his main contractual shield. It does not cover misleading statements in docs.

## 5. Findings

### LEG-01 — Platform Data and DM personal data reach the LLM provider without any notice — **Major**

- **Evidence.** Read tools return message text, names and PSIDs to the model (`src/api/messaging.ts:67-80`, `src/tools/messages.ts:356-383`). README "Your responsibilities as the operator" (`README.md:690-710`) covers Platform Terms, anti-spam, Messenger disclosure and consent. It never mentions that data leaves the machine to the AI vendor, or the vendor's role. `SECURITY.md:122-142` has no privacy section.
- **Legal basis.**
  - Platform Terms §3.c.ii.2 and §5.a.i (S1): Platform Data may be shared with a Service Provider only if it has agreed in writing to process it "solely for you and at your direction".
  - §3.a.v: no processing "to build or augment user profiles" without consent.
  - GDPR Art. 28(3) needs a processor contract. Art. 13/14 needs transparency towards the people messaging the Page. Art. 44+ governs transfers, if the provider is outside the EEA.
  - Anthropic AUP (S6) prohibits privacy-law violations by the user.
- **Impact.** An operator on a consumer chat plan with model training enabled may be sharing Platform Data outside the Service-Provider conditions. Meta's remedy is app restriction. The GDPR exposure sits with the operator, but the project gives no warning.
- **Recommendation (doc + owner action).**
  - Add a "Privacy & data protection" README section and `PRIVACY.md` (see §6, Notice A).
  - State that the operator must use an AI plan with a DPA and no training on inputs, and should prefer the API or Team/Enterprise plans.
  - Ask the lawyer Q1.
- **Roadmap.** **NEW D-01** (docs task). Owned files: `README.md` (hand-written section only, not generated tables), new `PRIVACY.md`, `SECURITY.md` cross-link. Target: wave 1 integration slot, before U-A2 publishes listings. Owner: integration (I) for `README.md`, author review. **Size S.**

### LEG-02 — Journal claims "no PII" but stores PSIDs, conversation ids and private-reply text indefinitely — **Major**

- **Evidence.**
  - `src/mcp/journal.ts:15` claims "no token/secret/PII value can ever reach disk". `src/core/types.ts:763` says "no tokens/PII".
  - In practice:
    - `src/tools/messages.ts:1044-1058` — the send summary has the recipient PSID and conversation id; `:1072` metadata has `recipientId`/`conversationId`; `:1210, 1225` — reaction recipient.
    - `src/tools/moderation/private-reply.ts:296, 312` — up to 300 characters of the private message text go into the summary.
  - Rotation is size-only (~5 MB, one generation), so a low-traffic Page keeps entries for years.
  - `docs/runbooks/offboarding.md` repeats "redacted structured metadata only".
- **Legal basis.**
  - GDPR Art. 5(1)(c) minimisation and 5(1)(e) storage limitation. A PSID is a pseudonymous identifier, so it is personal data (Recital 26).
  - Platform Terms §3.d.i.2.a (S1): delete Platform Data "as soon as reasonably possible… when retaining… no longer necessary for a legitimate business purpose".
  - Misstated product claims also undermine the operator's own Art. 30 record.
- **Impact.** A false assurance in shipped docs and code comments. Private-reply text can contain the commenter's personal circumstances. Both an operator and Meta (Data Use Checkup) would read this as unbounded retention.
- **Recommendation (code + doc).**
  1. Replace `"${truncate(content.text, 300)}"` in the private-reply summary with a char count, matching `send_message`.
  2. Add an optional `FB_JOURNAL_RETENTION_DAYS` (default e.g. 90) that drops older lines on rotation or start-up, or document an explicit manual retention duty.
  3. Correct the comments to "no secrets; contains pseudonymous recipient ids (PSIDs) for audit".
  4. Keep PSIDs, since audit value is legitimate, but say so.
- **Roadmap.**
  - (1) belongs to **L2.moderation** (owns `src/tools/moderation/*`), wave 2, size S.
  - (2)+(3) go to **A04** (owns `src/mcp/journal.ts`) or **NEW C-task** if A04 is not scheduled before 1.0. Owned files: `src/mcp/journal.ts`, `src/core/config.ts`, `src/core/types.ts` comment, and `scripts/metadata.config.mjs` via I-task for the env table. Size M.
  - The offboarding text goes with LEG-08.

### LEG-03 — Site favicon, header mark and og-banner recreate the Facebook "f" logo — **Major**

- **Evidence.** `docs/index.html:17-20` (data-URI favicon: white "f" glyph on a #1877F2 rounded square), `docs/index.html:1285-1292` (same path as the header brand mark), `docs/assets/og-banner.svg` and its PNG (recreated "f" on a blue gradient next to the "facebook-mcp" wordmark).
- **Legal basis.**
  - Meta brand resources (S4): the logo "must be complete and unaltered"; "Do not connect any other words to the logo"; no use in products; logos taken from elsewhere are not approved.
  - Developer Policies §2.4 (S2): follow the Brand Resource Center.
  - EU trademark law: Regulation (EU) 2017/1001 Art. 9(2)(b)/(c) — likelihood of confusion and reputation-taking for a mark with a reputation.
  - The nominative disclaimer (`package.json:86`, `README.md:803-808`, site FAQ `docs/index.html:93-96`) does not cure use of the logo itself. Nominative fair use covers the word, not the device mark.
- **Impact.** This is the most likely trigger for a takedown notice (GitHub Pages DMCA/trademark form, npm, directory reviewers), and the easiest to remove. It also suggests endorsement, which the Platform Specialist and the Anthropic directory may flag.
- **Recommendation (owner action, S).** Replace all three with an original mark (e.g. a speech-bubble or plug glyph in a neutral colour). Keep the word "Facebook" only in descriptive text. Regenerate the og-banner PNG.
- **Roadmap.** **NEW D-02**, owned files `docs/index.html` (favicon + header mark lines only) and `docs/assets/og-banner.svg`/`.png`. Do it before U-A2 announcements. Owner: U (author) for the design choice. **Size S.**

### LEG-04 — `special_ad_categories: []` is always declared; no operator attestation — **Major**

- **Evidence.** `src/api/ads-create.ts:578` (and the header comment at `:4`) hard-codes the empty array. The tool description says housing, employment, credit and politics are "out of scope" (`src/tools/ads-create.ts:120-135`), but nothing in the plan/confirm path asks the operator to attest that the post is not in those categories. `README.md:659-688` states the limitation only under "Not in scope".
- **Legal basis.**
  - Meta Advertising Standards / Special Ad Categories policy: advertisers must declare these categories. False declaration ⇒ ad rejection, account restriction.
  - US: Fair Housing Act / ECOA background to Meta's 2022 settlement **[UNVERIFIED 2026-10-29]**.
  - EU: TTPA Regulation (EU) 2024/900 (political advertising transparency, applicable since 2025-10-10); Meta stopped political, electoral and social-issue ads in the EU from October 2025 **[UNVERIFIED 2026-10-29]**.
  - Self-Serve Ad Terms (S5): the advertiser warrants compliance.
- **Impact.** The agent decides what to boost. A model asked to "boost our latest post" may boost a job ad or a rental listing, and the tool will declare "no special category" on the operator's behalf. Liability sits with the operator, but the design makes the false declaration the default.
- **Recommendation (code + doc).**
  - Add a required boolean argument, e.g. `attest_no_special_ad_category: true`, or a line in the confirm prompt: "This post is not about housing, employment, credit, or social issues, elections or politics".
  - Refuse when it is false or absent.
  - Add Notice C (§6) to README.
- **Roadmap.** **L2.ads** (owns `src/api/ads-*`, `src/tools/ads*`), wave 2. README notice via D-01. **Size S.**

### LEG-05 — No privacy policy for registry listings and the Anthropic directory submission — **Major**

- **Evidence.** `manifest.json` has no `privacy_policies` field. README has no "Privacy Policy" section. U-A2 (listings, Claude plugin submission) is still open.
- **Legal basis.** Anthropic MCP Directory FAQ / submission guide (S7): a privacy policy is required both in the README and as a manifest `privacy_policies` array of HTTPS URLs. It must cover data collected, use, storage, third-party sharing, retention and contact. Missing ⇒ immediate rejection. Exact manifest version requirement (0.2+ vs 0.3+) **[UNVERIFIED 2026-10-29]**.
- **Impact.** U-A2 submission fails as-is. Separately, Platform Terms §4.a (S1) requires the *app developer* (the operator's Meta app) to "provide, maintain, and comply with a privacy policy". A published template helps operators meet it.
- **Recommendation.** Publish `PRIVACY.md` (same content as Notice A plus contact) and serve it at `https://ivanbbaev.github.io/facebook-mcp/privacy.html` or similar. Add `privacy_policies: [<url>]` through `scripts/metadata.config.mjs`, then run `npm run metadata`. Check the `manifest_version` the directory now requires.
- **Roadmap.** Content in **NEW D-01**. Manifest field via an **I-task** (integration owns `scripts/metadata.config.mjs`; `manifest.json` is generated). Must precede **U-A2**. **Size S.**

### LEG-06 — No GDPR role statement or operator duties in the docs — **Minor**

- **Evidence.** `README.md:690-710` says "Content and consent are yours" and "This is not legal advice". It does not say who is controller, that insights are joint-controlled with Meta, or that DM senders must get an Art. 13 notice through the Page's own privacy notice.
- **Legal basis.** GDPR Art. 4(7), 13, 26, 30; S9.
- **Impact.** Operators (often small businesses) misjudge the tool as "local, so no GDPR". Low direct risk to the author.
- **Recommendation.** Include the roles paragraph (Notice A) and a short operator checklist: privacy notice covers AI-assisted processing; record of processing; DPA with the AI vendor.
- **Roadmap.** NEW D-01. **Size S.**

### LEG-07 — Labels allow covert profiling, including special categories — **Minor**

- **Evidence.** `src/tools/labels.ts:1-18`: labels on PSIDs are invisible to the person, not plan-bound, not taint-wrapped. An agent can create a label such as "pregnant" or "muslim" and apply it to a person.
- **Legal basis.**
  - Platform Terms §3.a.v (S1): no building or augmenting user profiles without valid consent.
  - GDPR Art. 9(1): special categories need an Art. 9(2) exception, and there is usually none here. Art. 5(1)(a) fairness requires transparency.
  - Anthropic AUP (S6): profiles without knowledge.
- **Impact.** The tool makes a prohibited use easy and invisible. It does not cause it.
- **Recommendation (code-light).**
  - Extend the label tool descriptions: "Labels must describe the conversation or order state (e.g. 'awaiting refund'), never health, religion, ethnicity, politics, sexuality or other sensitive traits of the person".
  - Optionally add a small deny-list warning on label names.
  - Mention it in Notice A.
- **Roadmap.** **L2.messages** (owns `src/tools/labels.ts`, `src/api/labels.ts`), wave 2. **Size S.**

### LEG-08 — Offboarding runbook misses saved replies and exports and misstates the journal — **Minor**

- **Evidence.** `docs/runbooks/offboarding.md:47-72` names the env file and journal plus "any other XDG state". It omits `saved-replies.json` in the *config* dir (`src/core/config.ts:147-149`) and `stateDir/exports` (`src/core/config.ts:139-141`, or `FB_EXPORT_DIR`, `README.md:376`). It repeats the "redacted structured metadata only" claim.
- **Legal basis.** GDPR Art. 5(1)(e); Platform Terms §3.d.i.2 (S1) — delete Platform Data when the purpose ends (deauthorisation / stopping use).
- **Impact.** Leftover files after offboarding; the inaccurate statement could be relied on in a Data Use Checkup.
- **Recommendation.** List every path explicitly: env, journal + `.1` generation, activity state, exports dir (or `FB_EXPORT_DIR`), `saved-replies.json`, and the MCP client's own logs. Correct the journal description.
- **Roadmap.** NEW D-01 (owned file `docs/runbooks/offboarding.md`). **Size S.**

### LEG-09 — No data-subject request (DSR) procedure — **Minor**

- **Evidence.** No runbook covers a person who messaged the Page asking for access to or erasure of their data.
- **Legal basis.** GDPR Art. 12, 15, 17; Platform Terms §3.d.i.1 (S1): update or delete Platform Data promptly on request from the User.
- **Impact.** The operator cannot easily answer "what does your AI tool hold about me".
- **Recommendation.** New `docs/runbooks/data-subject-requests.md`:
  - (1) find the person's PSID (from the conversation);
  - (2) `grep` the journal and its rotated generation and delete matching lines;
  - (3) remove their labels;
  - (4) delete the conversation in Meta Business Suite if required;
  - (5) ask the AI vendor to delete chat history containing it;
  - (6) note that Meta-held data is answered by Meta / the Page's own tools.
- **Roadmap.** NEW D-03, owned file the new runbook. Post-1.0 is acceptable. **Size S.**

### LEG-10 — Messenger automation disclosure wording is stale and may miss the AI Act — **Minor**

- **Evidence.** `README.md:690-710` says "Messenger automation must be disclosed". `docs/analysis/04-auth-and-security.md:189-202` has the same.
- **Legal basis.**
  - Current Messenger policy (S3): disclosure "when required by applicable law" at the start of a thread, after a gap, and on a human→automation switch. Example text: "You are talking to a bot" **[UNVERIFIED 2026-10-29]**.
  - EU AI Act Art. 50(1) (S10): providers of AI systems that interact directly with people must ensure the people are informed. Applicable from 2026-08-02 **[UNVERIFIED 2026-10-29]**.
  - Here the operator is a *deployer* who sends model-drafted replies after per-message plan/apply. Whether a human-approved draft counts as "interaction with an AI system" is a lawyer question (Q4).
- **Impact.** Operators in the EU may need a disclosure line. The README does not explain when.
- **Recommendation.** Replace the bullet with Notice B (§6). Optionally offer a saved reply "This reply was drafted with AI assistance and reviewed by our team."
- **Roadmap.** NEW D-01. **Size S.**

### LEG-11 — Meta Commercial / Self-Serve Ad Terms change on 2026-11-20; no ads liability notice — **Minor**

- **Evidence.**
  - `docs/analysis/v3/README.md:59` lists the date as **[UNVERIFIED]**. Press now confirms the move from 10-30 to 11-20 (S5).
  - README has no statement that ad spend, ad content and DSA/advertising compliance are the operator's.
  - `README.md:712-737` says ads land in 1.1 while ads code ships (off by default) in 0.8 (see LEG-14).
- **Legal basis.** Self-Serve Ad Terms (S5): continued use = acceptance; advertiser warranties and indemnity, reportedly widened to AI ad features (S5, beri.net analysis). The MIT licence (`LICENSE`) disclaims warranty and liability for the author. The disclaimer is strongest when the docs state the boundary clearly.
- **Impact.** Low for the author (no contract with operators, MIT disclaimer). Moderate for operators unaware that an agent-created campaign binds them.
- **Recommendation.**
  - Add Notice C.
  - Update the v3 README calendar line to "verified by press 2026-10-29, primary text not reviewed".
  - Do not add any ad-creative AI feature that would fall under the new generative-AI terms without a review.
- **Roadmap.** NEW D-01 for the notice. The calendar line in `docs/analysis/v3/README.md` goes to the v3 doc owner (integration). **Size S.**

### LEG-12 — Name and display name lead with the "Facebook" mark — **Minor**

- **Evidence.**
  - npm `@ivanbaev/facebook-mcp`, `mcpName` `io.github.IvanBBaev/facebook-mcp`, the repo name, and `manifest.json` `display_name` "Facebook Pages MCP".
  - Prior analysis: `docs/analysis/02-market-and-positioning.md:100-125`, `docs/reviews/06-product-manager.md:267-280` (finding #10).
- **Legal basis.** S4: "You may not use any Facebook trademarks, or anything similar, in your trademark, domain name, username"; "may not use or register… any Meta trademark". Descriptive "for Facebook" phrasing is tolerated in practice, but no explicit rule on this page **[UNVERIFIED 2026-10-29]**. EU nominative use: Art. 14(1)(c) EUTMR — use to indicate purpose, in accordance with honest practices.
- **Impact.** Package/repo names that *start* with the mark are a common target of Meta brand-enforcement requests. Renaming after 1.0 and after directory listing costs much more. The scoped npm name and the disclaimers reduce, but do not remove, the risk.
- **Recommendation.**
  - Owner decision before 1.0: keep the package id, but change the display name to descriptive form ("MCP server for Facebook Pages" / "Pages Pilot for Facebook").
  - Or do a full rename.
  - Never register "facebook" in a domain.
  - Lawyer Q3.
- **Roadmap.** **U-task** (owner decision) before U-A2 and before I30-I32 (1.0). Display-name change via I-task in `scripts/metadata.config.mjs`. **Size S** (display name) / **L** (full rename).

### LEG-13 — Logs are not PII-redacted — **Nit**

- **Evidence.** `src/core/redact.ts:1-40` redacts secrets only. Safety relies on each tool's `logFields` allowlist (`src/core/log.ts`).
- **Basis.** GDPR Art. 5(1)(c), 25 (data protection by design).
- **Recommendation.** Add a test asserting that no tool's `logFields` include message text or names, and document that logs may contain Page/post/conversation ids.
- **Roadmap.** C/X task owning `src/core/log.ts` tests, or L2 lanes per tool. **Size S.**

### LEG-14 — Stale public statements (site FAQ "0.7.0", ads "in 1.1") — **Nit**

- **Evidence.** `docs/index.html:128` says 0.7.0 is current (the package is 0.8.0). `README.md:712-737` places ads in 1.1, but ads tools exist in 0.8 behind configuration.
- **Basis.** Accuracy of product claims (unfair commercial practices, Directive 2005/29/EC, is weak here since the product is free). Mostly a trust issue.
- **Recommendation.** Fix both. Say "ads tools ship disabled by default; pre-1.0, not live-verified".
- **Roadmap.** NEW D-01 / D-02. **Size S.**

### LEG-15 — No third-party licence notice in the MCPB bundle — **Nit**

- **Evidence.**
  - `scripts/pack-mcpb.mjs:13-19` embeds production `node_modules`.
  - Census: production tree has 85 MIT, 7 ISC, 2 BSD-2-Clause (`dotenv@18.0.8`, `json-schema-typed@8.0.2`) and 2 BSD-3-Clause (`fast-uri@3.1.9`, `qs@6.16.1`).
  - Full tree adds Apache-2.0 (13) and BlueOak-1.0.0 (5), dev only. No copyleft anywhere.
- **Basis.** MIT/ISC/BSD require the copyright and licence text to accompany copies. The embedded packages' own LICENSE files satisfy this if they are not pruned. BSD-3 adds a no-endorsement clause; it is not triggered.
- **Recommendation.** Generate `THIRD_PARTY_NOTICES.txt` at pack time, and assert the bundle keeps each package's LICENSE file.
- **Roadmap.** I-task (owns `scripts/` packaging), any wave. **Size S.**

### LEG-16 — EU AI Act and export control: informational — **Nit**

- **AI Act (S10).** The author distributes a tool, not a general-purpose AI model and not a high-risk system (Annex III does not list Page management or advertising). The only plausible duty is Art. 50 transparency, which falls on the deployer (operator), see LEG-10. Free and open-source components get further relief under Art. 2(12) **[UNVERIFIED 2026-10-29]**. No action beyond Notice B.
- **Export control.** Only Node built-in crypto (TLS, hashing) is used. Publicly available open source is generally outside EAR (§734.7) or mass-market 5D992 **[UNVERIFIED 2026-10-29]**. EU dual-use Regulation (EU) 2021/821 is not engaged. No action.
- **Sponsorship.** `README.md:779-801`: donations buy no warranty or SLA, and that is stated. Fine.

### Strengths to keep (human-in-the-loop evidence)

These are the operator's best evidence of due care and should be named in the docs as such:

- plan/apply mode with `plan_id` bound to a preview for irreversible and spend tiers;
- out-of-band confirmation (`src/mcp/confirm.ts:1-22`: elicitation → `FB_CONFIRM_TOKEN` → deny), not bypassable by env, and reported truthfully;
- ads created PAUSED, with a mandatory `spend_cap_minor` ≤ `FB_ADS_CAMPAIGN_SPEND_CAP_MAX` and budget ≤ `FB_ADS_BUDGET_CEILING` (`README.md:384-385`);
- DSA payor/beneficiary enforced for EU targeting (`src/api/ads-create.ts:312-316, 446, 608`);
- targeting edits limited to countries and age (`src/tools/ads/targeting.ts:130-135`), which avoids sensitive-interest targeting;
- RESPONSE-only messaging with a 24-hour window check (`src/api/messaging.ts:62-63, 611-690`), and HUMAN_AGENT refused without App Review (`:88-91`);
- taint envelope on all UGC (`src/mcp/taint.ts`);
- three-host network fence, loopback-only HTTP, no telemetry;
- 0600/0700 file modes.

## 6. Required notices (exact wording)

**Notice A — README "Privacy & data protection" section (also the basis of `PRIVACY.md`)**

```markdown
## Privacy & data protection

facebook-mcp runs entirely on your machine. The author operates no server, collects
no telemetry and never receives your data or the data of people who interact with
your Page.

**What the tools read.** Depending on the tools you enable, the server reads your
Page's posts, comments, insights and, with messaging enabled, Messenger
conversations — including the names, Page-scoped IDs (PSIDs) and messages of the
people who write to your Page.

**Where that data goes.** Tool results are returned to your MCP client and, from
there, to the AI model provider you use. That provider receives personal data of
third parties and Meta Platform Data. Use an AI plan whose terms include a data
processing agreement and no training on your inputs, and check that this sharing is
allowed under the Meta Platform Terms (§3.c, §5) and covered by your Page's privacy
notice.

**What is stored locally.** The audit journal (`FB_JOURNAL_PATH`) records every write
with pseudonymous recipient IDs (PSIDs) and conversation IDs, but never message text.
Insights exports (`FB_EXPORT_DIR`) and saved replies stay until you delete them. All
files are created readable only by your user. See
[offboarding](docs/runbooks/offboarding.md) for removal.

**Your role.** For this processing you are the data controller (and, for Page
Insights, a joint controller with Meta). You are responsible for a lawful basis,
for informing the people who message your Page, and for answering their access and
deletion requests. Do not use labels or any tool to record sensitive traits
(health, religion, ethnicity, political opinion, sexuality) of the people you
interact with.

This section is not legal advice.
```

**Notice B — replaces "Messenger automation must be disclosed"**

```markdown
- **Disclose automation where the law requires it.** Meta's Messenger policy requires
  you to tell people they are interacting with an automated experience when
  applicable law requires it — at the start of a conversation, after a long gap, and
  when switching from a human to automation. In the EU, the AI Act (Art. 50) may
  require telling people that a reply was generated with AI. If in doubt, use a line
  such as "This reply was drafted with AI assistance and reviewed by our team."
```

**Notice C — README ads liability (Responsibilities section)**

```markdown
- **Ads are your contract with Meta.** Every campaign this server creates is created
  in your ad account, under the Meta Self-Serve Ad Terms and Advertising Standards
  you accepted, and you pay for it. Campaigns start PAUSED and are capped by
  `spend_cap_minor`, `FB_ADS_CAMPAIGN_SPEND_CAP_MAX` and `FB_ADS_BUDGET_CEILING`,
  but activating them is your decision. `facebook_boost_post` always declares **no
  special ad category**: never use it for housing, employment, credit, or social
  issues, elections or politics. Those ads need a declared category (and, in the EU,
  are subject to the political-advertising rules) and must be created in Ads Manager.
  This software is provided under the MIT licence, without warranty; the author is
  not liable for ad spend or ad content.
```

**Notice D — journal / types code comment (replaces the "no PII" claim)**

```ts
// No token or secret can reach disk: every summary/metadata value passes the
// value-based redactor. Entries DO contain pseudonymous identifiers (PSIDs,
// conversation ids, Page and object ids) needed for the audit trail; message
// text is never written — only its length.
```

**Notice E — label tool description sentence**

```text
Labels must describe the conversation or order state (for example "awaiting refund"), never a sensitive trait of the person (health, religion, ethnicity, political opinion, sexuality).
```

## 7. Owner decisions needed

1. **Name (LEG-12).** Keep `facebook-mcp` as the package id with a descriptive display name, or rename everything before 1.0 and before U-A2? Recommendation: descriptive display name now, and decide on a full rename after the lawyer answers Q3.
2. **Logo (LEG-03).** Approve an original mark to replace the redrawn "f" (favicon, header, og-banner).
3. **Journal retention (LEG-02).** Choose a default: e.g. 90 days with `FB_JOURNAL_RETENTION_DAYS`, `0` = keep forever. Alternatively, document a manual duty only.
4. **Special ad category attestation (LEG-04).** Hard required argument, or a confirm-prompt line only?
5. **Privacy policy hosting (LEG-05).** Serve it at a GitHub Pages URL under the existing site, and name a contact (GitHub issues vs an email alias — not the personal address).
6. **Docs task type.** Accept "NEW D-01..D-03" as a docs task family in `docs/analysis/v3/05-parallel-task-breakdown.md`, or fold them into I-tasks.

## 8. Questions for a lawyer (EU / Bulgaria)

- **Q1.** Does a Page operator sending Messenger content (Meta Platform Data) to an LLM provider under (a) Anthropic/OpenAI API terms with a DPA, and (b) a consumer chat plan, satisfy Platform Terms §3.c.ii.2 / §5.a.i? Does either plan make the provider a processor under GDPR Art. 28?
- **Q2.** Is the author of a locally-run open-source tool exposed at all for operator GDPR breaches (e.g. as a "provider of means")? Does the MIT disclaimer plus Notice A suffice under Bulgarian law?
- **Q3.** Is `facebook-mcp` / "Facebook Pages MCP" defensible as nominative use under EUTMR Art. 14(1)(c) and the Meta brand terms, or should the project rename before 1.0?
- **Q4.** Does a model-drafted, human-approved Messenger reply trigger AI Act Art. 50 duties for the operator? Does the author have any Art. 50 provider duty?
- **Q5.** For PSIDs in an audit log kept for the operator's accountability, which lawful basis applies (Art. 6(1)(f)), and what retention period is proportionate?
- **Q6.** Does a single-owner Business-type Meta app with Standard Access need a privacy policy URL and data-deletion callback/URL in the App Dashboard? **[UNVERIFIED 2026-10-29]** — the corpus states Business apps have no dev/live mode (`docs/analysis/04-auth-and-security.md:7`), and the Developer Policies text (S2) no longer lists the URL requirement.
- **Q7.** Does the 2026-11-20 Self-Serve Ad Terms update change advertiser liability for campaigns created through third-party API tools, as opposed to Meta's own AI features?

### Added

- **The MCPB manifest links the privacy notice.** `manifest.json` now carries
  `privacy_policies` pointing at `PRIVACY.md`, as the MCPB manifest spec asks of
  extensions that reach external services.
- **The Pages site shows a ready-made config for Claude Desktop, VS Code and
  Cursor.** The VS Code snippet prompts for the system-user token instead of
  storing it in the file.

### Changed

- **The npm `homepage` is the Pages site**, and the package carries more search
  keywords (`mcp-server`, `facebook-api`, `meta-graph-api`, `social-media`).
- **The onboarding runbook's scope table is generated from the package permission
  map**, so every scope a package needs is listed, with the one setup-blocking
  scope (`pages_show_list`) marked.

### Fixed

- **The Pages site states the current release.** It advertised 0.7.0, 37 tools and
  7 packages; the version, tool and package counts, package table, risk-tier
  counts, Graph API version, environment table, JSON-LD and attestation command
  are now generated from the registry, and `npm run metadata:check` fails when
  they drift. The site's out-of-scope list and risk-tier descriptions were
  corrected to match the tools that ship.

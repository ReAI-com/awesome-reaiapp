---
title: Plugin and shared-tool source sync (2026-10-19)
description: English reading guide to the 2026-10-19 source synchronization and local verification report.
---

# Plugin and shared-tool source sync (2026-10-19)

> English reading guide. The [complete Chinese report](/source-delivery-2026-10-19) contains the full version table and release boundaries.

The official plugins, shared tools, and submission scripts were synchronized from the latest ReAI Board main line. A three-way merge based on the 2026-10-06 source kept this repository's path rewrites, sanitized fixtures, public READMEs, and local fixes. Submission identities, internal review material, release records, and build artifacts are not included.

## Changes

- Browser `1.0.5`, DSH Agent `1.2.8-dev.3`, Pi Agent `1.0.5-dev.2`, Terminal `1.0.5-dev.2`, and Voice `2.14.7`.
- New Files plugin `1.2.0`, which uses `resources.files@1` to browse and edit user-authorized local folders or cloud projects.
- SDK `1.26.0-v105.1`, contract `1.25.3-v105.1`, CLI `1.4.1-v105.1`, language tools `1.1.1-v105.1`, and test-kit `1.4.0-v105.1`. They add Surface navigation and layout, platform service contracts, resource files, shared audio clips, notification scenes, and matching mocks.

## Local verification

- Shared tools passed 691 unit tests, type checks, and the out-of-repository tarball verification.
- All 16 official plugins and the 2 AI employee demos passed install, test, type, validation, build, contract, and pack steps. The 4 examples passed their checks.
- The shared review seed now includes the Voice `2.14.7` source review, so Voice is no longer rejected locally. Public CI now verifies Voice and Files as ordinary plugins.

Source sync and local packages do not mean platform approval, signing, Host installation, or store release.

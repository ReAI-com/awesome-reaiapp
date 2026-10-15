---
title: AI employee pattern v1
description: English reading guide to the ReAI three-stage AI employee plugin pattern v1.
---

# AI employee pattern v1

> English reading guide. The [complete Chinese specification](/ai-employee-pattern-v1) remains the authoritative source for exact fields, examples, implementation status, and historical details. This page is a concise guide, not a full translation.

This pattern is extended by [AI employee paradigm v2](/en/ai-employee-pattern-v2). v1 describes the behavior of the `0.2.0` source candidate.

## Three stages

| Stage | Responsibility | Invariant |
| --- | --- | --- |
| Raw sources | Selected or pasted originals become source objects | Original bytes and content digest never change; SHA-256 dedup |
| Standard records | Sources are cleaned into role fields and become editable records | Each record links to a source or is marked manual; every edit creates a new version |
| Role agent | Role guidance, company settings, and bounded record context produce analysis or report drafts | Source text cannot change system instructions; analysis is separate from business writes |

A cleaning batch with invalid rows publishes no partial records. Only CSV and JSON are cleaned automatically; PDF, images, and office files are stored as originals.

## Settings and developer mode

- All configuration lives on the settings page. A developer password unlocks role configuration for the current screen only. It is not an account, platform authorization, or data permission.
- Role configuration (`schemaVersion: 1`) covers fields, agent guidance, and restricted HTML / CSS presentation. Imports use a strict allowlist and reject passwords, credentials, raw data, or unknown fields.

## Boards and page proposals

- Dashboard and role boards are HTML definitions bound to standard data through bounded bindings: `count`, `sum`, `distinct`, `difference`, `records`, and `reports`. Pages cannot run scripts, load external resources, or write business data.
- The navigation `+` pre-fills a request for the agent. The agent returns a page proposal; the page is saved only after the user confirms. Confirmation rechecks role, configuration version, field references, and budgets. Repeated confirmation of the same proposal is idempotent.

## Agent and voice

- The default package uses a clearly labeled rule-based demo adapter. The real adapter uses Agent Service v2 with read-only records and an empty tool set, and requires platform approval of `agent.session@2` and `cloud.model.invoke@1` plus user consent.
- The agent runs in a non-modal right panel. Voice input uses the existing optional Voice service and only fills the draft.

## New roles and external sources

- New roles are generated as new plugins with their own `appId` by the scaffold command. The generator copies an allowlisted static template and never copies user data, passwords, or build output.
- `SourceAdapter` separates collection from the core and accepts bounded batches. No real mailbox, drive, or remote API collector exists yet.

## Unverified scope

Real Host installation, platform approval, signing, real model calls, Voice, scheduled collection, cloud storage, multi-user access, and public release are not verified.

## Continue reading

- [Complete Chinese specification](/ai-employee-pattern-v1)
- [AI employee paradigm v2](/en/ai-employee-pattern-v2)
- [Agent Service v2](/en/agent-service-v2)
- [Plugin development](/en/plugin-development-v1)
- [Documentation overview](/en/)

Source: `docs/ai-employee-pattern-v1.md`.

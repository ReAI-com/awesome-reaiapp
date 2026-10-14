---
title: AI employee paradigm v2
description: English reading guide to the ReAI AI employee paradigm v2 (design draft and contracts, phase one).
---

# AI employee paradigm v2

> English reading guide. The [complete Chinese specification](/ai-employee-pattern-v2) remains the authoritative source for exact fields, examples, implementation status, and historical details. This page is a concise guide, not a full translation.

## Status

- Recorded on 2026-10-14. Phase one delivers an interactive design draft and the paradigm contracts. Plugin implementation is phase two.
- Nothing in v2 is implemented, submitted for review, or signed. The `plugins/ai-employee` source remains the `0.2.0` candidate described in [AI employee pattern v1](/en/ai-employee-pattern-v1).
- The design draft is a self-contained HTML file in the repository (`plugins/ai-employee/design/paradigm-v2.html`). It shows interaction intent only. It is not a contract and is not packaged with the plugin. Where it differs from the specification, the specification wins.

## What an AI employee is

An AI employee is a role workbench. When a person operates it, it assists that person; when it runs on its own, it is the employee. A company is treated as an Input-Process-Output (IPO) network, and each role is a small IPO node.

| Mark | Meaning |
| --- | --- |
| A | Raw facts: uploaded, collected, or returned originals. Append-only. |
| B | Normalized data cleaned from A by role rules. Revisable and versioned. |
| C | Deliverables generated from B. A person selects one candidate and signs it. |
| D | Rule system that checks A and B, including other roles' data and physical-world feedback. |

## Three paradigms

| Paradigm | Flow | Primary board |
| --- | --- | --- |
| A-B (interpret) | A → cleaning workflow → B; the agent explains B | B board: metrics, tables, charts, documents |
| A-B-C (create) | A → B → deliverable C; C can flow back as new B | C desk: candidates, selection, export, reflow |
| A-B-D (check) | A and B → rules D → check results | D desk: rule versions, check runs, escalation |

Invariants: A is append-only; every B record must explicitly record its source status (import, manual, or reflow), and legacy data with an unknown origin is labeled `unknown` as is, never back-filled; published workflows are immutable snapshots; facts, inferences, and process are stored separately; C is bound to a specific selected candidate version; D separates rule definitions from check runs, and each run freezes its inputs.

## Boards are small topic apps

Each board is a minimal functional interface around one topic, with a name, icon, and purpose. It declares which B data it reads and what it produces (nothing, C, or D results). Boards are assembled from declarative components, so an agent can propose one from natural language and the user confirms it. The paradigm type is a badge on the board, not a fixed navigation group.

The Chinese specification lists ten example roles (finance, HR, sales, e-commerce operations, design, content operations, product, development, project management, executive assistant) for a fictional company. All sample data is fictional.

## Key contracts

| Area | Contract summary |
| --- | --- |
| A → B | Save A with fingerprint dedup → clean → review issues → publish B. A batch with invalid rows publishes nothing. Edits check the expected version. PDF, images, and office files are stored but not cleaned automatically. |
| B source | Import (A fingerprint + rule or workflow reference), manual (operator + time), reflow (a content snapshot of the selected C version saved as a new `derived` A, then imported), or `unknown` for legacy data. |
| C sign-off | Receipt = signer, time, candidate version, input B versions, idempotency key. Same key and content returns the original receipt; same key with different content is rejected. If inputs change, the old signature is kept and marked as based on old inputs. |
| D checks | Rule definition (ID + version) is separate from a check run (run ID, rule version, frozen input snapshot, evidence). Results: business failure, run failure, or insufficient evidence. Old results expire when rules or inputs change. |
| Board actions | A board = component parameters + data bindings + references to a code-provided trusted action allowlist. No scripts, events, or arbitrary writes. Proposals may only reference existing actions; previews are read-only. |
| Roles and instances | One role = one plugin instance with its own `appId`. Cross-role references use `{appId, role, objectType, objectId, version}` and require the other role's authorization; the authorization mechanism is an open question. |
| Agent messages | Agent messages are a subset of the ni-chat message model and use ROMP field names. Thinking summaries are not fabricated; tool steps appear only when real events exist. Status mapping: `completed`/`failed` ↔ `done`/`error`. |
| Agent configuration | Defaults come from a few stable `contributes.agentFeatures` entries (Host API 1.23 or later). User overrides live in the Host plugin agent configuration page. Adding a board does not change the Manifest or permissions. Developer mode no longer edits prompts, skills, or engines. |
| Errors | Retryable, accepted-but-timed-out, receipt lost, unavailable or not approved, no permission, insufficient balance, conflict, and business rejection each have a defined recovery. Diagnostics are visible only in Host developer mode. |

## Reuse rather than rebuild

v2 reuses existing mechanisms: local original storage, the `SourceAdapter` contract, cloud workflows through `ctx.flowApi` (currently `FLOW_SCOPE_UNAVAILABLE`), [Agent Service v2](/en/agent-service-v2), the ni-chat and ROMP message models, and the JOJO project network for role-to-role flow. Availability statements for cloud services come from their own documentation and were not verified in this phase.

## Open questions and unverified scope

Open questions: cross-role authorization, mapping logical workflow names to immutable snapshots with version proof, agent process events, deliverable export interfaces, and how the IPO network maps onto JOJO edges.

Not implemented or verified: plugin code, C and D objects, the component contract, real cloud workflow or agent calls, ROMP and JOJO integration, export, platform approval, signing, Host installation, and public release.

## Continue reading

- [Complete Chinese specification](/ai-employee-pattern-v2)
- [AI employee pattern v1](/en/ai-employee-pattern-v1)
- [Agent Service v2](/en/agent-service-v2)
- [Plugin development](/en/plugin-development-v1)
- [Documentation overview](/en/)

Source: `docs/ai-employee-pattern-v2.md`.

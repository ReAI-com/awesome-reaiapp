---
title: Agent computer prototype v0
description: English reading guide to the ReAI agent computer prototype, a background virtual machine an agent operates on its own.
---

# Agent computer prototype v0

> English reading guide. The [complete Chinese document](/agent-computer-prototype-v0) remains the authoritative source for the method matrix, contracts, test results, and known risks. This page is a concise guide, not a full translation.

## Give each agent its own computer

- Each agent gets a background virtual machine with the same operating system as the host. The agent's mouse and keyboard act only inside that machine, so the user's own mouse, keyboard, clipboard, and screen are unaffected.

- The agent works with its own business accounts inside the machine. Files reach the user's folders only after the user approves the exact content.

- The prototype lives in `prototypes/agent-computer/`. It implements a macOS guest on Apple Silicon behind platform-neutral interfaces, so a Windows backend can be added later.

## Safety boundaries

- The service starts in an emergency-stopped state. Only the user can resume, and a restart or reconnect never lifts the stop. A stop interrupts input in progress and releases held keys.

- The local API listens on a private Unix socket. Agent and user tokens are separated: the agent cannot resume, list or approve exports, or shut the machine down.

- Export approval is bound to a content digest. A file changed after approval is rejected, and rejecting a candidate never deletes host paths.

- Known limits include the VNC port listening on all interfaces, a residual parent-directory race in the export path, and both tokens living under the same host user. See the Chinese document for details.

## Continue reading

- [Complete Chinese document](/agent-computer-prototype-v0)
- [Documentation overview](/en/)
- [Plugin development](/en/plugin-development-v1)

Source: `docs/agent-computer-prototype-v0.md`.

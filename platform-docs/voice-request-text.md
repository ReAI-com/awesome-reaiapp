# Voice request-text service (F04 candidate)

Status: implementation candidate in Voice `2.12.26-f04.1` and its matching Driver build. This is not a published artifact or evidence of real-device acceptance. Independent Voice cloud OAuth and fresh onboarding have separate integration gates. The approved factory package remains unchanged.

## Design boundary

Follow [能力复用与调用边界](./plugin-development-v1.md#capability-reuse). Host maps trigger sources; consumers request text without identifying a keyboard or shortcut. Voice and Host reuse their capture/recognition lifecycle. Consumers must not implement a parallel recorder as a silent fallback.

This text service does not return an Agent task answer. Its original request resolves with text; finish/cancel acknowledgements and status updates are not final results. Cursor insertion, translation and Agent result presentation use their respective existing contracts. Global presentation belongs to Host and is not mandatory for every service request.

## Calling the service

Declare the versioned service dependency using the normal App Service manifest contract. The installed Voice provider must expose `com.reai.voice/request-text@1` version `1.0.0`. Only the matching F04 Host implements all cancellation and account-generation guarantees. Voice 2.12.27-k02.1 requires Host API >=1.17 for the Host-owned microphone requirement. Missing account generation or route-permission metadata is explicitly rejected, never guessed. Do not fall back to an unscoped recording call.

```ts
const requestId = `${Date.now()}:${crypto.randomUUID()}`;
const result = await ctx.services.call(
  "com.reai.voice/request-text@1",
  "request-text",
  { requestId, timeoutMs: 180_000 },
);
```

The caller supplies no audio, DOM target, insertion option or identity. Voice and Host own capture and recognition. The result is `{ requestId, text, kind }`, where kind is `processed`, `raw` or `raw_fallback`. The caller decides whether to put text into its input or send it. Voice never injects service results into another app or writes them into Voice history.

The request promise stays pending until the final result or terminal error. Use the same service with method `finish`, `cancel` or `status` and input `{ requestId }`. Finish/cancel return `{ accepted }`; they never carry the final text. Status returns phase, revision, captureStarted, pcmReceived and optional errorCode, without audio, text or screenshots. `waiting_permission` and `listening` are distinct. Since 2026-10-11 the official Voice provider never prompts for microphone access while preparing a recording: when the Host route requires the computer microphone and it is not authorized, the request fails with `com.reai.voice/VOICE_MIC_PERMISSION_REQUIRED` and the user authorizes it from Voice settings.

Request IDs use `<createdAtUnixMs>:<UUIDv4>`, with a 60-second admission window and at most 5 seconds of future-clock tolerance. IDs are single-use and persisted before capture. A fresh recording requires a fresh ID. timeoutMs is 1,000..300,000, default 180,000. The tighter Host deadline includes provider startup, permission wait, capture and processing. Arbitrary additional input fields are rejected.

## Ownership, cancellation and errors

The Host supplies caller app, mount, runtime and opaque account generation. Consumers do not parse or manufacture that generation. Control calls cannot access a different owner or login generation. Concurrent recording attempts return SERVICE_BUSY. Cancel-before-start is remembered; a late start is cancelled by exact handle/session. The capture lease stays busy until cleanup is acknowledged, with bounded retry scheduling if cleanup transport fails.

SERVICE_CANCELLED and SERVICE_TIMEOUT are terminal. VOICE_REQUEST_SESSION_CHANGED means the original login session was replaced; VOICE_ACCOUNT_UNAVAILABLE means account state could not be read, not proof of logout. Replayed/stale IDs, malformed input and missing identity have distinct VOICE_REQUEST_* errors. Ordinary optional polish failures may produce raw_fallback; cancellation or explicit session replacement must not become a successful raw result.

## Screenshot consent

Screenshot assistance is a separate, default-off user choice. Confirmation is bound to the current Host login epoch. It is independent of operating-system screen-recording permission. Voice captures context when recording begins, keeps it only for that operation and sends it only for the chosen polish step. The Host binds image access to the recording owner, session, account, cancellation generation and original focused window. Missing/stale origins or a changed window yield no image. Context metadata is bounded to 32 entries and five minutes; screenshots and text are not retained in that registry.

Turning the switch off aborts current image uses immediately. Re-enabling cannot revive old grants. Account replacement invalidates consent and in-flight results. Secure-window, permission, size and content guards still apply. No image is included in service status or persisted history.

## Acceptance still required

Unit and contract tests do not prove microphone, OS permission dialogs, actual screen capture, insertion behavior or independent cloud OAuth. Before release, exercise normal input and service callers on the signed App, cancellation in each phase, account replacement and both interface languages. Verify F01 cloud authorization and F03 fresh-user onboarding separately.

### Host 录音权限兼容边界（API 1.17）

Voice 2.12.27-k02.1 候选要求 Host API >=1.17.0。实际 prepare 路径先配置来源，
再读取 Host `microphoneRequired`；只有 Host 要求且未授权时才请求系统麦克风。
USB Vendor HID / BLE 不弹麦克风授权，系统默认 / 指定系统输入 / UAC 兼容仍保留授权。
UAC 权限被拒绝导致路由 unavailable 也不解除该要求。旧 Host 缺字段时明确提示升级。
授权等待被取消后移除监听，晚到 grant 不能启动采集或给原请求返回成功。

# 语音对话 (`com.reai.voice-chat`)

官方实时语音对话插件。界面灵感来自电影《她》（*Her*）中的 OS1，以极简留白与单个随声音揉动、思考时扭转为 ∞ 丝带的有机圆环为核心交互，底层将语音识别（STT）、对话大脑（Agent 服务 / 外脑流式）与语音合成（TTS）彻底解耦。

## 本地构建与验证

```bash
bun install
bun run validate
bun run typecheck
bun run test
bun run build
bun run test:contract
bun run pack
```

打包产物位于 `voice-chat-0.1.0.reaiapp`，可在 AI Vibe Board 开启「开发者模式」后通过「从本地安装」导入体验。

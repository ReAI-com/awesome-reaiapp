// 由 scripts/snapshot-official-plugins.ts 生成，不要手改。重新生成：bun run snapshot
export const OFFICIAL_PLUGINS_SNAPSHOT = {
  "generatedOn": "2026-10-21",
  "source": "awesome-reaiapp plugins/*/app.manifest.json",
  "plugins": [
    {
      "slug": "agents-im",
      "appId": "com.reai.agents-im",
      "name": "Agents · IM",
      "version": "1.0.0",
      "capabilities": [
        "sidebar.item@1",
        "surface.main@1"
      ],
      "permissions": []
    },
    {
      "slug": "agents-tasks",
      "appId": "com.reai.agents-tasks",
      "name": "Agents · 任务",
      "version": "1.0.1-dev.1",
      "capabilities": [
        "apps.intent@1",
        "sidebar.item@1",
        "surface.main@1",
        "titlebar.action@1"
      ],
      "permissions": []
    },
    {
      "slug": "ai-employee",
      "appId": "com.example.ai-employee",
      "name": "AI 员工工作台",
      "version": "0.2.0",
      "capabilities": [
        "apps.intent@1",
        "apps.service@1",
        "commands@1",
        "sidebar.item@1",
        "storage.kv@1",
        "surface.main@1",
        "titlebar.action@1"
      ],
      "permissions": []
    },
    {
      "slug": "ai-patent-assistant",
      "appId": "com.example.ai-patent-assistant",
      "name": "AI 专利助手",
      "version": "0.1.0",
      "capabilities": [
        "apps.intent@1",
        "apps.service@1",
        "commands@1",
        "sidebar.item@1",
        "storage.kv@1",
        "surface.main@1",
        "titlebar.action@1"
      ],
      "permissions": []
    },
    {
      "slug": "browser",
      "appId": "com.reai.browser",
      "name": "浏览器",
      "version": "1.0.5",
      "capabilities": [
        "browser.engine@1",
        "commands@1",
        "metadata.i18n@1",
        "sidebar.item@1",
        "surface.main@1",
        "system.tasks@1"
      ],
      "permissions": []
    },
    {
      "slug": "code-worker",
      "appId": "com.reai.code-worker",
      "name": "AI 代码编排",
      "version": "0.2.1",
      "capabilities": [
        "apps.gateway@1",
        "apps.service@1",
        "commands@1",
        "metadata.i18n@1",
        "sidebar.item@1",
        "storage.kv@1",
        "surface.main@1"
      ],
      "permissions": [
        "apps.gateway@1"
      ]
    },
    {
      "slug": "codex-app",
      "appId": "com.reai.codex-app",
      "name": "Codex App",
      "version": "0.1.9-h08.1",
      "capabilities": [
        "agent.codex.tasks@1",
        "apps.intent@1",
        "metadata.i18n@2",
        "sidebar.item@1",
        "storage.kv@1",
        "surface.main@1",
        "system.folder-pick@1",
        "system.tasks@1",
        "titlebar.action@1"
      ],
      "permissions": []
    },
    {
      "slug": "codex-link",
      "appId": "com.reai.codex-link",
      "name": "Codex Link",
      "version": "0.5.12",
      "capabilities": [
        "activation.startup@1",
        "agent.codex@1",
        "commands@1",
        "metadata.i18n@1",
        "sidebar.item@1",
        "storage.kv@1",
        "surface.main@1",
        "system.folder-pick@1",
        "titlebar.action@1"
      ],
      "permissions": []
    },
    {
      "slug": "computer",
      "appId": "com.reai.computer",
      "name": "电脑操控",
      "version": "0.1.1-dev.1",
      "capabilities": [
        "cloud.model.invoke@1",
        "commands@1",
        "computer.engine@1",
        "sidebar.item@1",
        "storage.kv@1",
        "surface.main@1"
      ],
      "permissions": [
        "cloud.model.invoke@1"
      ]
    },
    {
      "slug": "device-doctor",
      "appId": "com.reai.device-doctor",
      "name": "设备诊断助手",
      "version": "1.0.2",
      "capabilities": [
        "agent.local@1",
        "sidebar.item@1",
        "storage.kv@1",
        "surface.main@1"
      ],
      "permissions": []
    },
    {
      "slug": "dsh-agent",
      "appId": "com.reai.dsh-agent",
      "name": "DSH",
      "version": "1.2.8-dev.3",
      "capabilities": [
        "agent.dsh-observe@1",
        "agent.session@2",
        "cloud.model.invoke@1",
        "metadata.i18n@1",
        "resources.files@1",
        "sidebar.item@1",
        "storage.kv@1",
        "surface.escape@1",
        "surface.main@1",
        "surface.navigation@1",
        "system.tasks@1",
        "titlebar.action@1"
      ],
      "permissions": [
        "agent.dsh-observe@1",
        "agent.session@2",
        "cloud.model.invoke@1",
        "resources.files@1"
      ]
    },
    {
      "slug": "files",
      "appId": "com.reai.files",
      "name": "文件",
      "version": "1.2.0",
      "capabilities": [
        "metadata.i18n@2",
        "resources.files@1",
        "sidebar.item@1",
        "surface.main@1",
        "system.tasks@1"
      ],
      "permissions": [
        "resources.files@1"
      ]
    },
    {
      "slug": "pi-agent",
      "appId": "com.reai.pi-agent",
      "name": "Pi Agent",
      "version": "1.0.5-dev.2",
      "capabilities": [
        "agent.pi-management@1",
        "agent.session@2",
        "cloud.model.invoke@1",
        "metadata.i18n@1",
        "resources.files@1",
        "sidebar.item@1",
        "storage.kv@1",
        "surface.escape@1",
        "surface.main@1",
        "surface.navigation@1",
        "system.tasks@1",
        "titlebar.action@1"
      ],
      "permissions": [
        "agent.session@2",
        "cloud.model.invoke@1",
        "resources.files@1"
      ]
    },
    {
      "slug": "podcast",
      "appId": "com.reai.podcast",
      "name": "AI Podcast",
      "version": "1.0.1-dev.2",
      "capabilities": [
        "metadata.i18n@2",
        "sidebar.item@1",
        "surface.main@1",
        "titlebar.action@1"
      ],
      "permissions": []
    },
    {
      "slug": "terminal",
      "appId": "com.reai.terminal",
      "name": "终端",
      "version": "1.0.5-dev.2",
      "capabilities": [
        "metadata.i18n@1",
        "sidebar.item@1",
        "storage.kv@1",
        "surface.escape@1",
        "surface.main@1",
        "surface.navigation@1",
        "terminal.session@1",
        "titlebar.action@1"
      ],
      "permissions": [
        "terminal.session@1"
      ]
    },
    {
      "slug": "text-editor",
      "appId": "com.reai.text-editor",
      "name": "文本编辑器",
      "version": "0.1.2-dev.1",
      "capabilities": [
        "apps.intent@1",
        "local.files@1",
        "metadata.i18n@1",
        "sidebar.item@1",
        "storage.kv@1",
        "surface.main@1",
        "titlebar.action@1"
      ],
      "permissions": []
    },
    {
      "slug": "voice",
      "appId": "com.reai.voice",
      "name": "语音输入法",
      "version": "2.14.7",
      "capabilities": [
        "activation.startup@1",
        "agent.session@1",
        "agent.session@2",
        "apps.service@1",
        "audio.capture@1",
        "audio.clips@1",
        "cloud.model.invoke@1",
        "commands@1",
        "local.terminal.exec@1",
        "metadata.i18n@1",
        "sidebar.item@1",
        "storage.kv@1",
        "surface.clipboard@1",
        "surface.escape@1",
        "surface.main@1",
        "surface.navigation@1",
        "system.folder-pick@1",
        "system.tasks@1",
        "titlebar.action@1",
        "voice.command@1",
        "voice.context@1",
        "voice.deliver@1",
        "voice.input@1",
        "voice.recordings@1"
      ],
      "permissions": [
        "account.status@1",
        "agent.session@1",
        "agent.session@2",
        "audio.capture@1",
        "audio.clips@1",
        "cloud.model.invoke@1",
        "local.terminal.exec@1",
        "voice.context@1",
        "voice.deliver@1"
      ]
    },
    {
      "slug": "wishing-wall",
      "appId": "com.reai.wishing-wall",
      "name": "AI许愿墙",
      "version": "0.4.2",
      "capabilities": [
        "sidebar.item@1",
        "storage.kv@1",
        "surface.main@1"
      ],
      "permissions": [
        "http.fetch@1"
      ]
    }
  ]
} as const;

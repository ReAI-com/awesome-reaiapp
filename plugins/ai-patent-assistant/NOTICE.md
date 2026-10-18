# 第三方署名

本插件的岗位 Agent 要求（`src/profiles/default-profile.json` 中的提示词、8 份工作方式与 SOP）和 `assets/skills/patent-sop/SKILL.md`，改编自以下项目的工作流程说明：

- 项目：patent-disclosure-skill（中国专利.skill）
- 地址：https://github.com/handsomestWei/patent-disclosure-skill
- 参考版本：commit `6935a14d342ed9c7a07440c999d1b7bf1852a701`（技能版本 5.1.0）
- 许可证：MIT

改编内容为九项能力的路由、步骤与护栏的中文摘要。原项目的 Python 脚本、提示词全文、模板、示例与图片未复制进本插件。插件不能联网或运行脚本，原项目依赖检索站点、Playwright、Obsidian 等环境的步骤已改写为“生成检索式或请用户上传材料”。

原许可证全文如下：

```text
MIT License

Copyright (c) 2026 handsomestWei

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

插件模板核心（`src/`、`scripts/`、`tests/`）来自本仓库的 `plugins/ai-employee`，经其生成器产生。

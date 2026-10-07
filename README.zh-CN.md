<p align="center">
  <img src="docs/media/icon.png" width="128" alt="ClaudeRipple">
</p>

<h1 align="center">ClaudeRipple</h1>

<p align="center"><a href="README.md">English</a> · <a href="README.ko.md">한국어</a> · <b>简体中文</b> · <a href="README.ja.md">日本語</a> · <a href="README.es.md">Español</a> · <a href="README.pt-BR.md">Português (BR)</a></p>

<p align="center">
  <b>聊天仍是 Claude，只有 Code 换成 GPT。</b><br>
  Claude Desktop 自带的“使用其他模型”设置会切换<b>整个应用</b>——聊天、手机端 Remote
  Control 和连接器都会随之不可用。<br>ClaudeRipple 不关闭任何功能：你依然登录着自己的
  Claude 订阅，同时由 GPT、DeepSeek、Kimi、Grok<br>或其他 400 多个模型在
  <b>Code 标签页</b>中作答。在 <b>Codex 应用</b>和 <b>Codex CLI</b> 中也能使用 Claude。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/clauderipple"><img alt="npm" src="https://img.shields.io/npm/v/clauderipple?label=npm"></a>
  <img alt="Alpha" src="https://img.shields.io/badge/status-alpha-orange">
  <a href="LICENSE"><img alt="GPL-3.0" src="https://img.shields.io/badge/license-GPL--3.0-blue"></a>
  <img alt="macOS" src="https://img.shields.io/badge/macOS-arm64%20%7C%20x64-black">
  <img alt="Windows" src="https://img.shields.io/badge/Windows-arm64%20%7C%20x64-0078D4">
  <img alt="Linux" src="https://img.shields.io/badge/Linux-x64%20(systemd)-FCC624">
  <img alt="Node" src="https://img.shields.io/badge/node-24%2B-success">
  <a href="README.md"><img alt="English" src="https://img.shields.io/badge/docs-English-blue"></a>
</p>

<p align="center">
  <img src="docs/media/tour.png" width="880" alt="ClaudeRipple 设置界面一览：状态、模型映射、供应商、客户端、请求日志">
</p>

<table align="center">
  <tr>
    <td align="center" width="34%"><img src="docs/media/picker-zoom.png" width="300" alt="Claude Desktop 模型选择器中的真实模型名称"><br><sub>GPT 模型以真实名称出现在 Claude Desktop 的模型选择器中</sub></td>
    <td align="center" width="66%"><img src="docs/media/luna-answer.png" alt="GPT-5.6 Luna 在 Claude Desktop 的 Code 标签页中作答"><br><sub>GPT-5.6 Luna 在 Code 标签页中按你选择的推理强度作答</sub></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><img src="docs/media/subagents.png" alt="运行在 GPT-5.6 Terra 和 Sol 上的子代理，在后台任务面板中显示模型名称"><br><sub>运行在 GPT-5.6 Terra 和 Sol 上的子代理，在后台任务面板中显示模型名称</sub></td>
  </tr>
</table>

---

## 1P 而非 3P：本项目存在的意义

Claude Desktop 已经提供了使用其他模型的官方方式——**推理网关**（inference gateway）设置，也就是应用里所说的第三方模式，简称 **3P** 模式。它不是针对单个会话的开关：开启后，**整个应用**会在启动时切换到另一种部署模式，而这种模式就是另一个产品：

- 窗口不再加载 `claude.ai`，改为加载本地打包的页面。claude.ai 的 `/api/` 和 `/v1/` 调用一律返回 `custom_3p_not_available` 503。
- “聊天”不再是 claude.ai 聊天，而是一个 Claude Code 本地代理会话。
- Remote Control 和侧边会话被直接关闭（`shouldEnableSessionsBridge()` 返回 false）。
- Anthropic 自家的 claude.ai 连接器、Claude Design、移动端接续和聊天搜索也随之消失。

不存在折中的设置。“聊天走 Claude、Code 走网关”对任何人来说都不可能，因为 1P 模式根本不会把任何请求发往网关。（以上内容均读自应用自身的代码包；见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §2。）

**ClaudeRipple 从不碰这个设置。** 应用保持 1P 模式，登录着你的 Claude 订阅，而由另一个模型在 Code 标签页及其子代理中作答——在模型选择器中显示它的真实名称，并使用你选择的推理强度。你不必拿 Claude 账号去换 GPT 账号，而是在一个应用里两者兼得。

留在 1P 带来三项好处，任何基于网关的工具都一项也给不了：

- **在手机上用 GPT 写代码。** 3P 下 Remote Control 是关闭的。这里它保持开启，你可以在手机上选好模型、派发任务，然后看着提交一个个落地。
- **另一个模型干活时，连接器依然可用。** 3P 会把 claude.ai 的调用替换成空壳，Anthropic 自家的连接器也随之失效。在这里你可以读取 Google Drive 文档，再让 GPT 来写代码。
- **云端会话与侧边会话。** 3P 下不复存在，这里原封不动。

如果你在为 Claude 付费，3P 就不是一个可行的选项——它会白白丢掉你所付订阅的一半价值。这是唯一既能保住订阅、又能自由选择模型的方式。

## 常见问题

### 能在 Claude Desktop 应用里用 GPT 吗？

可以——在 **Code 标签页**及其子代理中。安装 ClaudeRipple，用 ChatGPT Plus 或 Pro 订阅登录，GPT（GPT-6 Sol、Luna、Astra、GPT-5.6 Terra 等）就会以真实名称出现在模型选择器中，并使用你选择的推理强度。应用本身不会被修改，也不会被切换到任何其他模式。普通的 **聊天**标签页仍然是 Claude：不把整个应用切到网关模式，任何工具都无法转发它（见 [1P 而非 3P](#1p-而非-3p本项目存在的意义)）。

### 怎样在 Claude Code 中使用 GPT？

同一次安装也覆盖终端里的 `claude` CLI。ClaudeRipple 是一个本地代理，只需在 `~/.claude/settings.json` 中写入两行，Claude Code 就会指向它，因此在另一个模型作答时，你的技能、钩子、MCP 服务器、`CLAUDE.md` 和子代理都照常工作。

### 需要开启 Claude Desktop 的“第三方推理”（网关）设置吗？

不需要——而且不应该开启。该设置会把整个应用切换到 3P 模式：不再加载 claude.ai，聊天被替换为本地代理会话，Remote Control 也会被关闭。ClaudeRipple 从不碰它。

### 会失去 claude.ai 聊天、Remote Control 或连接器吗？

不会。应用始终登录着你的 Claude 订阅，所以聊天、手机端 Remote Control、云端会话和 Anthropic 自家的连接器都照常可用。这正是留在 1P 的意义所在。

### 还能继续使用 Claude 本身吗？

可以。模型映射按模型名称逐个设置：某个名称仍映射到 Claude，它就以 Claude 的身份作答。大多数人只把一两个名称映射到 GPT，其余保持不变。

### 需要 OpenAI API 密钥吗？

不需要。任何包含 Codex 的 ChatGPT 套餐都可以——Plus、Pro 和 Business，以及工作区管理员已开启 Codex 的 Enterprise 或 Edu。你在应用内登录即可，全程不涉及 API 密钥。套餐的用量限制照常适用；额度用完后，你另行购买的 Codex 点数（credits）会接着使用。API 密钥用于其他供应商（DeepSeek、Kimi、GLM、OpenRouter，以及任何提供 Anthropic 或 OpenAI 兼容端点的服务）。

### 能用哪些模型？

通过 ChatGPT 订阅使用 GPT；通过 OpenRouter 或直接使用 API 密钥接入 DeepSeek、Kimi、GLM、Grok、Qwen 等 400 多个模型。Claude 模型照常可用。

### 支持 Windows 吗？

支持，Windows 和 macOS 的 arm64 与 x64 均可。安装、控制面板、重启和卸载已在 Windows 11 arm64 上实测；x64 运行时在模拟环境下实测。只要有 systemd 用户会话，Linux 也能使用：安装、经路由服务转发的 Code 标签页请求、流式回答中途重启以及卸载，均已在 Ubuntu 24.04 x64 搭配 Claude Desktop 2.2553.13 上实测，选择器模式同样如此：`cli.extraModels` 中的模型会与 Claude 自己的模型一起出现在 Code 标签页的模型选择器中。

### 我的代码会被发送到别处吗？

不会。代理运行在你自己的电脑上。请求只发往你配置的供应商，不会发往其他任何地方，凭据也只保存在你的主目录中。见[隐私](#隐私)。

### Claude 账号会被封吗？这违反 Anthropic 的条款吗？

ClaudeRipple 对 Claude 所做的事很少，而且可以核查：留在 Claude 上的请求，离开你电脑时与 Claude Code 发出的内容逐字节一致；路由到 GPT 或其他供应商的请求则根本不会到达 Anthropic。它依靠的是 Claude Code 为企业网络提供文档说明的代理和证书设置（`HTTPS_PROXY`、`NODE_EXTRA_CA_CERTS`——[企业网络配置](https://code.claude.com/docs/en/corporate-proxy)），而不是给应用打补丁。关于账号被封的报告，说的都是相反的方向——在**另一个**程序中使用 Claude 订阅登录。ClaudeRipple 有一项这类可选功能：在 Codex 中借助你的订阅登录使用 Claude。这种用法受 Anthropic 条款约束；改用 Anthropic API 密钥则可以避开这个问题。轮换使用多个 Claude 订阅，同样需要你依据这些条款自行决定。账号会受到怎样的处理只有 Anthropic 能说了算，因此本文的任何内容都不构成承诺。

### 通过 Google 账号使用 Gemini 呢？

AI Studio API 密钥是 Google 支持的方式，也是安全的方式。Google 账号登录（Antigravity）则不同：Google 的 [Antigravity 条款](https://antigravity.google/terms)（第 6 节）和 [Gemini CLI FAQ](https://geminicli.com/docs/resources/faq/) 都明确指出，在其他程序中使用这些凭据属于违规。2026 年 2 月，Google 停用了以这种方式使用的账号——停用还连带切断了 Gemini CLI 和 Code Assist——并[表示](https://github.com/google-gemini/gemini-cli/discussions/20632) 再次违规将永久停用。ClaudeRipple 之所以提供这种登录方式，是因为其他工具也提供、且有用户提出了需求；它会在开始前显示这条警告，也不会做任何隐藏流量的处理。如果一定要用，请使用备用账号。

### 能使用多个 ChatGPT 账号吗？

可以。每执行一次 `clauderipple login`（或在控制面板中点击 **+ 添加 ChatGPT 账号**）就会添加一个账号。某个账号达到用量上限时，同一请求会转到下一个账号，用尽的账号则休息到其额度窗口重置为止；同一对话会留在作答的账号上，以保留其提示缓存。这适用于 Claude Desktop 的 Code 标签页、Claude Code，以及 Codex 应用和 CLI 中的 GPT。

### 能在 Codex 中使用 Claude 吗？

可以。`clauderipple codex on` 会把 ClaudeRipple 添加为供应商，Claude 模型就会以各自的名称出现在 Codex 应用和 CLI 的模型列表中。它们通过你的 Claude Code 登录或 Anthropic API 密钥作答。见 [Codex 应用与 Codex CLI](#codex-应用与-codex-cli)。

### 能生成图片吗？

可以，只需 ChatGPT 订阅，无需 API 密钥：`clauderipple image "a red paper boat" -o boat.png --aspect square`。`--ref FILE` 可添加参考图，`--transparent` 可生成透明背景。生成一张图片约需 30 秒，分辨率和画质由订阅决定。ClaudeRipple 生成的子代理也会被告知同样的调用方式，因此它们也能生成图片。见 [Claude Code](#claude-code终端remote-control子代理)。

### GPT 在 Claude Code 里表现会更差吗？

Claude Code 的系统提示词和工具描述是为 Claude 编写的，所以其他模型读到的是为别的模型调校的指令，表现可能与在其自家客户端中略有不同。ClaudeRipple 会告知每个模型自身的名称和推理强度，调整厂商会拒绝的工具 schema，并允许你按供应商追加指令。常见的配置是以 Claude 作为主模型，GPT 或 DeepSeek 作为子代理。

### 和 CC Switch、opencodex、claude-code-router 有什么区别？

见[对比表](#一个工具顶四个)。简而言之：ClaudeRipple 能在应用保持登录 Claude 的同时接入 Claude **Desktop** 的 Code 标签页，并在模型选择器中以真实名称显示其他模型。CC Switch 也能接入桌面应用，但方式是开启它的网关（3P）模式。

### 免费吗？

免费。ClaudeRipple 以 GPL-3.0 协议开源。你只需为已经在用的订阅或 API 密钥付费。

## 一个工具顶四个

同类工具能让 Claude Code CLI 或 Codex CLI 使用其他模型，但它们要么无法接入 Claude **桌面应用**，要么只能通过其网关（3P）模式接入，而一旦切换模型，你就会失去 Claude 订阅那一侧的功能（claude.ai 聊天、Remote Control、云端会话）。ClaudeRipple 用一个菜单栏应用同时覆盖桌面应用、终端和 Codex，让两份订阅并行使用，并保持 Claude Code 的整套运行框架（harness）完好无损：在另一个模型负责思考时，你的技能、钩子、MCP 服务器、`CLAUDE.md`、子代理和 claude.ai 连接器都照常工作。

| | ClaudeRipple | CC Switch（2026-09-24 核实） | opencodex / openclaude（2026-09-16 核实） | claude-code-router | Claude Desktop 网关（3P）模式 |
|---|---|---|---|---|---|
| **无需**网关（3P）模式即可使用 Claude **Desktop** 的 Code 标签页 | ✅ | ❌ ² | ❌ ¹ | ❌ | ❌ 本身即是 3P |
| 保留 claude.ai 聊天、Remote Control、云端会话、连接器 | ✅ | ❌ | ❌ | ❌ | ❌ |
| Claude 与 GPT 订阅并行使用 | ✅ | ❌ 一次只能用一个供应商 | ❌ 全有或全无 | ❌ | ❌ |
| Desktop 模型选择器中显示真实模型名称 | ✅ | ❌ `claude-*` 角色名 ² | ❌ | ❌ | 部分支持 |
| 多个 ChatGPT 账号，一个用尽自动切换（Desktop 和 Codex） | ✅ | ❌ 需手动切换 ³ | ✅ | ❌ | ❌ |
| 终端 `claude` CLI | ✅ | ✅ | ✅ | ✅ | ✅ |
| Codex **应用**和 Codex CLI → Claude | ✅ | ✅ | ✅ | ❌ | ❌ |
| 需格式转换的供应商的提示缓存 | 实测 **94–99 %** | 未测量 | 未测量 | 不定 | 不适用 |
| 任务面板中以真实模型名标注子代理 | ✅ | ❌ | ❌ | ❌ | ❌ |
| 图形化设置界面，无需终端 | ✅ | ✅ | ❌ | ❌ | ❌ |
| 经签名和公证、自带运行时的应用 | ✅ | ✅ | ❌ | ❌ | – |

¹ opencodex 的 README 在演示中展示过 Claude Desktop，但无论在代码仓库还是文档站点上，都没有公布相应的配置步骤（2026-09-16 核实）。当时接入桌面应用的唯一公开途径就是官方网关设置——即最后一列。

² CC Switch 接入 Claude Desktop 的方式是写入应用的第三方配置文件（`Claude-3p/claude_desktop_config.json`，`"inferenceProvider": "gateway"`），也就是最后一列。通过它的本地网关，模型选择器中只会显示 `claude-sonnet-*`、`claude-opus-*` 和 `claude-haiku-*` 这类角色名（[其使用手册](https://github.com/farion1231/cc-switch/blob/main/docs/user-manual/en/2-providers/2.6-claude-desktop.md)）。CC Switch 管理的工具比本表涵盖的更多（Gemini CLI、OpenCode 等），还能在这些工具之间同步 MCP 服务器和技能。

³ 每个 ChatGPT 账号都绑定在各自的供应商卡片上，而官方 ChatGPT 卡片不会进入故障转移队列（v3.20.0 发行说明）。

桌面应用自带的“第三方推理”设置会把整个应用切换到另一种模式：你会失去 claude.ai 聊天、Remote Control 和云端会话。替换 `ANTHROPIC_BASE_URL` 的工具始终无法接入桌面应用，而能接入的那些工具写入的也正是这个设置。ClaudeRipple 则是一个只有 Claude Code 进程才信任的小型 HTTPS 代理：你映射的模型的请求发往你的供应商，其余一切都逐字节原样发往 Anthropic。

## 功能一览

- **在 Claude Desktop 和 Claude Code 中使用任意模型。** 通过你的 ChatGPT Plus/Pro 订阅使用 GPT-6 Sol / Luna / Astra 和 GPT-5.6 Terra / Sol / Luna（OpenAI 一上线新模型，当天就会出现），也可以使用 Google Gemini，或 DeepSeek、Kimi、GLM、MiniMax、Qwen、Grok、Mistral、Groq、Together、Fireworks、OpenRouter（400 多个模型）以及本地的 Ollama / LM Studio。它们可以以真实名称出现在模型选择器中，也可以映射到某个 Claude 模型名上。
- **在 Codex 应用和 Codex CLI 中使用 Claude。** 一个本地 OpenAI 兼容端点，Codex 会把它当作供应商；Claude 模型出现在 Codex 自己的模型列表中。使用你当前的 Claude Code 登录或 Anthropic API 密钥。
- **多个 Claude 账号，且不破坏提示缓存。** 为原生 Claude 供应商开启账号轮换，在控制面板中添加订阅，每个对话都会留在作答的账号上。在响应开始之前，如果遇到额度或认证拒绝，该轮请求会转到下一个账号。这条原生 Claude Desktop/Code 路径与经格式转换的 Codex 入口相互独立，后者只选用一个可用的登录，不轮换账号。
- **多个 ChatGPT 账号。** 每执行一次 `clauderipple login`（或在控制面板中点击 **+ 添加 ChatGPT 账号**）就会添加一个。某个账号达到上限时，由下一个账号接手同一请求，用尽的账号休息到其额度窗口重置为止；同一对话留在作答的账号上，以保留缓存。这覆盖 Claude Desktop 的 Code 标签页和子代理，**以及 Codex 应用和 CLI 中的 GPT**——Codex 保留自己的登录，无需退出登录即可切换到下一个账号。
- **完整的 Claude Code 运行框架，原封不动。** 技能、钩子、MCP、`CLAUDE.md`、子代理、计划模式、手机上的 Remote Control：一样都不会被关闭。
- **从设计上保证正确。** 保留提示缓存（Anthropic 缓存断点和稳定的 OpenAI 前缀），处理 Claude Code 的服务端线程，完整保留双向传递的工具调用和图片，将推理强度限定在各模型接受的范围内，并为兼容厂商去除 Anthropic 专有的请求字段。
- **真正的请求日志。** 逐条记录谁发起了请求、哪个模型作答、输入 / 缓存 / 输出 token、延迟和状态，并附最近一小时的汇总。
- **子代理名称标签。** 后台任务面板显示 `Terra·high · Review`，而不是笼统的“Agent”。
- **在输入处看到路由。** 一个 Claude Code mod 会在输入框上方显示一行信息：上一个请求发往何处、推理强度、缓存命中率和耗时。`Log`（或 `/ripple-log`）会在侧边窗格中打开请求日志，按供应商和结果着色；`×`（或 `/ripple-bar`）可隐藏这一行。当 Agent 调用指定了其他模型时，同一个 mod 还会让 worker 留在自己的模型上，并读取它的 `[[ripple: name@level]]` 标记，无论标记位于提示词何处。在“客户端”页面上打开一个开关即可启用，或运行 `clauderipple mod on`。
- **用 ChatGPT 订阅生成图片。** `clauderipple image "<prompt>"`，支持参考图和透明背景。子代理会被告知用法，因此 GPT 或 DeepSeek worker 无需图像工具也能生成图片并查看结果。
- **按需精简 worker。** 打开一个开关，生成的子代理就只获得 worker 会用到的工具，而不是会话中的所有 MCP 服务器和插件：某个 worker 的首个请求因此从 33k token 降到了 9k token。
- **为不想碰终端的人而设计。** 供应商预设支持一键连接测试和模型发现，下拉式模型映射，自动保存，韩语和英语界面。菜单栏应用自带运行时，首次启动时自动完成设置。经过签名和公证。

<p align="center">
  <img src="docs/media/mapping.png" width="880" alt="模型映射：每个 Claude 模型名由哪个模型作答，以及各模型的推理强度">
</p>

## 安装

**macOS**

```sh
curl -fsSL https://raw.githubusercontent.com/PBJ-2/clauderipple/main/scripts/install.sh | sh
```

**Windows**（PowerShell）

```powershell
irm https://raw.githubusercontent.com/PBJ-2/clauderipple/main/scripts/install.ps1 | iex
```

**Linux**（带 systemd 的桌面会话）

```sh
curl -fsSL https://raw.githubusercontent.com/PBJ-2/clauderipple/main/scripts/install.sh | sh
```

路由服务以用户级 systemd 服务的形式运行：用 `systemctl --user status clauderipple` 查看状态，用 `journalctl --user -u clauderipple` 查看它的输出。选择器模式会在 Chromium 读取的 NSS 数据库（`~/.pki/nssdb`，仅限你的用户，无需 sudo）中信任本地 CA，这需要用到 `certutil`：在运行 `clauderipple picker on` 之前，先执行 `sudo apt install libnss3-tools`（Fedora：`sudo dnf install nss-tools`）。

前置条件就这些。脚本会使用你已安装的 Node 24+；如果没有，就把官方构建下载到 `~/.clauderipple/runtime`，并对照 nodejs.org 公布的校验和进行验证。然后它会完成 ClaudeRipple 的设置：一张本地证书、`~/.claude/settings.json` 中的两行配置，以及一个随开机启动的后台路由服务。无需管理员权限，也无需密码。

如果已经装有 Node，也可以跳过脚本：

```sh
npm install -g clauderipple
clauderipple install
```

然后打开控制面板并添加供应商：

```sh
clauderipple ui
```

**供应商** → 添加 ChatGPT 或粘贴 API 密钥 → **模型映射**。

**菜单栏 / 托盘应用**是可选的。它显示路由服务的状态，点一下就能打开控制面板：

```sh
clauderipple tray
```

它基于 Electron，体积约 270MB，因此默认不安装。`clauderipple tray --install` 会下载一次；除此之外的一切不需要它也能正常工作。

**更新。** 有新版本时，托盘应用会提示（**检查更新…**），也可以运行：

```sh
clauderipple update
```

它会按你当初的安装方式更新——再次运行安装脚本，或通过 npm——然后以新版本重启路由服务。托盘应用的 Electron 会在更新后保留。

可选：若要在 Desktop 模型选择器中显示真实名称，请依次进入 **客户端 → Claude Desktop → 模型选择器 → 开启**，然后退出并重新打开 Claude Desktop。为了仅为你的用户信任本地证书，macOS 会要求输入登录密码，Windows 会显示带有证书指纹的确认对话框；Linux 则直接将其添加到你的 NSS 数据库，不做询问。ClaudeRipple 永远看不到任何密码，所有平台都不需要管理员权限。

> **只关闭 Claude Desktop 的窗口是不够的。** 它会继续运行，下次启动时直接复用该进程，不会读取新设置。请彻底退出（macOS：⌘Q；Windows：通过托盘图标或任务管理器；Linux：Ctrl+Q 或托盘图标，直到 `pgrep -f claude-desktop` 没有任何输出），否则模型选择器会悄无声息地保持原样。

<details>
<summary>从源码安装（Node 24）</summary>

```bash
git clone https://github.com/PBJ-2/clauderipple && cd clauderipple && npm install
node packages/cli/src/index.ts install   # certs, settings.json env, supervisor (launchd / Task Scheduler), end-to-end probe
node packages/cli/src/index.ts ui        # open the local GUI in your browser
```

`uninstall` 会撤销所有改动，并从备份恢复 `~/.claude/settings.json`。其他命令：`status`、`start`、`stop`、`restart`、`logs -f`、`login`、`logout`、`claude-login`、`claude-logout`、`picker on|off`、`agent-title on|off`、`mod on|off`、`codex on|off`、`update`、`image "<prompt>"`。
</details>

## 客户端

### Claude Desktop

安装后即可直接使用。在 **模型映射** 中映射模型（自动保存），或开启**选择器模式**，在应用自带的模型选择器中按名称看到供应商的模型。在应用中选择的推理强度会原样传递；不支持的档位会被调整到最接近的可用档位。

### Claude Code（终端、Remote Control、子代理）

同一个路由服务，同一套映射。`/model gpt-5.6-terra` 会列出你添加的模型。子代理遵循同样的路由；在子代理提示词中加入 `[[gpt: sol@xhigh]]` 标记，可覆盖该次调用所用的模型，任务面板会显示真实的模型名称。

**你无需为此专门搭建代理运行框架。** 将子代理槽位设为一个经路由服务转发的模型，所有子代理就都会使用它——不需要代理文件，也不需要其他配置：

```jsonc
// Settings → CLI models, or "cli": { "models": { … } } in the config
{ "subagent": "gpt-5.6-terra" }   // → CLAUDE_CODE_SUBAGENT_MODEL
```

**你勾选的每个模型同时也是一个具名子代理。** 对于恰好由一个供应商提供的每个模型，路由服务都会写入 `~/.claude/agents/<name>.md`（`gpt-5.6-terra` → `gpt-5-6-terra`，`deepseek-v4.1-flash` → `deepseek-v4-1-flash`），因此“让 DeepSeek 来做”只需勾选该模型即可：Agent 工具会列出它，`subagent_type: "deepseek-v4-1-flash"` 会运行它，任务面板也会显示它的名称。取消勾选，对应的文件就会删除。路由服务只会改动它自己写入的文件（记录在 `generated-agents.json` 中）；你自己编写的同名代理文件优先，且不会被改动。因此，自定义任务说明仍然只需使用 Claude Code 原有的代理文件，并填入路由服务能识别的 `model:`：

```markdown
---
name: reviewer
description: Independent review on GPT-5.6 Sol.
model: gpt-5.6-sol@medium
---
You are the reviewer for this session. Verify the change yourself and report
the conclusion only.
```

单次调用的推理强度写在子代理提示词的**第一行**：`[[ripple: gpt-5-6-terra@high]]`——这里可以使用任何代理名称或模型 ID。位于其他位置的标记会被当作普通文本忽略（压缩摘要引用标记时，不得改变会话的路由）。路由服务找不到对应供应商的模型会被直接拒绝，并在错误中指明模型名称（`400 ClaudeRipple: no provider declares "…"`），而不是继续转发，让它在难以诊断的环节失败；原生 Claude 模型则始终直接放行。设置 `"cli": { "agentFiles": false }` 即可关闭生成。

默认情况下，生成的 worker 会继承会话的全部工具，因此每个 MCP 服务器和插件都会随每个 worker 请求一起发送。`"cli": { "limitWorkerTools": true }`（或控制面板中的 **Worker 工具**）只为它提供读取、编辑、运行、搜索和技能工具，这让某个 worker 的首个请求从约 33k token 降到了 9k token。这样的 worker 没有浏览器或模拟器工具。需要这些工具的 worker 应使用你自己编写的代理文件，这类文件永远不会被改动。

配置了 ChatGPT 供应商后，图片也由同一订阅生成：

```bash
clauderipple image "a red paper boat, flat illustration" -o boat.png --aspect square
```

`--transparent`、`--format png|jpeg|webp` 和 `--ref FILE`（参考图，可重复指定）均为可选。生成一张图片约需 30 秒。订阅后端会自行决定分辨率和画质，所以画面比例要用文字描述来指定（`--aspect`）。该命令是管理端口上 `POST /api/image` 的客户端，该接口直接返回图片字节。生成的 worker 会被告知它的 `curl` 写法，因此只能用 Bash 的 worker 也能生成图片并读回查看。

Claude Code 会把 `WebSearch` 作为一个单独的小模型请求来执行。为了避免路由到 ChatGPT 的配置为这个请求消耗 Anthropic 额度，可在 `config.json` 中将同一个 ChatGPT 供应商选为搜索后端：

```jsonc
{ "webSearch": { "provider": "chatgpt", "model": "gpt-5.6-terra" } }
```

这需要手动开启。未设置 `webSearch` 时，Claude Code 现有的搜索路径保持不变。

### Codex 应用与 Codex CLI

```bash
clauderipple codex on     # adds a "clauderipple" provider to ~/.codex/config.toml (backup first)
codex --profile clauderipple -m claude-sonnet-5
```

`codex on` 还会让 Codex 内置的 OpenAI 供应商指向 ClaudeRipple（`openai_base_url`）。Codex 保留其 ChatGPT 登录；它的 GPT 请求原样转发给 ChatGPT，唯一的区别是所用账号从添加到 ClaudeRipple 的账号中选择——因此添加了多个账号时，Codex 也会从用尽的账号切换到下一个。如果一个都没添加，或全部都已达到上限，则使用 Codex 自己的登录。你自己设置的 `openai_base_url` 不会被改动。`clauderipple codex off` 可撤销这些更改。

Claude 模型会以各自的名称出现在 Codex 的模型列表中（ClaudeRipple 会在 Codex 自己的模型目录旁写入一份模型目录）。访问 Claude 时使用你的 Claude Code 登录（从运行中的 Desktop 会话、终端登录或 ClaudeRipple 自己的登录中检测：**供应商 → Claude (Anthropic) → + 添加 Claude 账号** 会打开浏览器，无需终端；效果与 `clauderipple claude-login` 相同），或使用 Anthropic API 密钥。复用订阅登录受 Anthropic 条款约束。你配置的任何 Anthropic 兼容供应商也都能以同样的方式使用。

<p align="center">
  <img src="docs/media/add-provider.png" width="880" alt="添加供应商：ChatGPT 订阅、预设、OpenAI 兼容供应商">
</p>

## 供应商

| 供应商 | 类型 | 认证 | 模型列表 | 备注 |
|---|---|---|---|---|
| ChatGPT 订阅 | Codex 后端 | 可登录多个账号，一个用尽自动切换（也会复用 Codex 登录） | 从你的订阅读取（GPT-6 Sol、Luna、Astra、GPT-5.6 …） | 推理强度 low…max（Luna：ultra），提示缓存 94–99 % |
| Google Gemini | Gemini API | AI Studio API 密钥，或 Google 账号登录（Antigravity，见[常见问题](#通过-google-账号使用-gemini-呢)） | 自动发现 | 格式转换（Messages ⇄ generateContent），跨轮次保留思维签名（thought signatures） |
| Grok 订阅 | Grok CLI 聊天代理 | Grok CLI 的登录（`grok login`），由 CLI 刷新 | 从你的订阅读取（Grok 4.7、4.7 Fast、4.6、4.5） | 格式转换（Chat Completions），推理强度 low…xhigh；CLI 自己的通道，不是公开 API（[§4e](docs/ARCHITECTURE.md#4e-grok-providers-implemented-2026-10-08)） |
| OpenRouter | Anthropic 兼容 | API 密钥 | 400+，自动发现 | 从 API 读取各模型对推理强度的支持情况 |
| DeepSeek、Kimi、Z.ai GLM、MiniMax、Qwen（国际版 / 国内版） | Anthropic 兼容 | API 密钥 | 预设 | 已对照厂商文档验证 |
| xAI Grok、Mistral、Groq、Together、Fireworks | OpenAI 兼容 | API 密钥 | 自动发现 | 格式转换（Chat Completions / Responses） |
| Ollama、LM Studio | OpenAI 兼容，本地 | 无 | 自动发现 | |
| Anthropic | 原生 | Claude 登录（可多个）或 API 密钥 | Claude 模型 | Claude Desktop/Code 可选粘性轮换；Codex 只选用一个登录 |
| 其他任何服务 | 自定义 | 自行选择 | 自动发现 | 任何 Anthropic 或 OpenAI 兼容端点 |

发往兼容供应商的请求会清除 Anthropic 专有字段（服务端线程、延迟加载的工具、上下文管理、thinking 绑定），推理强度也会按模型进行限定，因此厂商不会因为 Claude Code 的请求结构而返回 400。

## 工作原理

```
Claude Desktop / claude CLI ──HTTPS_PROXY──▶ ClaudeRipple ──▶ api.anthropic.com   (unchanged)
                                               │
                        mapped model ──────────┼──▶ chatgpt.com/backend-api (Responses ⇄ Messages)
                                               ├──▶ Anthropic-compatible vendors (+ compat layer)
                                               ├──▶ OpenAI-compatible vendors (Messages ⇄ Chat/Responses)
                                               └──▶ Google Gemini (Messages ⇄ generateContent)
Codex app / CLI ──/v1/responses──▶ ClaudeRipple ingress ──▶ Claude (your login or API key) / vendors
```

- Claude Code CLI 从 `~/.claude/settings.json` 读取 `HTTPS_PROXY` 和 `NODE_EXTRA_CA_CERTS`（即 Anthropic 文档中说明的企业代理方式）。只有这个进程信任 ClaudeRipple 的本地 CA；除非你开启选择器模式，否则操作系统的钥匙串不会被改动。
- 选择器模式会让应用自身的 claude.ai 流量经过代理，并把你的模型加入应用启动时获取的模型选择器列表。一键即可再次关闭。
- 路由服务重启时会等待进行中的调用处理完毕，上游连续失败时会自行退出以便由 launchd 重启，会轮转日志，并且绝不会悄无声息地丢弃请求。

附出处的详细说明：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 隐私

一切都运行在 127.0.0.1 上。API 密钥保存在 `~/.clauderipple/config.json` 中，添加的 Claude OAuth 授权保存在 `~/.clauderipple/claude-accounts.json` 中（两者权限均为 0600）。管理 API 和日志既不暴露 token，也不暴露上游账号 ID。唯一的网络目的地是你配置的供应商。没有任何遥测。

## 状态：Alpha

作者每天都在使用，但项目还很年轻。难免会有粗糙之处：

- **Windows 支持是新加入的（2026-09-14）。** 安装、设置、路由服务、登录、模型选择器和一次真实的 GPT 调用已在 x64 硬件上验证；崩溃恢复已在 arm64 上验证。窗口仍使用 Windows 默认标题栏。Windows 版本未签名；见“安装”一节中的说明。
- **Linux 支持是新加入的（2026-09-24）**，由社区贡献，并附有在 Ubuntu 24.04 x64 上的实测结果（安装、Code 标签页请求、流式传输中途重启、选择器模式、卸载）。需要 systemd 用户会话；其他发行版和 arm64 尚未测试。
- ChatGPT、OpenRouter 和 Codex 中的 Claude 已用真实账号验证；其他预设依据厂商官方文档配置。
- 添加到模型选择器的模型从下一个会话起可用。
- Claude Code 和 Codex 经常更改其通信协议；客户端更新后，某个格式转换可能会失效，直到 ClaudeRipple 跟进为止。欢迎提交 bug 和日志。

## 无关联声明

ClaudeRipple 是一个独立的开源项目。它与 Anthropic 或 OpenAI 均无关联，也未获得二者的认可或赞助。Claude 和 Claude Code 是 Anthropic, PBC 的商标。ChatGPT 和 Codex 是 OpenAI 的商标。

## 许可证

Copyright (c) 2026 pbj. GPL-3.0——见 [LICENSE](LICENSE)。可自由使用；如果你分发修改后的版本，须以相同许可证提供其源代码。

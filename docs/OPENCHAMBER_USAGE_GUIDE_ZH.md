# OpenChamber 中文详细使用手册

> 本手册面向希望在本机、局域网、NAS 或 Docker 中使用 OpenChamber 的用户。
> 内容按当前 main 分支整理。OpenChamber 的界面标签仍以英文为主，本文会同时保留常用英文名称，方便对照操作。

## 0. 先理解 OpenChamber 和 OpenCode 的关系

OpenChamber 不是一个大模型，也不是独立的 Agent Runtime。它是 OpenCode 上层的工作区和控制台，负责管理项目、会话、终端、Diff、Git、Worktree、远程访问和多端界面。

可以把它理解成下面这条链路：

~~~text
浏览器 / PWA / VS Code / Electron / iOS / Android
                         │
                         ▼
             OpenChamber Web Server
                         │
                         ▼
             OpenCode Server（托管或外部）
                         │
                         ▼
       OpenAI / Anthropic / DeepSeek / Ollama 等 Provider
~~~

配置时要分清两层：

- OpenChamber 配置：监听地址、Web UI 密码、数据目录、远程访问、终端和 Git。
- OpenCode 配置：Provider、API Key、模型、Agent、MCP 和 Skills。

Provider 登录信息由 OpenCode 保存，因此 OpenCode CLI 和 OpenChamber 可以共享登录状态。不要把所有模型配置都塞进 OpenChamber 的环境变量里。

官方项目：<https://github.com/openchamber/openchamber>

官方文档：<https://docs.openchamber.dev/zh-cn/>

---

## 1. 选择运行方式

| 方式 | 适合场景 | 主要前提 |
| --- | --- | --- |
| Desktop | macOS、Windows、Linux 本机日常使用 | 下载对应桌面安装包 |
| CLI + Web/PWA | 在服务器或开发机上运行，用浏览器和手机访问 | Node.js 22+、OpenCode CLI |
| VS Code 扩展 | 想让会话紧贴当前代码目录 | VS Code、OpenCode CLI |
| Docker Compose | NAS、Linux 服务器、家庭内网 | Docker、可持久化挂载目录 |
| Mobile | 在手机上查看和控制已有服务器 | 先运行 OpenChamber Server，再配对设备 |

当前源码的主要技术栈是 Bun Workspaces、React、TypeScript、Vite、Tailwind CSS、Zustand、Express、Electron、Capacitor 和 VS Code Webview。源码目录大致如下：

~~~text
packages/ui        共享 React UI、状态和运行时契约
packages/web       Web UI、Express Server、CLI、OpenCode 生命周期
packages/electron  Electron 桌面端
packages/mobile    Capacitor iOS/Android 外壳
packages/vscode    VS Code 扩展和 Webview
packages/docs      官方文档源文件
~~~

---

## 2. 前提条件和版本检查

CLI/Web 运行前，先安装 OpenCode。桌面发行版会捆绑匹配的 OpenCode CLI；CLI/Web 和 VS Code 使用你系统里已安装的 OpenCode。

检查本机环境：

~~~bash
node --version
bun --version
opencode --version
openchamber --version
git --version
~~~

CLI/Web 当前以 Node.js 22+ 为准。源码开发和 Docker 构建使用 Bun；当前仓库的 package.json 声明了对应的 Bun 版本。

如果只使用桌面应用，不需要先手动安装 OpenCode；如果使用 CLI、Web 或 VS Code，建议先确认下面的命令可用：

~~~bash
opencode --version
~~~

---

## 3. 本机 CLI + Web/PWA 快速启动

### 3.1 安装 CLI

~~~bash
curl -fsSL https://raw.githubusercontent.com/openchamber/openchamber/main/scripts/install.sh | bash
~~~

安装后重新打开终端，或根据安装脚本提示补充 PATH。

### 3.2 启动本机实例

建议使用环境变量设置密码，这样不会把密码直接放进进程参数：

~~~bash
export OPENCHAMBER_UI_PASSWORD='请在本机安全设置一个强密码'
openchamber --port 3000
~~~

然后打开：

~~~text
http://127.0.0.1:3000
~~~

成功标准：浏览器能够打开 OpenChamber 会话列表，并且可以进入 Settings 页面。

如果只在本机临时使用，也可以直接执行：

~~~bash
openchamber --ui-password '请在本机安全设置一个强密码'
~~~

### 3.3 前台运行、后台运行和日志

普通的 openchamber 命令会在后台启动服务。需要把进程绑定在当前终端时，使用 --foreground：

~~~bash
openchamber --port 3000 --foreground
~~~

常用管理命令：

~~~bash
openchamber status
openchamber logs
openchamber restart
openchamber stop
~~~

排障时先运行：

~~~bash
openchamber status
openchamber logs
~~~

### 3.4 登录时自动启动

OpenChamber 会按操作系统安装用户级服务：macOS 使用 launchd，Linux 使用 systemd --user，Windows 使用 Task Scheduler。

~~~bash
OPENCHAMBER_UI_PASSWORD='请在本机安全设置一个强密码' openchamber startup enable
openchamber startup status
openchamber startup disable
~~~

如果是无界面的服务器，使用 headless API 模式：

~~~bash
openchamber startup enable --port 3000 --api-only --host 0.0.0.0 --ui-password '请在本机安全设置一个强密码'
~~~

startup enable 默认会保存当前环境快照，包括 Provider token、PATH、SSH Agent 和其他 CLI 配置。如果之后修改了环境变量，需要重新执行 startup enable。

如果希望服务只继承最小环境，可以加上：

~~~bash
openchamber startup enable --no-env-snapshot
~~~

---

## 4. 第一次打开后的配置顺序

建议按下面的顺序配置，不要一上来就配置隧道或公网访问。

### 4.1 连接 Provider

打开：

~~~text
Settings → Providers
~~~

然后选择一个 Provider，按它支持的方式登录：

- API Key：输入 API Key 并保存。
- Device Flow：打开网页、输入短码并批准登录。
- Other / Custom：配置 OpenAI-compatible 服务。

自定义 Provider 通常需要：

~~~text
Provider ID       例如 deepseek-internal
Display Name      例如 DeepSeek 内网
Base URL          例如 https://api.example.com/v1
API Key           直接填写，或填写 {env:MY_LLM_API_KEY}
Model ID          例如 deepseek-chat
Model Name        页面上显示的名称
Headers           只有网关需要时才填写
~~~

如果使用环境变量引用 API Key：

~~~bash
export MY_LLM_API_KEY='请在本机安全注入，不要提交到 Git'
~~~

密钥不应写入仓库、截图、Issue、日志或聊天记录。

### 4.2 选择模型

模型可以在两个地方选择：

- 聊天输入框里的模型选择器：只影响当前会话。
- Settings → Agents 中的默认模型：影响该 Agent 的新会话。

如果 Provider 显示已连接，但模型列表为空，先检查 Base URL、模型 ID 和 API Key。对于自建 OpenAI-compatible 网关，模型 ID 必须是网关实际接受的值。

### 4.3 配置 Agent

打开：

~~~text
Settings → Agents
~~~

一个 Agent 是一套命名配置，可以包含：

- description：这个 Agent 适合做什么。
- model：默认使用哪个模型。
- temperature：回答的随机性。
- prompt：每次都要遵守的固定指令。
- tool rules：允许使用哪些工具。

建议至少建立三种 Agent：

~~~text
分析       只读检查、梳理结构、给出方案
开发       允许修改代码、运行测试
审查       重点检查 Diff、风险和回归
~~~

对生产仓库，建议为审查 Agent 限制写入权限，并让它优先读取 Diff、测试结果和日志。

### 4.4 添加项目

项目通常就是一个代码仓库目录。可以从以下入口添加：

- 命令面板中的 Add project。
- 会话侧边栏顶部的 +。
- 选择目录时的文件夹浏览器。

添加后，从侧边栏选择项目。切换项目会同时切换：

- Agent 工作目录。
- 项目会话。
- Git 状态。
- 项目笔记、待办和计划。
- 项目级 Provider、MCP 和 Skill 配置。

VS Code 扩展会直接使用当前打开的文件夹作为项目。

### 4.5 第一个任务怎么写

不要只写“帮我改一下”。建议包含目标、范围、约束和验收标准：

~~~text
请先阅读 README、AGENTS.md 和相关模块文档，不要立即修改代码。

目标：修复登录页在窄屏下的布局问题。
范围：只允许修改 apps/client/src/features/auth/。
约束：不要引入依赖，不要修改接口，不要改变桌面端布局。
验证：运行前端类型检查和构建，并说明未运行的检查。
完成标准：给出修改文件、行为变化、验证命令和剩余风险。
~~~

对于较大的任务，先让 Agent 给计划，再确认计划后实施。需要长期运行时，使用“会话目标”，不要连续发送大量“继续”。

---

## 5. 日常工作流

### 5.1 会话和上下文

一个会话适合围绕一个明确目标持续工作。右侧的 Context 面板可以查看：

- 当前模型。
- 会话开始时间。
- token 使用量和模型上限。
- 消息和成本统计。
- 工具输出大致占用了多少上下文。

上下文接近上限时，优先新建会话，不要让一个会话无限增长。新会话开始时，把目标、相关文件和已经完成的验证重新写清楚。

### 5.2 项目笔记、待办和计划

在项目的 Context 标签页中可以维护：

- Notes：项目长期背景和约定。
- Todos：短期任务清单。
- Plans：可以保存、导入和再次打开的 Markdown 计划。

待办可以直接发送到：

- 当前会话。
- 新会话。
- 新的 Worktree 会话。

建议把不应遗忘的项目约定放到 Notes，而不是只放在某一次聊天里。

### 5.3 项目操作

打开：

~~~text
Settings → Projects → Project Actions
~~~

可以保存常用命令，例如：

~~~bash
pnpm dev
pnpm test
pnpm lint
docker compose up -d
~~~

运行时，OpenChamber 会在项目目录的终端里执行命令。对于启动 Web 开发服务器的操作，可以启用 auto-open URL，让 OpenChamber 自动识别本地地址并打开预览。

### 5.4 预览和调试页面

当终端输出包含 Vite、Next.js 或 Astro 的本地地址时，OpenChamber 通常会显示 Open preview。

预览面板支持：

- 查看控制台错误、警告和日志。
- 使用 Inspect 点选页面元素。
- 把元素的选择器、样式、位置和截图发送到聊天。

这比手工描述“右上角那个按钮”更准确。

### 5.5 Git 视图

打开右侧的 Git 标签页，可以：

- 查看 staged / unstaged 文件。
- 查看文件 Diff。
- 暂存或取消暂存。
- 创建、切换、重命名和删除分支。
- push、pull、fetch。
- 查看提交历史。
- stash 和恢复变更。
- 生成提交信息。
- 创建、更新和合并 PR。

推荐的提交前顺序：

~~~text
先看 Diff → 暂存目标文件 → 运行测试 → 提交 → 推送 → 创建 PR
~~~

不要只看 Agent 的口头总结，要在 Git 视图中检查实际 Diff。

---

## 6. 隔离并行任务

### 6.1 Worktree 会话

Worktree 会话会为任务创建独立的 Git 分支和文件夹。适合同时处理：

- 一个重构任务。
- 一个线上 Bug 修复。
- 一个实验性功能。

创建方式：

1. 从新会话入口选择 New worktree。
2. 选择 new branch 或 existing branch。
3. 指定 Worktree 文件夹。
4. 创建会话。

完成后，在 Git 视图中使用 Integrate 将提交带回目标分支。删除 Worktree 或分支前，先确认没有未提交的变更。

### 6.2 Multi-run

Multi-run 可以用最多五个模型或运行配置执行同一个提示词。

推荐流程：

1. 打开 Multi-run 启动器。
2. 选择项目并填写任务。
3. 选择多个模型。
4. 对会修改文件的任务开启 isolate runs。
5. 分别查看结果，再选择一个继续。

如果不开启隔离，多个运行可能会修改同一个项目目录。非 Git 项目不能使用真正的 Worktree 隔离。

### 6.3 会话目标

会话目标适合需要多轮自动推进的任务，例如：

~~~text
为导出模块补充单元测试，修复测试暴露的问题，并让整个测试套件通过。
~~~

好的目标必须自包含，因为进度审核只应依赖目标和最新结果判断是否完成。避免使用：

~~~text
继续刚才的思路
把它修好
按上面的方案做
~~~

目标运行在 OpenChamber Server 中，不是浏览器标签页中。关闭浏览器不会停止它，但如果服务器进程停止，目标也不会继续执行。

可在 Settings → Chat → Goals 设置默认 token budget。目标可以被暂停、继续、完成或标记为阻塞。

### 6.4 计划任务

计划任务会定时创建新会话并发送提示词，支持：

- daily：每天。
- weekly：每周指定日期。
- once：指定日期和时间运行一次。

创建任务时同时设置：

- Provider。
- Model。
- Agent。
- Prompt。
- 是否作为会话目标运行。

计划任务只在 OpenChamber Server 运行时触发。服务器关闭期间，任务会暂停，重新启动后继续使用调度状态。

---

## 7. MCP、Skills 和命令

### 7.1 MCP Server

打开：

~~~text
Settings → MCP
~~~

支持两类服务器：

- local：OpenChamber 在本机启动命令。
- remote：OpenChamber 访问一个远程 URL。

可以选择作用范围：

- personal：所有项目可用。
- project：只在当前项目可用。

远程 MCP 的请求头可能包含 token。不要把 token 写入提交、截图或公开配置文件。

### 7.2 Skills

Skill 是一组可复用指令，让 Agent 在相关任务中加载。例如：

- 团队提交信息规范。
- API 设计约束。
- 内网部署流程。
- 测试验收规则。

打开：

~~~text
Settings → Skills
~~~

Skill 可以保存为：

- personal：所有项目可用。
- project：只在当前项目可用。

在聊天输入 / 可以选择 Skill。位于消息最开头的 / 通常会进入命令或代码片段选择器。

Skill 的描述要写得具体，因为 Agent 会根据描述判断是否加载它。涉及写文件、执行命令或访问外部系统的 Skill，要明确权限边界和验证方式。

---

## 8. GitHub Issue 和 PR

### 8.1 连接 GitHub

打开：

~~~text
Settings → Git → GitHub → Connect
~~~

OpenChamber 会显示链接和短码。完成授权后，可以连接多个 GitHub 账号并切换。

### 8.2 从 Issue 或 PR 开始

创建 Worktree 会话时选择：

~~~text
Start from GitHub issue/PR
~~~

选择 Issue 后，OpenChamber 会：

- 使用 Issue 信息和评论作为初始上下文。
- 根据 Issue 建议分支。
- 在独立 Worktree 中启动会话。

选择 PR 后，可以检出 PR 分支并把 PR Diff 提供给 Agent。

### 8.3 PR 推荐流程

~~~text
Issue
  → Worktree 会话
  → Agent 修改和测试
  → Git Diff 审查
  → 提交并推送
  → 创建 PR
  → 处理 CI / Review 意见
  → 标记 Ready 或合并
~~~

即使 OpenChamber 能自动生成 PR 标题和描述，也应人工确认范围、测试证据、风险和是否包含敏感文件。

---

## 9. OpenCode Server 配置

### 9.1 默认托管模式

没有特殊配置时，OpenChamber 按以下顺序查找 OpenCode：

1. 复用已经启动的服务器。
2. 连接明确配置的外部服务器。
3. 检查默认端口 4096。
4. 自动启动并管理自己的 OpenCode Server。

因此，第一次使用时通常不需要设置 OPENCODE_* 变量。

### 9.2 连接外部 OpenCode

~~~bash
export OPENCHAMBER_UI_PASSWORD='请在本机安全设置一个强密码'
OPENCODE_HOST=http://127.0.0.1:4096 OPENCODE_SKIP_START=true openchamber --port 3000
~~~

OPENCODE_HOST 必须是带端口的 http 或 https origin，例如：

~~~text
正确： http://127.0.0.1:4096
正确： https://opencode.example.com:4096
错误： http://127.0.0.1:4096/api
错误： http://127.0.0.1
~~~

如果只需要切换托管 OpenCode 的端口：

~~~bash
OPENCODE_PORT=4097 openchamber --port 3000
~~~

### 9.3 OpenCode 配置相关变量

| 变量 | 用途 |
| --- | --- |
| OPENCODE_HOST | 已有 OpenCode Server 的完整地址，优先级高于 OPENCODE_PORT |
| OPENCODE_PORT | OpenCode Server 端口 |
| OPENCODE_SKIP_START | true 时不启动 OpenChamber 自己的 OpenCode |
| OPENCHAMBER_OPENCODE_HOSTNAME | 托管 OpenCode 的绑定地址，默认 127.0.0.1 |
| OPENCODE_BINARY | opencode 可执行文件路径 |
| OPENCODE_CONFIG | OpenCode 配置文件路径 |
| OPENCODE_CONFIG_DIR | OpenCode 配置目录，包含 agents、skills、snippets 等 |
| OPENCODE_DATA_DIR | 托管 OpenCode 的数据目录 |
| OPENCODE_JWT_SECRET | 持久服务使用的 UI token 签名密钥 |
| OPENCODE_WSL_DISTRO | Windows 上选择 WSL 发行版 |

### 9.4 OpenChamber Server 相关变量

| 变量 | 用途 |
| --- | --- |
| OPENCHAMBER_HOST | Web 服务监听地址；0.0.0.0 允许其他机器访问 |
| OPENCHAMBER_UI_PASSWORD | Web UI 密码 |
| OPENCHAMBER_API_ONLY | true 或 1 时只提供 API，不提供浏览器 UI |
| OPENCHAMBER_DATA_DIR | OpenChamber 数据目录，默认 ~/.config/openchamber |
| OPENCHAMBER_COMPRESS_API | 强制开启或关闭 API 压缩 |
| OPENCHAMBER_SKIP_API_COMPRESSION | true 时关闭 API 压缩，优先级更高 |
| OPENCHAMBER_VERBOSE_REQUEST_LOGS | 输出详细 HTTP 请求日志 |
| OPENCHAMBER_UPDATE_API_URL | 覆盖更新检查地址 |
| OPENCHAMBER_PACKAGE_MANAGER | 更新时强制指定包管理器 |

### 9.5 终端、Git 和辅助变量

~~~text
OPENCHAMBER_TERMINAL_SHELL        集成终端 shell
OPENCHAMBER_GIT_BINARY            OpenChamber 使用的 Git
GIT_BINARY                        Git 的备用覆盖值
OPENCHAMBER_GIT_READ_CACHE_TTL_MS Git 文件读取缓存时间
OPENAI_API_KEY                    当前主要用于语音功能
NGROK_AUTHTOKEN                   Ngrok 隧道 token
BUN_BINARY                        daemon 使用的 Bun 路径
BUN_INSTALL                       Bun 安装目录
VITE_OPENCODE_URL                 Web 构建阶段的 API 地址
~~~

VITE_OPENCODE_URL 是构建阶段变量，不要把它当成运行中的 OpenChamber 连接配置。

---

## 10. 远程访问和安全配置

OpenChamber 可以访问项目文件、终端和 Git，因此要把它当作高权限开发工具，而不是普通的静态网页。

### 10.1 只访问自己的设备：配对 + Private Relay

推荐给个人手机、桌面端和另一台浏览器使用。

在服务器端打开：

~~~text
Settings → Remote Instances → Connect to this server → Add device
~~~

选择：

- 仅本机。
- 仅家庭网络。
- 任何地方。

然后生成二维码，在另一台设备上扫描。

命令行 headless 服务器也可以生成链接：

~~~bash
openchamber connect-url --port 3000 --qr
~~~

需要外出连接时：

~~~bash
openchamber connect-url --relay --qr
~~~

配对链接只能使用一次，并且每台设备有独立 token。设备可以在设置中随时撤销。

### 10.2 局域网访问

~~~bash
OPENCHAMBER_HOST=0.0.0.0 OPENCHAMBER_UI_PASSWORD='请在本机安全设置一个强密码' openchamber --port 3000
~~~

只在可信局域网或 VPN 中使用。不要只因为端口能打开，就认为服务已经安全。

### 10.3 Cloudflare 或 Ngrok 隧道

先安装提供商 CLI：

~~~bash
brew install cloudflared
brew install ngrok
~~~

Cloudflare Quick Tunnel：

~~~bash
openchamber tunnel start --provider cloudflare --mode quick --qr
~~~

Ngrok Quick Tunnel：

~~~bash
ngrok config add-authtoken '<your-ngrok-token>'
openchamber tunnel start --provider ngrok --mode quick --qr
~~~

查看和诊断：

~~~bash
openchamber tunnel status
openchamber tunnel status --all
openchamber tunnel providers
openchamber tunnel doctor --provider cloudflare
openchamber tunnel stop --port 3000
~~~

Cloudflare 托管远程模式：

~~~bash
openchamber tunnel start --provider cloudflare --mode managed-remote --token-file ~/.secrets/cf-token --hostname app.example.com
~~~

不要把 token 直接写入 Git 仓库。managed-remote 可以用 profile 保存非敏感的连接信息，但 token 文件仍应放在安全位置。

### 10.4 反向代理

在加入 Nginx、Caddy 或 Cloudflare 反向代理前，先直接确认：

~~~text
http://服务器地址:3000
~~~

反向代理必须支持：

- WebSocket：/api/event/ws、/api/global/event/ws、/api/terminal/ws。
- SSE：/api/event、/api/global/event、/api/notifications/stream、/api/openchamber/events 和终端 stream。
- 大请求体，用于附件和文件操作。
- 长连接和较长的读取超时。
- SSE 路由关闭 buffering。
- 只保留一层压缩，避免代理和 OpenChamber 双重压缩。

页面能打开但发消息失败，通常是 WebSocket；实时状态不更新，通常是 SSE buffering 或超时；上传失败，通常是 body size 限制。

完整 Nginx、Nginx Proxy Manager 和 Caddy 示例见：

<https://docs.openchamber.dev/zh-cn/reverse-proxy/>

---

## 11. Docker Compose 部署

### 11.1 准备目录

官方 Compose 使用以下目录：

~~~text
data/openchamber       OpenChamber 配置、会话和持久数据
data/opencode/share    OpenCode share 数据
data/opencode/state    OpenCode state
data/opencode/config   OpenCode 配置
data/ssh               SSH 配置和密钥
workspaces             容器内管理的项目目录
~~~

准备目录：

~~~bash
git clone https://github.com/Allenskoo856/openchamber.git
cd openchamber

mkdir -p data/openchamber data/opencode/share data/opencode/state data/opencode/config data/ssh workspaces
~~~

Linux/NAS 上，确保挂载目录对容器的 UID/GID 1000:1000 可读写：

~~~bash
chown -R 1000:1000 data workspaces
~~~

如果你的存储系统不允许宿主机执行 chown，改用 NAS 的 ACL 给 UID 1000 对这些目录授予读写权限。

### 11.2 启动

~~~bash
export OPENCHAMBER_UI_PASSWORD='请在本机安全设置一个强密码'
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs --tail=200 -f
~~~

访问：

~~~text
http://服务器地址:3000
~~~

官方 Compose 当前要求 OPENCHAMBER_UI_PASSWORD，并把 OpenChamber、OpenCode 配置、SSH 和工作区分别挂载到宿主机目录。

### 11.3 Docker 中连接外部 OpenCode

默认 Docker 镜像会在容器中安装 OpenCode，因此通常不需要外部 OpenCode。如果需要连接宿主机上的 OpenCode，可以创建 docker-compose.override.yml：

~~~yaml
services:
  openchamber:
    environment:
      OPENCODE_HOST: $OPENCODE_HOST
      OPENCODE_SKIP_START: "true"
~~~

然后设置一个容器能访问到的地址：

~~~bash
export OPENCODE_HOST=http://host.docker.internal:4096
export OPENCHAMBER_UI_PASSWORD='请在本机安全设置一个强密码'
docker compose up -d --build
~~~

在 Linux、OrbStack、远程 Docker 或 NAS 上，host.docker.internal 是否可用取决于运行时；如果不可用，使用容器实际能访问的宿主机或内网地址。不要直接把 127.0.0.1 当成宿主机地址：在容器内它指向容器自身。

### 11.4 Docker 备份

至少备份：

~~~text
data/openchamber
data/opencode/config
data/opencode/share
data/opencode/state
data/ssh
workspaces
~~~

其中 data/ssh 可能包含 SSH 私钥，备份时使用加密存储。项目代码本身应优先通过 Git 远程仓库保存，工作区挂载不应成为唯一备份。

---

## 12. 常见问题排查

### 12.1 openchamber 一启动就退出

依次检查：

~~~bash
node --version
openchamber --version
which openchamber
openchamber logs
~~~

确认 Node.js 版本满足当前 CLI 要求，并确认安装目录在 PATH 中。必要时重新安装最新 CLI。

### 12.2 Web UI 无法访问

~~~bash
openchamber status
openchamber logs
~~~

检查：

- 端口是否已经被其他服务占用。
- 访问的端口是否与 --port 一致。
- 远程访问时是否设置了 --host 0.0.0.0 或 OPENCHAMBER_HOST=0.0.0.0。
- Docker 是否执行了 docker compose ps 并显示服务运行。
- 是否先直接访问 http://服务器地址:3000，再测试隧道或反向代理。

### 12.3 一直显示 OpenCode is restarting

先看日志：

~~~bash
openchamber status
openchamber logs
~~~

如果连接外部 OpenCode，检查：

- OPENCODE_HOST 是否包含协议和端口。
- OPENCODE_HOST 是否带了错误的 path。
- OPENCODE_SKIP_START 是否设置为 true。
- OpenChamber 进程是否能访问该地址。

正确示例：

~~~bash
OPENCODE_HOST=http://127.0.0.1:4096 OPENCODE_SKIP_START=true openchamber --foreground
~~~

### 12.4 Provider 已连接但没有可用模型

检查：

- Provider 的 Base URL 是否包含网关要求的路径。
- Model ID 是否是服务端真实支持的 ID。
- API Key 是否过期或权限不足。
- 是否把 {env:VAR_NAME} 写成了未定义的环境变量。
- 是否在聊天输入框选择了错误的 Provider/Model。

自定义 Provider 的密钥可以使用：

~~~text
{env:MY_LLM_API_KEY}
~~~

但必须确保启动 OpenChamber 的服务环境中存在 MY_LLM_API_KEY。使用 startup enable 后修改变量，需要重新启用服务。

### 12.5 项目、终端或 Git 无法访问

检查：

- 项目目录是否存在。
- OpenChamber 运行用户是否有读写权限。
- 工作区是否是 Git 仓库。
- Git 是否在 PATH 中。
- SSH key 是否挂载且权限正确。
- SSH Agent 是否被后台服务继承。

可以在同一运行环境中测试：

~~~bash
git --version
ssh -T git@github.com
~~~

不要把 SSH 私钥放进仓库，也不要为了修复权限对整个磁盘执行递归授权。

### 12.6 隧道可以启动但链接打不开

~~~bash
openchamber tunnel status --all
openchamber tunnel doctor --provider cloudflare
~~~

确认：

- 本地 http://127.0.0.1:3000 先能正常打开。
- 提供商 CLI 已安装。
- Ngrok 已配置 authtoken。
- UI password 已设置。
- 使用的端口与隧道绑定的实例一致。
- 旧的连接链接没有已经被使用或撤销。

### 12.7 反向代理后页面能开但聊天不工作

重点检查：

- WebSocket Upgrade 是否透传。
- SSE 路由是否关闭 buffering。
- proxy_read_timeout 是否足够长。
- 代理是否开启了第二层 gzip。
- 上传 body size 是否足够。

---

## 13. 安全和运维建议

1. 本机使用默认监听地址 127.0.0.1，不要无必要地绑定 0.0.0.0。
2. 只要存在局域网、VPN、隧道或反向代理访问，就设置 OPENCHAMBER_UI_PASSWORD。
3. 自己的手机和桌面设备优先使用一次性配对 + Private Relay。
4. 需要普通公开 URL 时再使用 Cloudflare 或 Ngrok 隧道。
5. 不要把 Provider Key、MCP token、SSH 私钥、配对链接和 UI 密码提交到 Git。
6. 远程服务使用长随机值设置 OPENCODE_JWT_SECRET。
7. Docker 只把需要持久化的目录挂载出来，不要随意把宿主机根目录挂进容器。
8. 生产升级前备份 data/、OpenCode 配置和工作区。
9. 让 Agent 修改代码前先确认项目、分支和 Worktree；修改后必须审阅 Diff。
10. 计划任务和会话目标会真实执行命令，启用前先确认 Agent、模型和工作目录。

---

## 14. 从源码开发这个 Fork

### 14.1 获取源码

本 Fork 的远程关系建议保持为：

~~~text
origin    你的 Fork：https://github.com/Allenskoo856/openchamber
upstream  官方仓库：https://github.com/openchamber/openchamber
~~~

检查：

~~~bash
git remote -v
~~~

### 14.2 安装和开发

~~~bash
bun install
bun run dev
~~~

常用命令：

~~~bash
bun run build
bun run build:web
bun run build:ui
bun run type-check
bun run lint
bun run docs:validate
~~~

Web 相关命令：

~~~bash
bun run dev:web:full
bun run dev:web:hmr
bun run start:web
~~~

桌面端：

~~~bash
bun run electron:dev
bun run electron:dev:bundled
bun run electron:build
~~~

VS Code 扩展：

~~~bash
bun run vscode:dev
bun run vscode:build
bun run vscode:package
~~~

### 14.3 同步官方仓库

如果本地没有未提交修改，可以这样同步官方 main：

~~~bash
git fetch upstream
git switch main
git merge --ff-only upstream/main
git push origin main
~~~

如果 main 或工作区有自己的修改，不要直接执行上面的合并命令；先查看：

~~~bash
git status --short --branch
git log --oneline --decorate -10
~~~

Fork 中的手册修改建议单独提交：

~~~bash
git switch -c docs/chinese-usage-guide
git add docs/OPENCHAMBER_USAGE_GUIDE_ZH.md README.md
git commit -m "docs: add Chinese OpenChamber usage guide"
git push -u origin docs/chinese-usage-guide
~~~

---

## 15. 推荐的实际落地方案

### 本机开发机

~~~text
Desktop 或 CLI/Web
  ├─ OpenChamber 默认托管 OpenCode
  ├─ Provider 在 Settings → Providers 配置
  ├─ 本机只监听 127.0.0.1
  └─ 需要手机时使用配对 + Private Relay
~~~

### NAS / Linux 内网服务器

~~~text
Docker Compose
  ├─ data/ 和 workspaces/ 持久化
  ├─ UI password 必须设置
  ├─ 只绑定内网/VPN
  ├─ Nginx/Caddy 负责 HTTPS、WebSocket、SSE
  └─ 通过移动端或浏览器配对访问
~~~

### 多模型评测

~~~text
Git 项目
  ├─ Multi-run
  ├─ isolate runs
  ├─ 每个模型独立 Worktree
  ├─ 比较 Diff 和测试结果
  └─ 只集成最可靠的分支
~~~

### 长任务自动推进

~~~text
自包含目标
  ├─ 明确交付物
  ├─ 明确验证命令
  ├─ 设置 token budget
  ├─ 服务器持续运行
  └─ 最终人工审阅 Diff、日志和测试结果
~~~

---

## 16. 官方详细文档索引

- [安装](https://docs.openchamber.dev/zh-cn/install/)
- [快速开始](https://docs.openchamber.dev/zh-cn/quickstart/)
- [OpenCode Server](https://docs.openchamber.dev/zh-cn/opencode-server/)
- [环境变量](https://docs.openchamber.dev/zh-cn/environment/)
- [Provider、模型与 Agent](https://docs.openchamber.dev/zh-cn/providers/)
- [项目](https://docs.openchamber.dev/zh-cn/projects/)
- [Worktree 会话](https://docs.openchamber.dev/zh-cn/worktrees/)
- [Multi-run](https://docs.openchamber.dev/zh-cn/multi-run/)
- [会话目标](https://docs.openchamber.dev/zh-cn/session-goals/)
- [计划任务](https://docs.openchamber.dev/zh-cn/scheduled-tasks/)
- [Git 与 GitHub](https://docs.openchamber.dev/zh-cn/git/)
- [MCP](https://docs.openchamber.dev/zh-cn/mcp/)
- [Skills](https://docs.openchamber.dev/zh-cn/skills/)
- [连接设备](https://docs.openchamber.dev/zh-cn/connect-devices/)
- [Private Relay](https://docs.openchamber.dev/zh-cn/private-relay/)
- [隧道](https://docs.openchamber.dev/zh-cn/tunnels/)
- [反向代理](https://docs.openchamber.dev/zh-cn/reverse-proxy/)
- [安全](https://docs.openchamber.dev/zh-cn/security/)
- [问题排查](https://docs.openchamber.dev/zh-cn/troubleshooting/)

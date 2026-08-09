# OpenChamber 桌面版：UOS 1070（Debian 10）内网离线安装手册

本文对应 Fork 的 `UOS 1070 Offline Desktop Media` GitHub Actions。目标平台是 **UOS 1070 / Debian 10 系列 / x86_64 / glibc 2.28**。当前不把 arm64、LoongArch 或其他国产 CPU 架构标记为已支持；它们需要单独的 Electron、OpenCode CLI 和原生模块构建链。

## 1. 结论与架构边界

当前桌面版的结构是：

```text
OpenChamber.AppImage
└─ Electron 主进程
   ├─ 内置 OpenChamber Web/Express 服务（同一进程）
   ├─ 内置 OpenCode CLI（Linux x86_64）
   ├─ 打包的 React UI
   └─ node-pty / sherpa-onnx 等原生模块
```

因此 UOS 1070 不需要额外安装 Node、Bun、OpenCode CLI 或 npm 依赖。Action 在 `debian:10` 环境中打包 Linux AppImage，并在同一套 Debian 10 运行时依赖中启动验证。AppImage 的优点是按用户目录安装、不需要 root；没有 FUSE 时，启动器会自动使用 `APPIMAGE_EXTRACT_AND_RUN=1`。

本适配有三个重要边界：

1. **已适配目标：** UOS 1070/Debian 10、x86_64。
2. **暂未承诺：** arm64、LoongArch、MIPS、国产 CPU 专用架构；不能把 x86_64 AppImage 复制过去当作兼容包。
3. **模型请求不是遥测：** OpenChamber 自己的更新、模型目录、GitHub、quota、Tunnel/Relay、Push/APNs 等公共服务请求会在离线构建中关闭；如果你在 OpenCode 中配置了一个公网模型供应商，OpenCode 子进程仍可能按该配置访问它。要做到物理意义上的“零公网出口”，还必须在 UOS 防火墙或网络交换侧阻断公网，Action 的 `--network none` 冒烟就是这一边界的验收方式。

## 2. 获取 Action 离线介质

在 Fork 仓库的 Actions 页面手工运行：

```text
UOS 1070 Offline Desktop Media
```

推荐使用 `main`，或填写一个已经审核过的 commit SHA。它会完成以下阶段：

1. 在 Debian 10 容器中安装构建依赖和固定版本 Bun/Node。
2. 构建 Web UI，设置 `VITE_OPENCHAMBER_OFFLINE_MODE=1`。
3. 下载并校验与 `@opencode-ai/sdk` 固定版本一致的 OpenCode CLI；这一步属于**构建期联网**。
4. 在 Electron ABI 下重编译原生模块，制作 x86_64 AppImage。
5. 检查 Electron、OpenCode CLI、`pty.node`、`sherpa-onnx.node` 的 ELF 架构和版本。
6. 生成带安装器、卸载器、manifest 和 SHA-256 的离线介质。
7. 使用 Debian 10 运行时依赖镜像，`--network none` 启动安装后的 AppImage，并要求出现 `Starting OpenChamber on port` 启动标记。

也可以使用 GitHub CLI：

```bash
gh workflow run uos1070-offline-media.yml \
  --repo Allenskoo856/openchamber \
  --ref main \
  -f ref=main \
  -f retention_days=14

gh run list --repo Allenskoo856/openchamber \
  --workflow uos1070-offline-media.yml --limit 5
```

Action 必须显示为 `completed / success` 后，才把它当成可交付介质。下载指定 Run 的 artifact：

```bash
gh run download RUN_ID \
  --repo Allenskoo856/openchamber \
  --name openchamber-uos1070-x86_64-offline-RUN_NUMBER \
  --dir ./openchamber-uos1070-offline
```

如果使用网页下载，请把 artifact 内的目录整体带入内网；不要只拿 AppImage 而跳过 checksum 和安装器。

## 3. 在可联网环境验收介质

离线介质目录中包含：

```text
openchamber-uos1070-x86_64-v<VERSION>/
├── OpenChamber-<VERSION>-linux-x86_64.AppImage
├── icon.png
├── SHA256SUMS
├── manifest.json
├── install.sh
├── uninstall.sh
├── offline.env.example
└── README.md
```

在交付给内网前先验收：

```bash
cd openchamber-uos1070-x86_64-v<VERSION>
sha256sum -c SHA256SUMS
test -x install.sh
test -x OpenChamber-*-linux-x86_64.AppImage
cat manifest.json
```

`manifest.json` 至少应包含：

```json
{
  "target": "uos1070-debian10",
  "architecture": "x86_64",
  "buildBaseline": "debian:10",
  "offlineMode": true,
  "externalNetworkPolicy": "blocked-by-default; loopback/private/explicit-allowlist only"
}
```

## 4. UOS 1070 安装

### 4.1 运行时预检

在 UOS 1070 上执行：

```bash
uname -m
getconf GNU_LIBC_VERSION
```

预期类似：

```text
x86_64
glibc 2.28
```

如系统没有 FUSE，也不需要手工安装；安装器生成的启动器默认设置：

```bash
APPIMAGE_EXTRACT_AND_RUN=1
```

如希望确认图形运行库，可检查：

```bash
ldconfig -p | grep -E 'libgtk-3|libnss3|libxss|libxtst|libgbm|libasound'
```

### 4.2 安装命令

把介质复制到 UOS 后：

```bash
cd /path/to/openchamber-uos1070-x86_64-v<VERSION>
sha256sum -c SHA256SUMS
./install.sh
```

这是用户级安装，不需要 `sudo`。默认路径：

```text
程序：~/.local/opt/openchamber/OpenChamber.AppImage
启动器：~/.local/bin/openchamber
配置：~/.config/openchamber/
桌面入口：~/.local/share/applications/openchamber-uos1070.desktop
```

启动：

```bash
~/.local/bin/openchamber
```

首次启动时先使用本机回环地址完成 OpenChamber/Workspace 初始化。不要在离线环境点击“更新”“GitHub 登录”“Tunnel”“Relay”或公网模型目录等功能；这些入口在离线构建中会返回 `OPENCHAMBER_OFFLINE_MODE`，不会向公共服务发请求。

### 4.3 卸载

```bash
cd /path/to/openchamber-uos1070-x86_64-v<VERSION>
./uninstall.sh
```

卸载器只删除本次用户级程序、启动器和桌面入口，保留 `~/.config/openchamber`，这样不会误删 Workspace、项目配置或内网白名单。若需要清理业务数据，应先在 UI/备份层面确认后再单独处理。

## 5. 配置内网模型

离线模式默认允许：

- `127.0.0.1`、`localhost`、IPv6 loopback；
- RFC1918 私网地址，例如 `10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`；
- 链路本地、ULA、`.local`、`.lan`、`.internal`、`.intranet` 内部域名；
- `OPENCHAMBER_OFFLINE_ALLOWED_HOSTS` 显式列出的已审核主机名。

例如内网有 OpenAI-compatible 网关 `10.20.30.40:8000`：

```bash
mkdir -p ~/.config/openchamber
cp offline.env.example ~/.config/openchamber/offline.env
```

编辑 `~/.config/openchamber/offline.env`：

```bash
OPENCHAMBER_OFFLINE_MODE=1
OPENCHAMBER_DISABLE_EXTERNAL_NETWORK=1
OPENCHAMBER_OFFLINE_ALLOWED_HOSTS=10.20.30.40
```

然后重新启动桌面版，在 Providers/模型配置中填写内网 Base URL，例如：

```text
http://10.20.30.40:8000/v1
```

API Key 只写入 UOS 本机的 OpenCode 配置或环境变量，不要提交到 Git，也不要发到聊天中。若内网使用 HTTPS 自签证书，应先把机构 CA 正确安装到 UOS 信任库；不要为了绕过证书校验而关闭 TLS 验证。

### 内网域名注意事项

如果实际域名不是上述内部后缀，例如 `llm.ai.example.cn`，不要把整个公网域名空间放行，只写精确主机名：

```bash
OPENCHAMBER_OFFLINE_ALLOWED_HOSTS=llm.ai.example.cn
```

白名单只影响 OpenChamber 进程内的离线策略；为了阻断 OpenCode 子进程被配置成公网供应商，仍应在网络层只允许内网网段和该主机。

## 6. 已关闭的主动外联

离线构建会同时启用 `OPENCHAMBER_OFFLINE_MODE=1` 和 `OPENCHAMBER_DISABLE_EXTERNAL_NETWORK=1`，并在 UI 构建期启用 `VITE_OPENCHAMBER_OFFLINE_MODE=1`。当前关闭范围包括：

- Electron `autoUpdater`、桌面更新检查、changelog 拉取和 UI 每小时更新轮询；
- 默认 usage/reporting 改为关闭，`reportUsage` 只有显式为 `true` 才会发送；
- `models.dev` 模型元数据和 Zen 模型目录；
- GitHub 登录/状态、Issue/PR 相关 API；
- quota/usage 供应商查询；
- Cloudflare/ngrok Tunnel、OpenChamber Relay；
- Web Push、APNs 注册和发送；
- 远程技能 catalog/source/scan/install；
- Electron 渲染器对公共 HTTP(S)/WS(S) 的请求和外部打开；
- 服务端进程内 `fetch` 对公共 HTTP(S)/WS(S) 的请求。

应用自有请求只允许回环、私网/链路本地和显式内部白名单。构建期间下载依赖、Electron、OpenCode CLI 和生成 AppImage 的网络请求不属于目标介质运行期；Action 的最后一步使用 `--network none` 验证运行期。

## 7. 离线环境的日常使用

推荐操作顺序：

1. 启动 `~/.local/bin/openchamber`。
2. 在本机完成登录、Workspace、项目目录和内网 Provider 配置。
3. 用内网 Git/SSH 地址操作代码；GitHub 集成功能在离线模式不可用。
4. 用内网 OpenCode/模型网关执行对话和代码任务。
5. 新版本发布时，在有网的受控环境重新运行 Action，验收 checksum 后通过 U 盘或内网文件交换导入；不要在 UOS 上运行 npm/bun/curl 更新。

离线介质不依赖在线 updater，因此升级是“新介质验收后覆盖安装”。安装器会保留 `~/.config/openchamber`，但仍应先备份重要 Workspace 数据和项目文件。

## 8. 常见故障

### AppImage 报 FUSE/libfuse.so.2

直接通过启动器运行即可；它已经设置 `APPIMAGE_EXTRACT_AND_RUN=1`。如果你手工启动 AppImage：

```bash
APPIMAGE_EXTRACT_AND_RUN=1 ./OpenChamber-<VERSION>-linux-x86_64.AppImage
```

### 启动后窗口空白或立即退出

先从终端启动并保留输出：

```bash
ELECTRON_ENABLE_LOGGING=1 ~/.local/bin/openchamber 2>&1 | tee /tmp/openchamber.log
```

检查：

```bash
uname -m
getconf GNU_LIBC_VERSION
ldconfig -p | grep -E 'libgtk-3|libnss3|libgbm|libasound'
```

若通过 SSH 无图形会话，不要以此判断桌面介质失败；应在 UOS 图形桌面会话中测试。Action 的 Debian 10 + Xvfb 冒烟日志应包含 `Starting OpenChamber on port`。

### `OPENCHAMBER_OFFLINE_MODE` 错误

这是预期的拒绝，不是安装失败。它表示当前功能需要公共服务，例如更新、GitHub、Tunnel/Relay、quota 或公共模型目录。将模型地址改为内网地址；不要为了绕过错误把公共域名加入白名单。

### 内网模型无法连接

先从 UOS 验证路由和端口，再检查白名单：

```bash
ip route
getent hosts llm-gateway.internal
```

如果使用 IP，直接把 IP 放入 `OPENCHAMBER_OFFLINE_ALLOWED_HOSTS`；如果使用自定义域名，把完整主机名加入，不要加入整个顶级域名。

## 9. 重新验证与交付门槛

以下三件事必须同时满足，才可向内网用户宣称“已验证”：

1. Action Run 为 `completed / success`；
2. 下载 artifact 后 `sha256sum -c SHA256SUMS` 通过，且 `manifest.json` 的目标为 `uos1070-debian10/x86_64`；
3. Action 的 Debian 10 `--network none` 启动冒烟通过，并保存日志。

仅有本机 macOS 构建成功、仅有 GitHub Action 排队、或仅有 AppImage 文件，都不等同于 UOS 1070 兼容性已验收。

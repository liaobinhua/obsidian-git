# obsidian-git

## 0. 项目说明

### 0.1 Objective/Coverage

Wudao Git 为 macOS 和 Android 提供手动、审阅后执行的 GitHub 文库同步。Mac 通过本机 Git 操作，Android 通过 GitHub API 操作同一分支。本文提供安装入口、使用条件、文件策略和验证命令。

这是独立实现，与 `Vinzent03/obsidian-git` 没有隶属关系。插件 ID 为 `wudao-git`。0.2.0 的 Android 包为候选版本：自动化测试和无 Node 加载检查不能替代 Android 真机验证。

### 0.2 References

1. [Android 安装与使用](docs/README-android.md)：手机令牌、首次导入、日常上传、冲突与恢复、真机验收。
2. [同步实现说明](docs/README-sync-design.md)：平台边界、GitHub 提交、同步基线、恢复日志和安全范围。
3. [安全报告](SECURITY.md)：漏洞报告方式与维护范围。

## 1. 平台与安装包

| 平台 | 安装包 | 使用条件 |
|---|---|---|
| macOS | `wudao-git-0.2.0-macos.zip` | Obsidian 1.13.0+，`/usr/bin/git`，macOS 钥匙串 |
| Android | `wudao-git-0.2.0-android.zip` | Obsidian 1.13.0+，提供 Web Crypto 的 Android System WebView |

在手机上使用 Android 包，在电脑上使用 Mac 包。将安装包内的 `main.js`、`manifest.json` 和 `styles.css` 复制到文库的 `.obsidian/plugins/wudao-git/`，然后启用 Wudao Git。ZIP 同时包含 MIT 许可文件。请先停用其他操作同一文库的 Git 同步插件。

## 2. Mac 使用条件与流程

文库根目录须为 Git 根目录，使用普通 `.git` 目录和完整历史记录。需要已有首次提交，并已推送到 GitHub 同名分支；`origin` 使用 `https://github.com/<owner>/<repository>.git`。在仓库内设置自己的提交作者：

```sh
git config user.name "Your Name"
git config user.email "YOUR_NOREPLY_EMAIL"
```

认证沿用 macOS 钥匙串，插件不读取 `GITHUB_TOKEN`。全局 Git 配置不参与插件操作，因此提交作者需要在仓库内设置。

写作后运行“Wudao Git: 检查并提交选中文件”，检查并勾选文件、填写说明，创建本地提交，再核对待推送清单并推送。获取手机更新时，先处理本地改动，再运行“拉取更新（仅快进）”。遇到分叉时交给外部 Git 处理，不强制覆盖。

## 3. Android 使用流程

1. 手机新建空白文库，安装 Android 包。
2. 创建手机专用细粒度令牌，仅授权文章仓库的 `Contents: Read and write`，并设置到期时间。
3. 在插件设置中填写仓库、分支，在 SecretStorage 中添加手机令牌。插件的 `data.json` 只保存引用名称。
4. 保持默认的仅下载模式，运行“首次下载或检查远端更新”，审阅后应用。
5. 检查文章、模板和附件后启用“允许上传”。以后写作前检查远端，写完检查并上传选中文件。

手机的本地保存和离线审阅不是 Git 提交；点击最终上传确认后，插件才通过 GitHub API 创建提交并更新分支。换设备前应完成上传，在另一设备开始写作前先获取更新。

## 4. 文件规则与限制

- 允许 `.md`、`.txt`、`.csv`、`.pdf`、`.png`、`.jpg`、`.jpeg`、`.gif` 和 `.webp`。单文件最多 20 MiB，单次操作及其备份合计最多 50 MiB。
- 共享策略拒绝隐藏路径、常见凭据路径、路径穿越和不安全文件名。Android 还检查大小写、Unicode 及文件/目录冲突。主机 API 可识别的链接会被拒绝，手机 API 不提供操作系统级路径隔离。
- 常见令牌和私钥标记会阻止同步，无法识别全部敏感内容。上传前仍需人工检查。
- Android 采用共享白名单和排除策略，不实现完整原生 `.gitignore` 语义。Mac 还遵守本机 Git 忽略规则。未托管文件不会被手机上传覆盖。

## 5. 安全范围

Mac 固定调用 `/usr/bin/git`，参数分开传递，不启动 Shell；子进程不继承令牌、Git 路径覆盖和外部 askpass。Git hooks、fsmonitor 被禁用，仓库 URL 重写、HTTP 覆盖和文件过滤器配置会被拒绝。

Android 仅请求固定的 `https://api.github.com` Git 数据接口，拒绝 HTTP 重定向、跨域凭据转发和任意 `download_url`。默认仅下载模式在传输层拒绝远端写请求。令牌使用 Obsidian SecretStorage；它是文库关联的本机存储，不是针对其他插件的独立沙箱，也不能等同于 Android 硬件密钥库。

运行时没有第三方 JavaScript 依赖，没有遥测、自更新或任意命令入口。构建依赖锁定在锁文件中。Obsidian、本机 Git、WebView 和用户设备仍属于信任范围。私有 GitHub 仓库保存可读的文章和历史，不提供本插件实现的端到端加密。

## 6. 构建与验证

需要 Bun、Node.js 24+ 和 `zip`：

```sh
bun install --frozen-lockfile
bun run check
```

`dist/macos/` 和 `dist/android/` 包含各自三件插件文件及 LICENSE；`dist/` 下同时生成两个 ZIP 和校验文件。兼容旧安装脚本的 `dist/main.js` 等路径保留为 Mac 构建。

```sh
bun run typecheck
bun run test
bun run test:coverage
bun run build
bun run test:bundle
```

Git 核心测试使用真实临时仓库；手机 HTTP 测试使用本地服务器和真实 Git 对象。状态存储测试验证交替校验副本及中断恢复。覆盖率门槛为核心代码 80%，不包含 Obsidian 界面代码；安装包测试额外验证无 Node 环境中的 Android 启动。真机验收见 Android 指南。

## 7. 许可

使用 MIT 许可，见 [LICENSE](LICENSE)。

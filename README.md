# obsidian-git

## 0. 项目说明

### 0.1 Objective/Coverage

Wudao Git 为 macOS 和 Android 提供手动、审阅后执行的 GitHub 文库同步。升级后延续现有文库、仓库配置、暂存内容与未上传编辑；已有文章可以原位连接。Mac 通过本机 Git 操作，Android 通过 GitHub API 操作同一分支。本文提供安装入口、使用条件、文件策略和验证命令。

这是独立实现，与 `Vinzent03/obsidian-git` 没有隶属关系。插件 ID 为 `wudao-git`。0.3.0 的 Android 包为候选版本：自动化测试和无 Node 加载检查不能替代 Android 真机验证。

### 0.2 References

1. [Android 安装与使用](docs/README-android.md)：手机令牌、首次导入、日常上传、冲突与恢复、真机验收。
2. [同步实现说明](docs/README-sync-design.md)：平台边界、GitHub 提交、同步基线、恢复日志和安全范围。
3. [安全报告](SECURITY.md)：漏洞报告方式与维护范围。

## 1. 平台与安装包

| 平台 | 安装包 | 使用条件 |
|---|---|---|
| macOS | `wudao-git-0.3.0-macos.zip` | Obsidian 1.13.0+，`/usr/bin/git`，macOS 钥匙串 |
| Android | `wudao-git-0.3.0-android.zip` | Obsidian 1.13.0+，提供 Web Crypto 的 Android System WebView |

在手机上使用 Android 包，在电脑上使用 Mac 包。将安装包内的 `main.js`、`manifest.json` 和 `styles.css` 复制到文库的 `.obsidian/plugins/wudao-git/`，然后启用 Wudao Git。ZIP 同时包含 MIT 许可文件。请先停用其他操作同一文库的 Git 同步插件。

## 2. Mac 使用条件与流程

已有 Git 仓库时沿用文库根目录中的普通 `.git`、完整提交历史与暂存区；`origin` 使用 `https://github.com/<owner>/<repository>.git`。已有文章但没有 `.git` 时，保存文章仓库设置后使用“连接现有文库”，预览并确认后建立本地 Git 元数据，保留原有文章。文章仓库需已存在分支。在仓库内可设置自己的提交作者：

```sh
git config user.name "Your Name"
git config user.email "YOUR_NOREPLY_EMAIL"
```

认证沿用 macOS 钥匙串，插件不读取 `GITHUB_TOKEN`。全局 Git 配置不参与插件操作；原位接入新 Git 目录时会设置本机占位作者，可用上面命令改为自己的身份。

打开“版本控制”，检查差异并暂存选中文件，填写说明后点击“提交并同步”。插件先创建本地提交，需要整合远端时展示预览和冲突选择，应用后再核对待推送清单并确认上传。“仅提交到本地”保留离线提交能力。获取手机更新时点击“检查远端”，不同文件的变化可以整合，同名冲突显式选择；分叉采用两个父提交保留双方历史。原有“拉取更新（仅快进）”命令保留作兼容入口。

## 3. Android 使用流程

1. 在手机打开已有文库或新建文库，安装 Android 包。
2. 使用手机专用细粒度令牌，仅授权文章仓库的 `Contents: Read and write`；有效期自行选择，已有不过期令牌可继续使用。
3. 在插件设置中填写仓库、分支，在 SecretStorage 中添加或选择手机令牌。长期设置保存于 `<Obsidian 配置目录>/wudao-git/`，只记录引用名称，不保存令牌值。
4. 保持默认的仅下载模式，打开“版本控制”并检查远端；已有文章且缺少记录时使用“连接现有文库”，逐项比较后确认。
5. 检查文章、模板和附件后启用“允许上传”。写作前检查远端，写完暂存选中文件并点击“提交并同步”。

手机的本地保存、离线审阅和暂存快照不是 Git 提交；点击最终上传确认后，插件才通过 GitHub API 创建提交并更新分支。换设备前应完成上传，在另一设备开始写作前先获取更新。文章更新使用插件的审阅上传流程；插件版本更新则从 Releases 下载相应平台的安装包，保留原有数据与同步记录后覆盖三个程序文件。

## 4. 文件规则与限制

- 允许 `.md`、`.txt`、`.csv`、`.pdf`、`.png`、`.jpg`、`.jpeg`、`.gif` 和 `.webp`。单文件最多 20 MiB，单次操作及其备份合计最多 50 MiB。
- 共享策略拒绝隐藏路径、常见凭据路径、路径穿越和不安全文件名。Android 还检查大小写、Unicode 及文件/目录冲突。主机 API 可识别的链接会被拒绝，手机 API 不提供操作系统级路径隔离。
- 常见令牌和私钥标记会阻止同步，无法识别全部敏感内容。上传前仍需人工检查。
- Android 会按远端安全目录结构补齐分类，包括仅有 .gitkeep 占位文件的目录；排除文件仍展示具体理由。旧文库升级后重新检查即可补齐目录。
- Android 采用共享白名单和排除策略，不实现完整原生 `.gitignore` 语义。Mac 还遵守本机 Git 忽略规则。未托管文件不会被手机上传覆盖。

## 5. 安全范围

Mac 固定调用 `/usr/bin/git`，参数分开传递，不启动 Shell；子进程不继承令牌、Git 路径覆盖和外部 askpass。Git hooks、fsmonitor 被禁用，仓库 URL 重写、HTTP 覆盖和文件过滤器配置会被拒绝。

Android 仅请求固定的 `https://api.github.com` Git 数据接口，拒绝 HTTP 重定向、跨域凭据转发和任意 `download_url`。默认仅下载模式在传输层拒绝远端写请求。令牌使用 Obsidian SecretStorage；它是文库关联的本机存储，不是针对其他插件的独立沙箱，也不能等同于 Android 硬件密钥库。

推送成功后，Mac 会刷新已验证远端对应的本地追踪引用，避免 URL 推送造成“领先提交”误报；若本地引用已被其他操作推进，不会回退它。

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

## 7. 版本控制与升级

点击 Git 图标或运行“Wudao Git：打开版本控制”，查看工作区变化、暂存内容、当前文章状态和真实提交历史。“查看差异”比较前后内容；选择文件后暂存，再填写说明并提交。Mac 可仅提交到本地，也可提交后检查远端、处理合并，再确认推送。Android 的已暂存内容是持久化待上传快照，联网确认后生成 GitHub 提交；暂存后继续编辑会作为下一次工作区变化。

正常升级仅替换插件程序，旧配置和同步记录会自动校验迁移到 <Obsidian 配置目录>/wudao-git/，旧副本保留。不要删除该长期状态目录。记录缺失时可在原文库重新建立同步关系；记录损坏时使用“修复同步记录并重新比较”，先预览，再备份原始记录并建立新状态。缺少基线不会推断本地或远端删除。

Mac 允许审阅现有暂存区，部分提交保留未选中的暂存条目和后续工作区编辑。正常分叉可预览并以两个父提交合并，同名冲突需选择；独立暂存版本和工作区版本分别保留副本。根 .gitignore 与安全目录中的 .gitkeep 作为原生 Git 元数据保持；其他排除文件的远端变化会明确停止，防止隐式回退它们。

版本控制面板自动刷新本地状态，不自动访问 GitHub。远端检查时间只代表上次检查，不能将离线无变化显示为全部同步。0.3.0 不启用自动同步。

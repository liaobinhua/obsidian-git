# obsidian-git

## 0. 项目说明

### 0.1 Objective/Coverage

Wudao Git 是一个小型 Obsidian 桌面插件，让你检查文件、选择本次提交的内容，并在核对待推送提交后手动上传到 GitHub。本文说明安装、使用、安全限制和开发验证。

这是独立实现，与 `Vinzent03/obsidian-git` 没有隶属关系。插件 ID 为 `wudao-git`，便于区分和切换。

## 1. 使用条件

- macOS，Obsidian 1.13.0 或更高版本，以及 `/usr/bin/git`。
- 文库根目录就是 Git 根目录，使用普通 `.git` 目录和完整历史记录。
- 已有首次提交，并已推送到 GitHub 同名分支；`origin` 使用 `https://github.com/<owner>/<repository>.git`。
- 本地仓库已设置提交作者；HTTPS 认证由 macOS 钥匙串提供。

在文库目录设置提交作者，使用你自己的姓名和 GitHub noreply 邮箱：

```sh
git config user.name "Your Name"
git config user.email "YOUR_NOREPLY_EMAIL"
```

使用 GitHub 专用细粒度令牌，仅授权目标仓库的 `Contents: Read and write`，设置到期时间。插件不提供令牌输入框，不读取 `GITHUB_TOKEN`，不把凭据写入插件配置。Git 仅使用 macOS 钥匙串凭据助手；全局 Git 配置不参与插件操作，因此提交作者需要在仓库内设置。

## 2. 构建与安装

开发需要 Bun 和 Node.js 24 或更高版本：

```sh
bun install --frozen-lockfile
bun run check
```

构建产物是 `dist/main.js`、`dist/manifest.json` 和 `dist/styles.css`。将这三个文件复制到文库的 `.obsidian/plugins/wudao-git/`，然后在 Obsidian 的第三方插件设置中启用 Wudao Git。

在插件设置中填写 `owner/repository`，点击“验证并保存”。绑定前会检查文库根目录和 `origin`。请在启用本插件前停用其他 Git 同步插件。

## 3. 日常写作与同步

1. 写作完成后，在命令面板运行“Wudao Git: 检查并提交选中文件”。
2. 点击“查看”检查内容，勾选本次要提交的文件，填写提交说明。所有文件默认不选中。
3. 点击“提交选中文件”。插件只创建本地提交，然后展示待推送的提交和文件。
4. 核对目标仓库、分支和提交列表后，点击“推送这些提交”。也可以关闭窗口，稍后运行“检查并推送本地提交”。
5. 需要获取其他设备的改动时，先处理本地改动，再运行“拉取更新（仅快进）”。

文本预览分别显示修改前后的内容，每部分最多 50,000 个字符。附件需先在 Obsidian 中打开检查。推送失败时，本地提交会保留，可以在排除凭据或网络问题后重试。

## 4. 上传与同步规则

- 允许 `.md`、`.txt`、`.csv`、`.pdf`、`.png`、`.jpg`、`.jpeg`、`.gif` 和 `.webp`，单文件最多 20 MiB，单次提交最多 50 MiB。
- 拒绝隐藏路径、环境文件、常见密钥或凭据文件名、符号链接和子模块；Git 忽略规则同样生效。
- 文档、提交说明和待同步历史中的常见令牌、私钥标记会触发阻止。此检查只能识别部分格式，人工检查仍然必要。
- 提交前核对选中文件的内容摘要、分支和 HEAD；发生变化时要求重新检查。仓库有进行中的合并、变基等操作时停止处理。
- 使用临时索引构建所选文件的提交，保护未选择的工作区改动。已有暂存内容时停止，交给外部 Git 处理。
- 推送会检查每个待推送提交，而不仅是最终文件列表；先添加后删除的敏感文件也会触发检查。
- 每次推送前重新检查远端和本地提交；远端变化时停止。推送使用明确的已审阅提交，不强制覆盖远端。
- 拉取要求工作区干净，且只能快进；同时检查将引入的文件。历史分叉、合并提交或超过 100 个待同步提交时，交给外部 Git 处理。

## 5. 安全范围

插件直接调用固定的 `/usr/bin/git`，通过参数数组传递参数，不启动 Shell。子进程使用受控环境，不继承令牌、Git 路径覆盖或 Shell 配置；Git hooks 和 fsmonitor 被禁用，仓库中的 URL 重写、HTTP 覆盖和文件过滤器配置会被拒绝。网络操作只使用绑定仓库的 GitHub HTTPS 地址，开启证书校验并拒绝重定向。凭据助手属于明确的外部程序执行。

运行时没有第三方 JavaScript 依赖，没有定时同步、遥测、自更新、任意命令入口、仓库删除或强制推送功能。构建依赖锁定在锁文件中，Obsidian 本身由宿主提供。

这些限制是插件代码的行为约束，不是操作系统沙箱。Obsidian 和本插件运行在当前用户权限下；同用户的恶意程序、其他恶意插件、被篡改的 Git 或钥匙串不在此实现能够隔离的范围内。私有仓库仍会保存文档及历史版本，普通删除无法清除旧提交。高度机密资料需要独立评估其存储和同步方式。

## 6. 开发与验证

```sh
bun run typecheck
bun run test
bun run test:coverage
bun run build
```

`src/git.ts` 实现 Git 操作和文件策略；`src/main.ts` 实现 Obsidian 设置、命令和审阅窗口。测试使用真实的临时 Git 仓库；同步测试通过一个测试专用传输适配器连接本地 bare 仓库，无需 GitHub 凭据。覆盖率命令对 Git 核心设置 80% 行覆盖率门槛，Obsidian 窗口代码需在桌面应用中验证。

## 7. 许可与安全报告

使用 MIT 许可，见 [LICENSE](LICENSE)。发现安全问题时按 [SECURITY.md](SECURITY.md) 中的方式报告。

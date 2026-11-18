# 同步实现说明

## 0.1 Objective/Coverage

本文维护 Wudao Git 0.3 的平台划分、Android 同步状态、发布流程与故障恢复约定。

## 1. 平台划分

`src/main.ts` 是 Mac 入口，沿用本机 Git；`src/mobile-main.ts` 是 Android 入口，通过 Obsidian 文件接口和浏览器 HTTPS 请求访问 GitHub。两者同一插件 ID、分开构建；Android 依赖图不能包含 Node 模块。

`src/mobile/policy.ts` 提供共享策略；`github.ts` 验证 GitHub 响应和对象；`engine.ts` 实现比较、审阅和恢复；`src/mobile-host.ts` 连接主机文件、状态存储和 HTTP；`src/mobile-ui.ts` 提供确认界面。

## 2. 本地状态

每份状态绑定仓库和分支，保存头提交及每文件的 blob SHA、大小。整库正文不进入基线。离线审阅保存受大小限制的变更快照，上传失败后可继续核对同一快照。

状态交替写入 `mobile-state-a.json` 与 `mobile-state-b.json`，各有递增序号、负载和 SHA-256 校验。先写临时文件并读回校验，再替换目标副本；另一个有效副本用于恢复。这是主机 API 上的可恢复写入，不承诺 Android 的 fsync 或多文件原子事务。

两份副本均损坏时停止，不将状态当作空库。权限错误不能解释为删除。

## 3. 下载与恢复

比较基线、本地和远端：只改远端时可下载，只改本地时保留待上传，两端相同则更新基线，两端不同修改则要求显式冲突选择。

应用前核对文件、目录清单和远端头提交。大小写、Unicode、文件目录冲突以及不完整远端列表均停止计划。内容及备份通过预算后，先记录日志和原文，再逐项应用并校验，最后推进基线。

恢复无法区分撕裂写入与后续编辑，因此保留当前文件，并以 `.recovery-copy` 保留原文。手机 API 不提供 lstat 或 realpath；路径检查不等同于对同权限恶意程序的操作系统沙箱。

## 4. 上传与超时

最终确认前不发送写请求。上传使用持久保存且摘要匹配的选中快照，在当前远端 `base_tree` 上修改这些文件，以一个父提交创建 Git 提交。发布前保存提交 SHA，最后用 `force:false` 更新分支。

远端变化或拒绝快进时停止。恢复只检查远端是否已指向该提交，再次发布仍需原选择和用户确认。超时但远端已更新时推进基线；仍是原父提交时可重试同一提交；出现其他提交时重新下载审阅。服务端快进校验不是带 expected-old 参数的精确 CAS。

## 5. 网络与凭据

只构建 `https://api.github.com` URL，不使用任意下载地址。HTTP 使用 `redirect:error`、省略 Cookie、60 秒单请求超时及响应大小限制。GitHub REST 支持跨域，无需使用不受控的重定向回退。插件停用时中止后续请求。

SecretStorage 保存令牌，插件配置只保存引用名。该存储关联本机文库，不保证其他插件无法读取，也不等同于硬件密钥库。默认仅下载，启用上传后传输层才接受写请求。

## 6. Sources

- [GitHub Git trees](https://docs.github.com/en/rest/git/trees)
- [GitHub Git commits](https://docs.github.com/en/rest/git/commits)
- [GitHub Git references](https://docs.github.com/en/rest/git/refs)
- [GitHub CORS](https://docs.github.com/en/rest/using-the-rest-api/using-cors-and-jsonp-to-make-cross-origin-requests)

## 7. 0.2.1 完整目录与结果反馈

远端树同时保留完整叶节点和目录元数据，区分参与同步的文档与主动排除的文件。PullPlan 提供文件和目录总数、待创建目录及排除理由；.gitkeep 不作为正文下载，但其父目录会被保留。

写前 journal 的可选 directories 字段保存全部安全远端目录，而不只是预览时缺失的目录，防止目录在预览后或恢复期间消失却错误报告完成。旧 schema 1 状态无需重建。应用完成会返回保留的后续本地编辑路径，界面不会把它们计作已覆盖的远端更新。

Mac 在读到已验证的远端头或推送成功后，以本地引用旧值作为更新条件刷新追踪引用，不影响远端分支；并发发现更晚引用时保留它并反馈刷新状态。

## 8. 0.3 已有文库与状态延续

长期配置和移动端同步记录位于 <configDir>/wudao-git/，通过校验后的轮换文件保存。VaultPersistence 自动迁移程序目录中的 schema 1 状态，原有 draft、staged、pending、journal 完整保留；旧副本保留，新格式无法识别时停止。插件版本与状态格式版本独立。

planAttach 在缺少基线时比较本地与远端，生成不可变预览。applyAttach 再验证文件、完整命名空间、远端提交与修复摘要；只有确认后才建立基线和应用下载。仅本地文件保留，同名不同内容必须选冲突策略，未知历史不推断删除。修复坏记录先逐字节备份，再发布新代状态位置，避免中断后将坏记录误当成空库。

inspectVault 不联网、不改草稿；changes 保持相对同步基线，workingChanges 比较暂存快照与当前编辑。reviewWorking 绑定当时的暂存版本，stage 保存固定正文；upload 使用已审阅快照，保留后续工作区编辑。远端更新后原暂存仍保留，过期快照必须重新审阅。

Mac 保留实际 .git 和索引，部分提交只推进选中路径，其他暂存条目保留。同步计划比较共同祖先、本地提交、工作区和远端；安全 .gitkeep 与根 .gitignore 作为原生元数据保持，其他排除文件发生远端变化会明确停止。普通分叉通过两个父提交合并，同名冲突需显式选择。保留两份时工作区正文生成 .local-copy，独立暂存正文另存 .staged-copy。

Mac 写前日志位于 .git/wudao-sync-journal.json，包含校验、原索引、目标索引、预期分支提交与批准的文件正文；恢复校验索引及提交，不覆盖外部 Git 的晚到修改。部分写入与后续编辑无法可靠区分，因此保留当前内容并保存原文 .recovery-copy。

两端使用共享版本控制视图，提供本地状态、当前文章状态、暂存、差异、真实历史和手动同步。面板本地刷新不触发远端请求；远端检查时间仅描述上次检查，提交并同步仍遵循预览、冲突处理和远端确认。手机不维护完整本地 .git，离线快照不标成 Git 提交。0.3.0 无自动同步任务。

# 同步实现说明

## 0.1 Objective/Coverage

本文维护 Wudao Git 0.2 的平台划分、Android 同步状态、发布流程与故障恢复约定。

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

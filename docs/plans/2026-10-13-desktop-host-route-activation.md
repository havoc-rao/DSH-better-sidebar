# Desktop Host 路由未挂载：webRuntime 服务依赖

## 定位

桌面端 `/sidebar/api/settings.get`、`session.phase`、`session.cwd` 返回 405，
`/sidebar/ws/agent-opens` 与 `agent-terminals` 连接失败。最初桌面实例的调试端口
在排查期间关闭，未能取出其完整 stderr；随后用当前 Harness 和既有 desktop
profile 启动独立 Host，复现同样的路由缺席。

Host 启动审计明确输出：

```text
better-sidebar (dsh-better-sidebar): pending (waiting for service: webRuntime)
```

此时插件 fiber 为 pending，HTTP 和 upgrade 路由表均没有 `/sidebar/*`。
当前 Harness 已改用 `webStartup` 提供启动参数，旧的 `webRuntime` 不再提供。
插件仍将其列入强制 inject，导致 `apply()` 根本没有执行。405 来自未匹配插件
路由后的宿主处理，不能据此判断插件自己的 POST 方法检查失败。

## 修复

强制服务只保留 `webServer`、`sessions`、`tools`。HTTP 与 WebSocket 共用的
信任栅栏每次请求通过 `ctx.get()` 读取 `webStartup.trustedHosts`；当前宿主还
接受具体监听地址，因此同时纳入非通配 bind 地址。旧 rc.2 继续读取
`webRuntime.trustedHosts`。两个 provider 均缺席时只允许原有 loopback 请求，
不放宽到任意 Host。未改动 Harness 源码或 profile。

## 验证

- 独立真实 Harness Host：插件激活，三个 API 均为 HTTP 200、`ok:true`。
- 携带 `Origin: dsh-app://app` 的两个真实 WebSocket 均连接成功；
  `agent-terminals` 收到 `[]`。
- 真实 Cordis + 本机 HTTP/WS 回归：挂载、请求、卸载清空路由、重新挂载后
  再次请求全部成功。此测试验证 fiber 生命周期，不等同于桌面内 HMR 的完整链路。
- 真实 Harness Host 强制 `fiber.update(config, true)` 后重新检查：插件仍激活，
  三条 HTTP API 与两个 WebSocket 再次全部通过。
- 旧信任列表、远程域名/LAN、请求时更新和恶意 Host 拒绝回归保留。
- 全量测试：232 文件通过，2654 测试通过，17 跳过；build/typecheck 通过。
  改动文件的定向 ESLint 通过。全仓 `pnpm lint` 被已有 `tmp/worktree/` 下的
  多个 eslint 配置导致的 `tsconfigRootDir` 歧义阻断，未扩大修复范围。

桌面原实例未在此次验证时运行，因此没有声称验证了该实例的页面恢复。

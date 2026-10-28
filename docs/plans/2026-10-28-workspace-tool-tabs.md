# Workspace 文件树 / Git 工具页共享

## 范围

- `files` / `git` 原生工具页的存在性按宿主 `workspaces.list` 的成员关系归属 workspace；不是按 session cwd 相等推断。
- 优先 workspaceId（稳定身份），结构面无 id 时路径回退；storage 命名空间含 host transport 与代理路径，不含 query/token。
- 只共享类型存在性，不拷贝 session 地址、tab id、导航参数或整个布局。后台 session 上屏再协调，不批量创建后台 body。
- 原生拖拽顺序、激活态、分栏与窗口尺寸不共享；新建按 files/git 顺序，已有 tab 不重建。
- 文件树展开集仍由原有 SidebarStore session 状态唯一持有。本轮不改成 workspace 展开集，避免与现行 attachStore/syncExpanded 契约竞争；后续单独处理 workspace + 实际根目录的分区迁移。
- 底部工作台、编辑器、diff、任务与终端不在范围内。

## 宿主约束

基线已安装的 sidebar-right 0.2.1-rc.1 的 concrete controller 公开 `openTabs`（保存/已采用 session 的完整元数据清单）、`tabsIn`、`mounted`。不能用 body 挂载发现 tab，因为隐藏和未访问的 body 不代表未打开。

没有公开后台打开或移动顺序 API。恢复只调用公开 openTab/focus/toggleExpanded，补开后恢复原有非 guide 活动内容页、折叠态及仍连接的 DOM 焦点。非原子，不能保证全部分栏激活态/全屏不变；绝不写私有 adopted store 或改宿主。

mounted 先于 React store adoption。清单可能与旧保存完全相同而没有 publish；有限次 requestAnimationFrame 补偿 readiness，正常稳态不运行定时器/轮询。

## 存储与协调

- 每 workspace、每 kind 一个 schema v1 布尔记录：不同种类并发打开互不覆盖；同种类由浏览器最终写入决定。
- 任一有效记录都代表该 workspace 已初始化。显式 false 是 tombstone，不被旧会话初始化覆盖。首次无记录时从该 workspace 已知的原生清单并集播种（包括空集）。
- 同页 store 通知；跨页 storage 事件。磁盘读取不缓存；拒绝存储时降级到有界内存。
- 同一上屏 seat 的 inventory 差分代表 membership 修改；切换 session/workspace 不作为打开意图。投影写入期间抑制反馈，结束后采纳新 baseline。
- 只协调当前 session，workspace 未就绪或身份未知不建立公共桶。禁用的类型不恢复，也不把禁用当关闭。
- Git 的现有草稿在卸载 flush 并按 session/checkout 保存；操作/生成/确认期间以 live lease 阻止远端关闭，结束后事件驱动重试。

## 实施修正

- 偏好更新必须同时订阅 `subscribeState`，注册表 `subscribe` 不传播 tab 启用开关。
- 用户关闭的 inventory 差分同步归因，再微任务协调，避免同一任务立即切会话吞掉关闭。
- readiness 不满足时不播种、不记 baseline，晚 adoption 不能把旧保存的页复活成新打开意图。
- inventory 的 publish 发生在宿主 TabDomain occurrence 更新之前，订阅回调不调用 commandTarget；只在延迟协调中探测。真实挂载曾捕获该错误，已补针对性测试。
- 单测扫描额外排除本地 `.pnpm-store` 项目快照；原先快照里的旧 worktree 测试会被重复收集，与本 checkout 无关。

## 2026-10-29 新会话可见性修正

当前真实桌面通过全局新建会话按钮复现：同 workspace 新会话内已存在 files/git，然而 isExpanded() 为 false，面板 aria-hidden=true。手动展开立即显示两个 tab。旧协调器无条件还原新会话默认折叠态；旧 e2e 在创建后调用 expandSidebar，掩盖了用户看到的失败。

修正为首次进入没有非 guide 内容的 seat 时，保留继承 openTab 的展开效果；非空 seat 及同一 seat 后续远端补开仍还原用户折叠态。不同步全部窗口开关，不改宿主。新增单测覆盖新空白/guide seat 可见与用户后续收起不被抢开，e2e 删除新会话后的手动展开。

验证：46 项定向测试通过；完整 298 个文件 / 3490 项通过、17 跳过；typecheck、build、pack 通过；精确 RC 挂载三项（完整 tab sweep、插件重载、workspace 双页面继承）通过。重新加载当前桌面客户端后，实际按钮与 Meta+N 入口均观察到 files/git 在展开面板内直接可见，无须手动展开；宿主会复用已有空白 session，未发送模型消息。

## 验证

已完成：typecheck；297 个单测文件通过，3484 项通过、17 项跳过；build + pack；引擎检查；新增文件定向 eslint。精确 DSH 0.2.1-rc.1 scratch profile 真实挂载整套通过：15 passed / 4 skipped（5.1 分钟），含 workspace 双页面继承/关闭传播/隔离、tree-scroll 跨会话草稿/滚动保留、页面内插件重载及稳态性能。最终新增定向 44 项通过。稳态 15s 窗口空闲请求为 0、session.cwd 为 0，没有新增常驻轮询。验证只安装到 scratch profile，未改当前用户 profile 或宿主源码；现有 GUI 不自动切换为开发包。

纯存储测试覆盖 schema、隔离、并发种类写入、tombstone、损坏/拒绝存储、外部事件、降级上限与释放。协调器测试覆盖跨会话、存储事件、未知 workspace、晚 adoption、焦点/折叠保留、禁用开关与 Git close guard。另运行 typecheck、完整单测、build/pack、引擎与真实挂载门禁。实际执行结果在完成验证后补记。

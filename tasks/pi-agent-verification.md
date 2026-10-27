# Pi Agent 实现与验收记录

日期：2026-10-27

分支：`feat/pi-agent-integration`

已关闭的草稿 PR：[huaigu/CopilotKit#1](https://github.com/huaigu/CopilotKit/pull/1)

复核：2026-10-28，见 [代码 review 与修复记录](./pi-agent-review.md)。按用户要求只保留功能分支，不再创建 PR。

## 实现

- `packages/pi-agent`：独立服务端适配包，使用真正的 Pi SDK 会话，接入 AG-UI 文本流、后端工具、前端工具回传、人工确认、共享状态、受控 Skill、停止和已完成历史恢复。
- `examples/v2/react/pi-agent`：使用 CopilotKit v2 聊天组件的 Next.js 示例，提供中英文界面、报价工具、页面目标值、确认／拒绝和恢复对话。
- 运行链路是浏览器 → CopilotRuntime → Pi SDK，不需要 Python 或 FastAPI。
- SDK `1.4.0`、AG-UI `1.0.2`、CopilotKit `1.81.0`；本机验证使用 Node.js `24.22.1`。Pi 模块要求 Node.js `22.19+`。

## 已验证

| 检查           | 结果      | 说明                                                                                                              |
| -------------- | --------- | ----------------------------------------------------------------------------------------------------------------- |
| 适配包测试     | 33 项通过 | 真实 Pi SDK + 确定性 provider；包含 12 项真实 Runtime HTTP / CopilotKit Core 集成测试                             |
| 适配包类型检查 | 通过      | Nx `check-types`                                                                                                  |
| 适配包构建     | 通过      | Nx `build`                                                                                                        |
| 相关 Core 回归 | 17 项通过 | 前端工具占位、并行工具顺序、工具执行中取消；按三个现有测试文件直接运行 Vitest                                     |
| 新示例类型检查 | 通过      | Nx `pi-agent-example:check-types`                                                                                 |
| 锁文件         | 通过      | pnpm `10.33.4` 的 frozen lockfile 校验；保留所有已有 importer、package、snapshot 的内容，仅新增两个项目及所需依赖 |
| 浏览器验收     | 7 项通过  | Playwright 在生产构建上验证双语、工具、确认／拒绝、状态、Skill、刷新与停止                                        |
| 示例生产构建   | 通过      | Next.js build                                                                                                     |
| 真实模型彩排   | 未执行    | 当前环境没有配置模型服务凭据                                                                                      |

测试中的 provider 只替换模型输出；工具执行、会话写入、AG-UI、HTTP 流及浏览器交互均经过实际 SDK。该结果不代表真实模型的工具选择或指令遵循能力已得到验证。

## 测试发现并修复的问题

1. Pi 在落盘前发布消息事件，导致用户消息 ID 和前端乐观消息顺序漂移。适配器保留客户端 ID，并正确处理起始历史快照。
2. 传输结束后前端工具仍在等待。适配器保留原 Pi 工具 Promise，下一次 AG-UI 请求回传后恢复同一次执行，重复回传不会再执行。
3. 主动停止与前端等待、服务器关闭与运行接入之间存在竞争。增加明确取消、结束顺序和关闭检查；实际 SDK 回归验证关闭返回后没有模型调用或事件。
4. 并发元数据写入和工具配置重建可能互相覆盖。元数据写入串行化，会话重建先登记 Promise。
5. Next.js 内部 hostname 与浏览器 Host 不同，停止接口误返回 403。现按浏览器 Host 校验来源，并单独处理主动取消提示。
6. 停止人工确认后刷新，Runtime 的旧事件重放可能覆盖 Pi 已取消的工具结果，重新打开确认卡片。新增 `PiAgentRunner`，已结束任务从 Pi 历史恢复，运行中仍复用 Runtime 的连接；增加真实 HTTP + Core 回归，并在生产浏览器验证取消、刷新和下一轮对话。对于意外退出时未完成的工具，在 UI 历史中补充稳定的中断结果；测试恢复实际 SDK 在等待确认时写入的文件，验证不会重新触发确认，且下一轮可执行。Pi 原生会话记录不受该投影修改。
7. 示例 CSS 的通用变量名与 CopilotKit 样式冲突，影响确认控件对比度。改用 `--pi-*` 变量，并检查中英文桌面截图和窄屏截图；中文检查环境补充了 CJK 字体。
8. 测试直接使用 `zod` 却未声明为测试依赖。补齐依赖及锁文件 importer；浏览器模型桩也改为只显示用户文本，并加强新一轮回答包含历史项目名的断言。

## 验证环境与边界

本机使用独立、锁定版本的 npm 依赖环境运行定向 Nx 任务，禁用 Nx daemon / 隔离插件并跳过缓存。没有完成整个仓库的 frozen 依赖安装或全仓回归；新增 CI 在标准 pnpm 工作区中运行适配包、示例构建和浏览器测试。

完整工作区依赖解析与 Next 编译并行曾触发本机内存限制。依赖锁定改用仅包含两个新项目的工作区解析，再加入主锁文件，并验证原有条目完全未变和 frozen 校验通过。浏览器构建使用独立缓存与有限 worker，重任务逐项执行。

自动审批曾因框架默认遥测拦截浏览器测试。重跑配置同时关闭 Next.js / CopilotKit 遥测，先断言 Runtime 的 `telemetryDisabled=true`，并阻止浏览器向本机之外发出请求。

示例是本地单用户、持久 Node.js 进程场景。未验证多实例、Edge、媒体消息、完整 MCP / 插件生态或真实模型服务。进程退出后的未完成工具调用标记为中断，不自动重放副作用。

## 复现

在标准工作区安装后：

```sh
pnpm nx run @copilotkit/pi-agent:test
pnpm nx run @copilotkit/pi-agent:check-types
pnpm nx run @copilotkit/pi-agent:build
pnpm nx run pi-agent-example:check-types
pnpm nx run pi-agent-example:build
pnpm --dir examples/v2/react/pi-agent exec playwright install chromium
PI_E2E_PRODUCTION=true pnpm nx run pi-agent-example:e2e
```

真实模型验收：按示例 README 配置服务端模型与凭据，保持 `PI_TEST_MODE=false`，重新执行中英文多轮、工具、确认／拒绝、Skill 和停止彩排，再记录 provider、模型、日期与结果。

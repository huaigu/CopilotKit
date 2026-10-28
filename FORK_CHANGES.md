# huaigu/CopilotKit 更新说明

本文记录 `feat/pi-agent-integration` 分支本轮新增的 Pi Agent 接入，作为本 fork 自有改动的说明入口。后续新增功能可继续在这里追加。

**当前状态：代码和自动化验证已完成，真实 LLM 联调尚未完成。修改仍在功能分支，尚未合并到 `main`。**

## 新增了什么

新增 Pi 的服务端适配包和一个中英文 React 示例。Pi 负责模型调用、工具循环、Skills 与会话；CopilotKit 负责聊天界面、工具展示和浏览器交互。Pi 通过 TypeScript CopilotRuntime 接入，运行这条路径无需 Python、FastAPI 或 LangGraph 服务。已有 Agent 集成继续保留。

| 模块       | 位置与用途                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Pi 适配包  | [`packages/pi-agent`](./packages/pi-agent/README.md)：提供 `PiAgent`、`PiSessionStore` 和可选的 `PiAgentRunner`                |
| React 示例 | [`examples/v2/react/pi-agent`](./examples/v2/react/pi-agent/README.md)：Next.js 聊天工作台、工具卡片、人工确认和共享状态       |
| 示例 Skill | [`skills/greeting/SKILL.md`](./examples/v2/react/pi-agent/skills/greeting/SKILL.md)：通过实际 Pi 读取工具验证 Skill 加载与使用 |
| 验证配置   | [Pi 专项 CI](./.github/workflows/test_pi_agent.yml)、Nx 构建依赖、配置白名单和浏览器回归                                       |

本轮实现包括：

- 中英文流式对话、多轮上下文和后端工具执行。
- 浏览器工具、确认／拒绝，以及工具回传后继续同一次 Pi 任务；支持串行和并行工具交接。
- 页面与 Pi 的共享状态、受控 Skill 加载与读取。
- 主动停止、刷新恢复、已完成会话的持久化；进程中断后的未完成工具显示为中断，不自动重放。

## 如何启动

使用 **Node.js 22.19+**，切到 `feat/pi-agent-integration`，在仓库根目录执行：

```sh
pnpm install --frozen-lockfile
cp examples/v2/react/pi-agent/.env.example examples/v2/react/pi-agent/.env.local
```

在 `.env.local` 中配置 `PI_PROVIDER`、`PI_MODEL`、`PI_API_KEY`；使用兼容接口时按需设置 `PI_BASE_URL`。保持 `PI_TEST_MODE=false`，然后启动：

```sh
pnpm nx run pi-agent-example:dev
```

打开 <http://127.0.0.1:3010>。Nx 会先构建 Pi 适配包。模型和凭据由服务端使用；自定义 Pi 模型描述符的接法见[适配包说明](./packages/pi-agent/README.md#configuration)。

没有模型凭据时，可显式运行验证模式：

```sh
PI_TEST_MODE=true pnpm nx run pi-agent-example:dev
```

页面会显示“验证模式”。该模式替换模型输出，实际 Pi SDK、工具、HTTP 和浏览器交互仍然运行，不能据此判断真实模型已接入成功。

## 已验证与待验证

| 检查           | 当前结果                                                                  |
| -------------- | ------------------------------------------------------------------------- |
| Pi 适配测试    | 33 项通过，包含 12 项实际 Runtime HTTP／CopilotKit Core 集成测试          |
| 生产浏览器验收 | 7 个场景通过，覆盖工具、确认、状态、Skill、恢复、停止及窄屏               |
| 类型检查与构建 | 适配包和示例通过，包含无 Pi 构建产物时的独立示例类型检查                  |
| 真实 LLM 联调  | **待完成**：需要配置实际 provider／模型，验证真实调用、工具选择与完整续跑 |
| 全仓 CI        | 尚未确认最终全绿；不能将专项验证结果视为全仓验收完成                      |

模型输出在现有自动化测试中由确定性 provider 提供。完整验收仍需用实际模型跑中英文多轮、前后端工具、确认／拒绝、共享状态、Skill、停止和异常恢复。

## 使用范围

首版面向本地单用户、持久 Node.js 进程和本地会话文件。未提供多用户权限、多实例一致性或 Edge 部署；DSH、完整 MCP／插件生态和媒体消息不在本轮范围内。`@copilotkit/pi-agent` 是仓库内的 private 包，尚未发布到 npm。

## 进一步阅读

- [适配包 API 与配置](./packages/pi-agent/README.md)
- [示例启动与操作说明](./examples/v2/react/pi-agent/README.md)
- [接入计划](./tasks/pi-agent-integration-plan.md)
- [实现与验收记录](./tasks/pi-agent-verification.md)
- [代码 review 与修复记录](./tasks/pi-agent-review.md)

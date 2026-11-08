# omp-agent

面向个人工作流的 OMP 插件，提供任务管理、受控执行、结果验证和文件交付。

OMP 负责模型与工具调用循环；插件维护任务身份、要求版本、执行边界和验证证据，让结果能够被检查和追溯。

文档：[架构](docs/architecture.md) · [测试](docs/testing.md) · [版本说明](docs/release-notes.md)

## 当前状态

项目处于实验阶段，提供基于宿主 JSON 配置的插件入口，尚未正式发布版本。当前已验证的本地环境为 macOS、OMP 18.18.0 和 Bun 1.4.0；其他平台与版本需要单独验证。真人使用验收尚未完成。

包的默认入口为 `src/daily-entry.ts`。可以从源码检出目录或本地打包后的解包目录加载；下文配置和命令只影响本次启动，不会自动安装到现有 OMP profile。

## 已实现能力

| 能力 | 行为 |
| --- | --- |
| 任务管理 | 从真实会话输入建立任务，保留原始要求和后续修订，支持检查与取消 |
| 执行控制 | 校验任务身份与版本，在受限环境运行 Python 或 Bun 脚本，读取授权输入并归档产物 |
| 结果验证 | 使用宿主配置的验证契约和验证器检查候选产物，记录逐项结果及覆盖不足 |
| 文件交付 | 导出真实文件、要求来源和清单，提供有界预览，并在重复读取时核对文件身份和字节 |
| 宿主接收 | 对完整可信契约、适用验证和实际文件再次核对，幂等记录接收结果，并区分提交事实、可见性和后续完整性 |
| 本地审阅 | 显式启用后展示完整要求与选定文本文件；默认拒绝，完整浏览后才能单独选择接受并确认 |
| 运行记录 | 保留执行、取消、完成状态不明及验证失败等事实，避免把工具成功直接等同于任务完成 |

验证通过与任务最终接收是不同状态。实验模型工具支持验证、交付预览、提交及已接收文件查询；提交只在宿主证据完整且再次检查通过后生效。本地审阅组件已实现，真人使用验收尚未完成。同一进程内已支持连续任务；跨进程恢复仍未提供。

### 显式加载插件

从插件目录加载默认入口，可在同一实例组合 `agent_task`、`agent_execute`、`agent_verify` 和 `agent_deliver`。先准备一个宿主 JSON 文件，例如 `/absolute/path/to/agent.json`：

```json
{
  "schemaVersion": 1,
  "workspaceRoot": "/absolute/path/to/workspace",
  "inputs": [
    { "id": "source", "path": "/absolute/path/to/input.txt" }
  ]
}
```

将示例路径替换为实际绝对路径；工作区与输入文件必须已经存在。没有输入时填写 `"inputs": []`。然后启动：

```sh
OMP_AGENT_CONFIG="/absolute/path/to/agent.json" \
  omp --cwd "/absolute/path/to/workspace" \
  --extension "/absolute/path/to/omp-agent"
```

OMP 根据目录中的 `package.json` 加载这一组合入口，不要再同时加载 `task-entry.ts` 或 `execution-entry.ts`。已有受管任务 owner 时，新入口会拒绝覆盖它。未配置 `OMP_AGENT_CONFIG` 时，入口报告配置缺失并保持受管工具关闭，OMP 原生工具仍可使用。

| 配置项 | 含义 |
| --- | --- |
| `schemaVersion` | 必须为 `1` |
| `workspaceRoot` | 现有工作区的绝对路径；解析真实路径后必须与 OMP 本次 `--cwd` 工作区一致 |
| `inputs` | 显式授权输入列表，最多 8 项；每项只有唯一 `id` 和绝对文件 `path`，不接受目录或通配符 |
| `stateRoot` | 可选绝对目录，默认 `<workspaceRoot>/.omp-agent`；不能等于或包含整个工作区 |
| `pythonPath`、`bunPath` | 可选的宿主 Python/Bun 可执行文件绝对路径；不是模型工具参数 |
| `humanReview` | 省略或 `false` 时关闭；仅精确字符串 `"local-main-tui-v1"` 启用本地人工审阅 |

配置拒绝未知字段和版本。输入必须是普通文件，不能是符号链接或多重硬链接，也不能位于受管 `stateRoot` 内；它们可以位于工作区之外，但必须由宿主逐项授权。执行时使用授权文件的受控副本，并继续检查输入及产物限制。

当前启动会预检 Python、Bun 和 macOS 执行沙箱。未指定 `pythonPath` 时使用 `/Library/Developer/CommandLineTools/usr/bin/python3`；未指定 `bunPath` 时使用当前 Bun 或宿主 PATH 中可执行的 Bun。需要覆盖时，把对应绝对路径写入 JSON；入口不会安装运行时或自动放宽执行限制。

在已验证的 macOS 环境中，`/usr/bin/python3` 的 `xcrun` 转发路径会被执行沙箱拒绝。覆盖 `pythonPath` 时应选择直接解释器；仅能成功查询版本，不代表该路径能在沙箱中运行。

每次启动都会在 `stateRoot/instances/<新实例 ID>/` 中创建独立的执行、交付、接收目录和任务记录。同一进程内可在当前任务接收或取消后继续新任务；重启保留旧文件，但不会加载旧任务权限、候选索引或接收历史。这不是跨进程恢复。

单入口默认不绑定自动语义验证契约。验证可能报告 `insufficient`；生成文件、成功预览或工具成功都不等于任务已接收。要启用人工审阅，在同一 JSON 中增加 `"humanReview": "local-main-tui-v1"`，并使用真实 OMP main-agent TUI；模型仍不能批准，RPC 或无 UI 环境也不能完成批准。该入口不读取旧实验入口的 `OMP_AGENT_HUMAN_REVIEW` 等分散配置来启用此功能。

正常加载保留 OMP 原生工具、skills、规则及模型配置。插件的任务身份、执行、验证与接收保证仅覆盖已接入的受管调用；通过原生或其他扩展工具产生的副作用不会自动成为受管候选、验证回执或已接收结果。

组合入口在主 Agent 的普通提示前附加一条固定的通用工作流提示：若请求需要受管，应先建立任务；交付文件应通过 `agent_execute` 生成为已登记候选，使用已授权输入句柄，并对实际返回的选择执行 `agent_verify`，需要可读路径时使用 `agent_deliver` 预览；生成、验证与接收应分别如实报告。原生工作区写入和 shell 自测不会被描述为受管候选或回执。该提示仅为建议，不自动创建任务、不授予权限、不强制使用受管工具，也不改变默认关闭的人工复核、身份与版本校验、预算限制或原生工具可用性。

## 开发与验证

需要本机安装 Bun 和 OMP。在项目目录运行：

```sh
bun install
bun run check
```

`check` 执行 TypeScript 类型检查、单元测试，以及独立进程中的人工复核模拟测试。模拟测试覆盖宿主机制与组件行为；模拟或自动按键不代表真人审阅。

以下集成测试会启动实际 OMP，使用临时 profile、私有测试目录和本地测试服务：

```sh
bun run test:omp
bun run test:entry
bun run test:jobs
bun run scripts/test-execution.ts
bun run test:delivery
bun run test:daily
bun run test:package-entry
```

这些命令使用确定性本地测试模型，不调用付费模型。`OMP_COMMAND` 可指定 OMP 可执行文件。

`test:package-entry` 会真实打包、检查分发清单，并从源码目录及解包目录运行插件。创建本地包时，先准备输出目录，再运行：

```sh
bun pm pack --destination "/absolute/path/to/package-output" --ignore-scripts
```

将生成的 `.tgz` 解包后，把启动命令中的插件目录指向解包得到的 `package/`。配置仍放在包外；打包文件不包含个人输入、状态、测试夹具或内部文档。

## 实验接口

| 入口 | 工具 | 用途 |
| --- | --- | --- |
| `src/daily-entry.ts` | `agent_task`、`agent_execute`、`agent_verify`、`agent_deliver` | 通过 `OMP_AGENT_CONFIG` 显式配置的组合入口 |
| `src/extension.ts` | `agent_status` 及受管测试工具 | 显式加载的接入与权限边界测试 |
| `src/task-entry.ts` | `agent_task` | 建立、检查、修订、取消当前任务，并读取有界历史；终态任务后可继续新任务 |
| `src/execution-entry.ts` | `agent_execute`、`agent_verify` | 受控执行及宿主验证，需先加载任务入口 |
| 显式配置交付目录 | `agent_deliver` | 查看能力、生成与预览交付文件；配置接收目录后可提交及查询 |
| `src/job-entry.ts` | `agent_job` | 独立的作业适配实验，需先加载任务入口 |

执行与验证请求必须引用当前任务及要求版本。运行、产物和回执 ID 只用于选择已登记对象，不授予权限。路径、运行环境、资源限制及验证策略由宿主配置，模型不能通过工具参数修改。

`agent_task` 的修订和取消必须携带从宿主可见任务事实复制的 `expectedTaskId` 与 `expectedTaskRevision`；可选的 `inspect` 选择器用于读取一个可见历史任务。它们只是精确目标/并发 guard，不是授权。一个真实用户消息最多创建一个任务；当前任务仍活动时不会被隐式替换。任务接收或取消后，同一会话的后续真实消息可以创建新任务；旧任务身份、要求和终态只读保留，`history` 返回有界摘要。`agent_job` 的提交和查询同样需要精确任务选择器，旧任务参数不会改指新任务。历史保存在进程内，不构成跨进程恢复。

以下环境变量用于分别加载的实验入口，单入口使用上文 JSON 配置。

交付功能需要宿主显式提供绝对 `deliveryRoot`；实验入口对应环境变量为 `OMP_AGENT_DELIVERY_ROOT`。未配置时不注册交付工具。交付目录不能与执行目录重叠。最终接收另需显式提供 `acceptanceRoot`（`OMP_AGENT_ACCEPTANCE_ROOT`），且三个根目录两两不重叠。未配置接收目录时仍可预览，提交会明确返回未启用。

`agent_deliver submit` 和 `inspect` 只接受现有 `deliveryId` 及任务身份、版本。提交和请求复核针对当前任务；`inspect` 可以用宿主历史中已知的精确选择器核对本进程内的旧接收结果。查询的 `target` 描述所选任务，顶层 `taskAccepted`、`currentTaskId` 和 `currentTaskStatus` 仍描述当前任务；只读查询不会切换或重新提交任务。历史接收事实与文件完整性分别报告，文件被改动不抹去原接收事实。路径仅在最后实际上下文和文件检查都有效时返回。

人工复核默认关闭。实验入口仅在 `OMP_AGENT_HUMAN_REVIEW=local-main-tui-v1` 时启用，还需要交付和接收目录及实际 main-agent TUI 上下文。未设置或空字符串表示关闭，其他非空值均为配置错误。RPC、子 Agent 和无 UI 环境不能批准。

`agent_deliver request_review` 只选择现有交付及精确任务版本，模型不能提供批准标志、回执或任意路径。界面默认选择拒绝；所有完整内容实际绘制后，才允许单独选择接受并确认。缩放会重置浏览记录，粘贴不能批准，固定五分钟期限包含准备时间。部分自动验证保留原始覆盖不足结果；失败或无效验证不能被人工复核绕过。

上述原生终端场景已通过自动按键工程验证，包括真实五分钟到期。真人可读性和实际操作验收尚未完成，当前仍用于隔离环境开发。

## 使用边界

- 当前插件用于有界本地试用；尚未正式发布版本，也不会自动安装到日常 profile。
- 本地执行只支持已验证范围内的运行时与授权输入，不提供任意命令或任意工作区访问。
- 验证结果会区分通过、失败和覆盖不足；模型自测不能代替宿主验证。
- 候选登记和交付索引目前保存在进程内，不承诺重启后自动恢复。
- 作业适配器目前使用本地测试服务验证生命周期，不代表已接入生产作业平台。
- 集成测试通过证明相应接口与控制行为，不代表任意任务的成功率或生产就绪程度。

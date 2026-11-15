# omp-agent

面向个人工作流的 OMP 插件，提供任务管理、受控执行、结果验证和文件交付。

OMP 负责模型与工具调用循环；插件维护任务身份、要求版本、执行边界和验证证据，让结果能够被检查和追溯。

文档：[架构](docs/architecture.md) · [测试](docs/testing.md) · [版本说明](docs/release-notes.md)

## 当前状态

项目处于实验阶段，尚未正式发布版本。默认受管入口使用宿主 JSON 配置，其实际接线验证固定在 macOS、OMP 18.18.0 和 Bun 1.4.0；另有单独加载的原生工作观察入口、可配置主会话定义入口和原生子实例入口，在 macOS、OMP 18.20.2 和 Bun 1.4.0 上分别做版本限定验证。不同入口的验证范围分别记录，其他环境需单独验证。真人使用验收尚未完成。

包的默认入口为 `src/daily-entry.ts`。可以从源码检出目录或本地打包后的解包目录加载；下文配置和命令只影响本次启动，不会自动安装到现有 OMP profile。

可配置主会话定义和原生子实例入口已作为可选实验入口提供；完整独立 Agent 实例生命周期、实例间 Flow、结果信封、取消/被取代工作及产物关联仍未接通。定义入口在同一 OMP 内核上加载一份显式 Agent Markdown 的初始文本，选择模型并收窄工具范围；子实例入口再把一份显式主定义与限定数量的原生直接子任务关联起来，但不替换 OMP 调度、权限或模型循环。两个入口均已在本机固定版本范围内演示有界行为，定义入口包括只读汇总与实际转换产物；但仍有已确认的真实模型内容错误和已恢复的工具错误，原生观察入口也仍有未通过独立内容复核的真实模型样本。详见[测试记录](docs/testing.md)。

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

### 原生工作观察入口（实验）

`src/native-entry.ts` 可单独显式加载，让普通请求沿用 OMP 的模型循环、原生工具和授权，并附加理解目标、检查输入、执行后实际校验及必要时修正的通用指导。例如：

```sh
omp --cwd "/absolute/path/to/workspace" --no-extensions \
  --extension "/absolute/path/to/omp-agent/src/native-entry.ts"
```

这个入口不需要 `OMP_AGENT_CONFIG`。只加载该入口；已有受管 TaskOwner 时它会关闭自身观察功能。包目录的默认入口仍为上文的 `daily-entry.ts`。

模型可通过 `agent_work inspect` 查看本轮实际观察到的调用，再用 `agent_work report` 引用同一轮的已完成调用并报告结果与限制。检查应与任务相称；无法检查的部分须明确说明。模型声明的完成情况、工具返回事实和选定文件的字节摘要分别记录。报告不是可信语义验证或宿主接收，也不要求普通工作等待严格接收后才能开始下一项请求。

记录仅保留在当前主会话进程的有界内存中，不能恢复旧任务。工具运行过但没有报告时，入口最多发送一次有期限的结束提醒；这是建议，不保证模型遵从。它不提供执行隔离、不接管原生权限、不保证子 Agent 继承策略，也不把其他工具的副作用登记为受管产物。文件摘要仅说明读取时观察到的字节，不证明这些字节经过所选检查。

### 可配置主会话定义入口（实验）

`src/defined-native-entry.ts` 可单独显式加载一份 Agent Markdown，为当前主会话提供初始定义文本。它不替换 OMP 内核：模型/工具循环、权限、原生工具与 Skill 目录仍由宿主提供；不同定义只是同一内核上的不同配置。名称、角色和定义正文都不是权威，不授予工具、审批、任务权限或流程权威。

示例 `/absolute/path/to/file-reviewer.md`：

```markdown
---
name: file-reviewer
description: Review one requested file and report bounded findings.
tools:
  - read
---

Inspect the requested file with the available tool. Report concrete findings and state what you did not inspect. Do not claim tools or permissions you do not have.
```

启动命令（插件目录和定义文件都使用绝对路径）：

```sh
omp --cwd "/absolute/path/to/workspace" --no-extensions \
  --agent-definition "/absolute/path/to/file-reviewer.md" \
  --extension "/absolute/path/to/omp-agent/src/defined-native-entry.ts"
```

只加载该入口；包目录的默认入口仍为 `daily-entry.ts`，普通目录加载方式不变。示例中的 `read` 必须实际存在于当前活动工具集，否则严格预检会拒绝；应按宿主实际工具调整。

入口在绑定前严格预检绝对路径、常规非链接文件、原生解析一致性和允许字段。初始 frontmatter 只接受 `name`、`description`、`tools`、`model` 和 `autoloadSkills`，其他原生字段按名称拒绝，正文必须非空。`tools` 只能收窄宿主当前活动工具集：省略表示继承当前集合，显式 `[]` 表示不保留角色工具，列出的名称必须精确存在于当前集合；未知或已停用工具会被拒绝。只读的 `agent_definition` 与观察用的 `agent_work` 仍作为伴随工具保留。`model` 至多一个，由宿主解析器解析；`provider/id` 必须精确解析为同一身份，裸名称或 `@` 前缀选择器保留原拼写并记录解析身份，thinking/routing 后缀、多重选择器、无法解析或 `provider/id` 不精确匹配会被拒绝；`@` 只是模型选择器拼写，不是权限角色。`autoloadSkills` 必须精确匹配当前活动 Skill 名称；缺失、重复、超过 8 个、歧义别名或加载后的元数据不一致会使绑定失败，入口不自行扫描或覆盖 Skill 发现结果。

启动时会在异步原生模块导入之前安装拦截。缺少或无效的解析依赖、无效定义、未知身份、已有受管 TaskOwner、已知的模型/工具/会话/工作区漂移或导航都会使绑定失败，并阻止普通输入、提示和工具调用。失败后 `/agent-definition-status` 与只读 `agent_definition` 工具仍可诊断，但不会修复、重载或重新绑定。绑定成功后，定义与所选 Skill 的初始文本被冻结，状态中的快照版本保持稳定；修改文件不会影响当前进程，变更定义必须启动新的 OMP 进程。定义版本只是内容快照标识，不是任务要求版本。

主会话交互式/RPC 输入中的精确 `/agent-definition-status` 会在本地显示只读绑定状态：不创建新工作、不清除已发出的一次性提醒；带参数或图片会被拒绝，命令注册缺失或失败时返回不可用诊断。独立入口只保留这一个状态名；`/agent-instances-status` 只在可选实例组合中存在，且需要主绑定校验通过和实例命令已注册。状态读取使用最新事实，检测到实际绑定漂移时可能拒绝已变化的绑定；显示本身失败会被本地消费，不会触发模型或创建工作，也不保证追加可见通知，且不构成绑定失败。

D1 入口自身的验证范围固定为 macOS、OMP 18.20.2 与 Bun 1.4.0 的主会话，只支持一个显式绑定，不能与受管 TaskOwner 同时启用，也不支持多实例、子 Agent 委派或跨实例 Flow；需要限定直接子任务时使用下面的原生子实例入口。冻结范围仅限初始定义与所选 Skill 文本，不冻结脚本、模板或 `skill://` 资源。诊断可能只报告 `hasPendingMessages` 布尔值，没有精确队列计数；已观察到 abort 后 `sessionSettled:false`，不承诺恢复、队列清除或结算。已安装的 input、before_agent_start 与 tool 钩子不覆盖每个 provider 请求、已在运行的工具、缺失插件或操作系统沙箱；普通 OMP 工具副作用仍由宿主权威控制，工作观察报告也不等于语义验证或任务接收。加载该入口不会自动应用策略，也不修改默认入口或默认策略。

### 原生子实例入口（实验）

`src/instanced-native-entry.ts` 是新的显式可选入口，把一份现有 `--agent-definition` 主定义与 1–8 份显式 Agent Markdown 子定义关联到 OMP 原生 `task` 直接子任务。它组合 D1 主定义绑定与现有原生工作观察，不新增模型循环、任务执行器或定义格式；包目录默认入口仍为 `daily-entry.ts`。主定义应放在原生子定义发现目录之外，避免与子定义发现结果冲突。只加载该入口；`--no-extensions` 会关闭扩展的自动发现，但显式 `--extension` 仍会加载。

主定义沿用 D1 的 `name`、`description`、`tools`、`model`、`autoloadSkills`，不接受子定义的 `blocking`/`structured`。子定义也使用这些字段，并额外要求字面量 `blocking: true`、`structured: false`、显式 `model` 和 `tools`；`autoloadSkills` 可选。所选子文件必须与当前原生 project/user 发现的实际胜出项一致。主定义放在原生子定义发现目录之外，例如 `/absolute/path/to/workspace/.omp/main.md`：

```markdown
---
name: main
description: Delegate bounded file inspection.
tools:
  - read
  - task
model: provider/model
---

Delegate requested file inspections to the selected native child definition and report the observed result.
```

子定义放在项目发现目录，例如 `/absolute/path/to/workspace/.omp/agents/file-reader.md`，以便原生 project 发现选中它：

```markdown
---
name: file-reader
description: Read one requested file and report bounded findings.
tools:
  - read
model: provider/model
blocking: true
structured: false
---

Read the requested file with the available tool. Report what you actually observed and what you did not inspect.
```

将两处 `provider/model` 替换为当前已配置且可解析的模型；主定义必须声明 `task`，`read` 必须实际存在于活动工具集，且子定义的工具集必须是主定义活动工具集的子集。`name` 在当前主根内必须稳定；改名需要新的 OMP 进程。每个 `task` 调用都会重新加载并冻结一份子定义快照，实例保留该次调用的冻结版本，后续文件修改不会改变它。

入口要求五个生效的 scoped 设置。本地覆盖文件示例：

```yaml
async:
  enabled: false
task:
  batch: false
  speculativeLaunch: false
  workerThreads: 0
  structured: false
```

入口检查这五个生效值；其他宿主配置仍由本次本地 profile 决定。

启动示例（所有路径使用绝对路径；该文件只传给本次启动，不要修改全局配置）：

```sh
omp --cwd "/absolute/path/to/workspace" --no-extensions \
  --config "/absolute/path/to/omp-instance-profile.yml" \
  --agent-definition "/absolute/path/to/workspace/.omp/main.md" \
  --agent-child-definitions '["/absolute/path/to/workspace/.omp/agents/file-reader.md"]' \
  --extension "/absolute/path/to/omp-agent/src/instanced-native-entry.ts"
```

`--agent-child-definitions` 接受 1–8 个绝对 `.md` 路径的 JSON 数组。示例使用源码检出路径，不改变包默认安装方式。只支持一个主根/进程、固定 cwd 和直接子任务；任务参数必须是一个扁平对象（`agent`、`task` 及可选的 `description`、`solutionSpace`、`i`），不支持 batch、推测启动、worker、async、structured 输出、原生恢复、导航、共享计划、worktree 或 eval 模式。根、事件总线代际和子工厂身份不匹配时失败关闭；不支持的转换或容量耗尽需要重启恢复。原生权限、工具循环和已有受管 TaskOwner 排除规则保持不变。

新入口只在自身组合中把 `agent_definition` 与 `agent_work` 设为默认不激活，并在主定义绑定成功后显式激活；子定义不能选择这两个伴随工具。子会话的实际模型和活动工具必须与冻结快照完全一致，原生 Role/Skill 全文校验不通过即拒绝。

默认上限为 8 份选中定义、16 个 pending 准入、64 条保留记录和 8 MiB 初始 Role/Skill 正文文本；已用调用 ID 集合同样有界。记录不会驱逐，也没有持久恢复；容量满时拒绝新委派并要求重启。8 MiB 只是初始正文文本上限，不是整个进程的内存预算，也不是 frontmatter 大小限制。

只读 `/agent-instances-status`（或进程内 `getStatus()`）返回当次构建并冻结的非权威诊断。状态 JSON 上限 64 KiB：正常时 `view.complete=true`；超限时 `view.complete=false`、`reason:"encoded-size-limit"`，给出完整详情的字节数与摘要、省略的 selections/pending/instances 数量及阶段计数，详情数组省略但不改变内部记录，也不分页。状态构建失败时 `view.reason:"status-unavailable"`，完整详情指标和未知计数为 `null`，回退载荷的字节与摘要另以 `fallbackBytes`/`fallbackSha256` 单独命名；未知不等于零。`/agent-definition-status` 仍保留。

实例状态输入沿用本地早期识别，仅在主绑定校验通过且实例命令已注册时显示；实例根失败仍可显示只读状态，主绑定失败或解析中时拒绝实例诊断，`/agent-definition-status` 仍可用。该显示同样不创建 pending 工作、不清除一次性提醒；默认包入口仍为 `daily-entry.ts`。

固定宿主的有界负向验证还覆盖缺失 Skill 与不支持设置：缺失 Skill 的一次 `task` 尝试在子会话启动前被预检阻止；不支持设置使实例层启动失败，D1 主定义仍保持绑定，且无 provider 派发。生命周期 `completed`、`taskResultObserved` 与 Role/Skill 文本门通过都只是观察，不等于产物或语义接收；结果信封、取消、被取代工作和产物关联属于下一阶段（D2-C），尚未实现。不承诺并发、恢复或无上限长会话；这是固定宿主的实验性有界兼容入口，不是完整 D2、模型质量或最终产品就绪证明。

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
| `src/native-entry.ts` | `agent_work` | 单独加载的原生工作观察试点；报告与严格接收分开 |
| `src/defined-native-entry.ts` | `agent_definition`、`agent_work`、`/agent-definition-status` | 显式主会话 Agent Markdown 绑定；组合现有原生工作观察，绑定状态只读，定义变更需新进程 |
| `src/instanced-native-entry.ts` | `agent_definition`、`agent_work`、`/agent-definition-status`、`/agent-instances-status` | 组合主定义绑定与有界原生直接子任务关联；实例状态只读，默认包入口不变 |
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
- 主会话定义入口固定为单进程、单显式绑定，且不能与受管 TaskOwner 同时启用。原生子实例入口只支持一个主根、直接子任务和有界内存记录；完整多实例、实例间 Flow、结果信封及恢复仍未提供。
- 受管执行只支持已验证范围内的运行时与授权输入，不提供任意命令或任意工作区访问；原生入口沿用 OMP 的原生执行权限。
- 验证结果会区分通过、失败和覆盖不足；模型自测不能代替宿主验证。
- 候选登记和交付索引目前保存在进程内，不承诺重启后自动恢复。
- 作业适配器目前使用本地测试服务验证生命周期，不代表已接入生产作业平台。
- 集成测试通过证明相应接口与控制行为，不代表任意任务的成功率或生产就绪程度。

# DSH Meta-Team

DeepSeek Harness（DSH）的外置多智能体 Harness RSI 实验插件，参考 **Meta-Team / Evolve as a Team** 的成员、交互与团队三阶段演化机制。

插件复用 DSH 的模型调用、工具循环和 Session，不在其外面再套一套 Python agent loop。

> **当前状态：开发预览。** 已通过离线测试和真实 DSH 运行时的模拟模型集成测试；尚未运行真实模型实验或完整 benchmark，也不是 Meta-Team 论文的完整复现。安装后插件默认禁用，必须先配置再启用。

## 已实现

- 候选成员池、动态启动与停止、成员消息和最终交付。
- **L1 成员演化**：行为补丁、局部 skills。
- **L2 交互演化**：伙伴画像、成对协作记录。
- **L3 团队演化**：团队规则、成员配置、成员增删。
- `fixed` / `local` / `collaborative` 三种模式。
- 独立任务工作副本、版本快照、冻结导出和异常中止。
- 按成员与阶段控制反思工具，记录执行事件和 token 使用。
- 可选的本机 Unix socket 控制入口，供 Python 实验脚本提交反馈。

插件权限检查仅约束自身演化工具；**不能代替 shell、文件或其他工具的沙箱**。

## 兼容环境

| 项目 | 要求或验证范围 |
|---|---|
| Node.js | ≥ 24.9.0 |
| DSH 安装版本（插件 `v0.1.1`） | **0.2.2-rc.4** 或 **0.2.2-rc.5** |
| Cordis | 4.1.0 |
| 本机控制 socket | macOS / Linux；Windows 暂不支持此入口 |
| 模型 | 使用 DSH 中已配置的 provider/model，插件不内置密钥 |

DSH 的接口仍在变化。`v0.1.1` 将安装声明放宽到上述两个明确版本，不需要设置版本豁免。`rc.4` 已验证协作、反馈和快照继承流程（上游提交 `ca33fd6843b205e279c7ccb6cb73a472c78f5760`）；`rc.5` 的端到端验证尚未完成。

## 在 DSH 中安装

仓库：<https://github.com/yangjingbo123/dsh-metateam>

### 方法一：从 GitHub 安装

在希望使用插件的 profile 中安装；下面以 `web` 为例：

```sh
dsh plugin --profile web add git+https://github.com/yangjingbo123/dsh-metateam.git#v0.1.1
```

软件包名称是 **`dsh-meta-team`**，仓库名称是 **`dsh-metateam`**，两者不同。包内包含编译后的入口，无需在安装时运行构建脚本。也可以在 DSH 的插件管理页面中输入同一个 Git 地址。

安装成功后，bundle 中的 `meta-team-research` 行仍默认禁用。这是正常行为，避免未配置路径时启动失败。

### 备用方式：安装旧版 Release 压缩包（只支持 DSH `rc.4`）

如果使用 DSH `rc.4` 且 Git 下载不稳定，可以用旧的 `dsh-meta-team-0.1.0.tgz`。**DSH `rc.5` 请使用上面的 `v0.1.1` Git 地址**；旧压缩包仍会被拒绝。

```sh
dsh plugin --profile web add https://github.com/yangjingbo123/dsh-metateam/releases/download/v0.1.0/dsh-meta-team-0.1.0.tgz
```

发布压缩包不包含上游仓库、模型凭据、临时运行目录或测试模型。

## 配置与启用

### 1. 准备自己的成员池

复制仓库的 `examples/pool` 到自己的实验目录，不要直接修改已安装包里的文件。

```text
pool/
  pool.yaml
  constitution.md
  implementer/
    config.yaml
    prompt.md
  reviewer/
    config.yaml
    prompt.md
```

示例提供两个角色，默认 `tools: []`，用于最小协作配置，**不是可立即跑代码任务的 benchmark 配置**。如果需要文件、shell、Docker 或 MCP 工具，必须明确安装并映射对应能力。

### 2. 写一个启用 patch

以仓库的 `examples/meta-team.patch.yml` 为模板，将路径替换为自己的绝对路径：

```yaml
- id: meta-team-research
  disabled: false
  config:
    poolDir: /absolute/path/to/pool
    stateDir: /absolute/path/to/experiment-state
    workspace: /absolute/path/to/task-workspace
    mode: collaborative
    provider: your-configured-dsh-provider
    model: your-provider-model-id
    executionTimeoutMs: 600000
    phaseTimeoutMs: 120000
    maxMessages: 200
```

- `poolDir`：原始候选成员池，只读复制，不直接在这里写入演化结果。
- `stateDir`：任务记录、工作副本和版本快照。每个插件实例使用独立目录。
- `workspace`：成员执行任务的工作目录，需预先存在。
- `provider` / `model`：DSH 实际提供的模型路由；这里的字符串是占位符。
- 内置提示资源随包提供，通常无需设置 `resources`。

### 3. 通过正式 profile 加载

```sh
dsh web --patch /absolute/path/to/meta-team.patch.yml
```

在其他 profile 上使用时，安装与启动需选相同 profile。不支持热更新的 profile 需要重启后生效。不要直接挂载临时 Cordis 应用替代 DSH 的正式启动入口。

## 运行流程

```text
创建任务与成员 Session
        ↓
成员协作并 finalize_task
        ↓
外部评价器提交反馈
        ↓
L1 → L2 → L3
        ↓
提交团队快照，供下一任务使用
```

插件不内置 benchmark 评价器，**不会在没有真实反馈时自动编造评分**。

## 具体算法：一次团队自我改进怎样发生？

### 一句话讲解

> 团队先协作完成任务；拿到外部反馈后，每个成员在自己的执行上下文里反思，再与实际合作过的伙伴复盘交接，最后由组织者决定团队规则或角色是否要改变。更新以文件和版本快照保存，下一个任务继续使用这些经验，底座模型权重不变。

本项目参考 Meta-Team 的多尺度演化思想，**不是在训练新的模型，也不是不断优化“负责优化的 agent”**。目前的提示词与工具说明由本项目编写，不等同于原论文逐字复现。

### 1. 输入、状态与输出

一次运行称为一个 **episode**。算法输入是当前任务、已发布的团队版本、运行预算和外部评价反馈；输出是本次交付物以及正常完成演化后发布的团队版本。

团队状态可以概念性地写为：

\[
\mathcal{T}_t=\left(\mathcal{A}_t,\{H_i^{(t)}\},C_t\right)
\]

- `A`：候选成员池；每个任务只启动其中需要的成员。
- `H_i`：成员自己的角色配置、行为补丁、skills、伙伴画像与成对协作记录。
- `C`：共享团队规则与组织配置。

下标 `t` 表示团队版本，不表示一次模型调用。运行时状态另外记录当前阶段、活跃成员、已完成反思的成员、Session 映射、消息、提案和消耗。

| 可更新对象 | 对应文件 | 如何影响未来执行 |
|---|---|---|
| 角色指令、模型和允许工具配置 | `<角色>/prompt.md`、`<角色>/config.yaml` | 下一个 episode 创建或加载角色时读取 |
| 行为补丁 | `<角色>/evolution/prompt_patches.md` | 加入该成员的上下文 |
| 可复用技能 | `<角色>/skills/<技能>/SKILL.md` | 先展示技能目录，调用 `use_skill` 后获取正文 |
| 伙伴画像 | `<角色>/evolution/teammate_profiles.yaml` | 帮助该成员理解伙伴的能力与配合方式 |
| 成对协作经验 | `<角色>/evolution/correlations/<伙伴>.md` | 保存信息交接、依赖和合作中的经验 |
| 团队规则与候选成员组织 | `constitution.md`、`pool.yaml` 及成员目录 | 决定下一任务的共同指令、chairman 和可招募成员 |

模型可以根据配置选择路由，但算法**不训练或更新模型参数**。

### 2. 执行阶段：先做任务，不边做边演化团队组织

`/meta begin` 将最新 `HEAD` 快照复制成该 episode 的工作副本，并将当前聊天绑定为 chairman。普通任务输入随后交给 DSH 执行；chairman 可通过 `list_pool`、`start_agent` 招募成员。

每个成员使用独立的 DSH Session，保存自己的模型与工具历史。成员通过 `send_message` 交接任务和证据，插件同时记录消息用于之后定位合作关系。独立 Session 不等于独立文件系统或独立进程；环境隔离仍由 DSH 的工具和沙箱配置决定。

协作或本地演化模式下，chairman 调用 `finalize_task(output)` 后，插件固定本次交付物，进入 `awaiting-feedback`。此时**不会自动判断成功，也不会把普通 turn 结束当作整个任务完成**。

外部实验脚本或人类通过 `/meta feedback` 提交实际结果，才启动 L1。原任务交付物与之后的反思内容分开记录，不能把反思后的解释当成重新完成了任务。

### 3. L1：把执行经验转为成员自己的改进

每个活跃成员收到最终交付物、外部反馈和 L1 指令，继续使用已有的本地 Session 上下文。它回答的是：

- 自己遗漏了什么观察、核验或工具步骤？
- 哪个输出使下游难以完成工作？
- 应保存哪条可用于未来任务的行为规则，或哪个可复用技能？

在 `collaborative` 模式，可以询问相关伙伴；在 `local` 模式，反思阶段禁止成员消息交换。两者都可以看到相同的外部任务反馈，因此 `local` 不等于完全没有团队结果信息。

成员通过 `update_prompt_patch` 或 `update_skill` 写入**自己的工作副本**。完成后必须调用 `skip_l1_reflection`：名字中的 `skip` 在本实现里也承担“本阶段已完成”的作用，不表示此前一定没有产生修改。

只有全部活跃成员完成 L1 才推进。`local` 模式在这里提交版本并结束；`collaborative` 模式继续 L2。

### 4. L2：学习怎样与伙伴配合

插件从**执行阶段实际发生的消息**中提取各成员的合作伙伴，而不是要求所有候选成员两两讨论。没有实际合作伙伴的成员自动记为 L2 完成。

其余成员围绕交接复盘：传出了什么、对方如何理解和使用、哪些约定有用、哪些依赖没有说明。可以继续通过成员消息核对证据，但不会自动将整支团队的完整轨迹塞给所有人。

两类更新不同：

- `update_teammate_profile`：记录“我怎样理解这个伙伴”。当前实现对列表字段去重合并，其他字段按新值更新。
- `update_correlation`：记录“我们怎样配合”。当前实现替换该伙伴的旧记录，因此调用者应保留仍有效的内容。

成员完成后调用 `skip_l2_reflection`，全部完成后进入 L3。**L2 不直接搜索任意通信图，也不保证画像一定正确**；它保存的是有待未来任务检验的合作经验。

### 5. L3：把局部发现变为团队级修改

普通成员通过 `suggest_team_improvement` 提出有证据的建议，例如需要增加哪种角色、哪些职责重复、哪条共享规则不足。chairman 用 `view_reflection` 查看建议，必要时用 `view_current_config` 查看原配置，再通过 `propose_reflection` 暂存完整的新文件。

支持的修改包括团队规则、成员配置与角色指令：新增角色必须有 `config.yaml` 和 `prompt.md`；删除通过目标 `config.yaml` 的 `__REMOVE__` 表示，当前 chairman 不允许被删除。

最后由 chairman 选择：

- `apply_reflection`：检查并采用暂存的 L3 提案，提交版本。
- `skip_reflection`：不改团队结构，但仍提交已产生的 L1/L2 更新。

普通成员可以用 `skip_l3_reflection` 声明自己建议结束。**当前实现允许 chairman 明确采用或跳过 L3 后结束任务，不要求所有普通成员完成 L3 才能提交。** 这与 L1/L2 的全员完成条件不同。

### 6. 保存版本，而不是覆盖初始配置

正常完成后，episode 的工作副本发布为新版本，并更新 `HEAD`；原始 `poolDir` 和旧版本不被覆盖。下一项任务从新 `HEAD` 创建新的工作副本，重新加载角色与规则。需要固定评测时用 `freeze` 导出明确版本。

L1/L2 写入的文件可能在后续请求组装时被当前成员读取；**工作副本写入与跨任务版本发布是两件事**。角色和团队组织的 L3 修改要到下一 episode 的加载过程才发挥完整作用。

超时、消息上限、费用上限或手动中止会进入 `aborted`，不发布新的 `HEAD`。候选文件仍留在 episode 工作目录，供检查原因，而不是偷偷成为下一任务配置。

### 7. 伪代码

```text
固定模型参数、DSH 运行时和插件更新程序
初始化候选成员池与团队快照 HEAD

对每个任务 x_t：
    W_t ← 从 HEAD 复制任务工作副本
    创建 chairman Session，按需启动其他成员
    用 W_t 协作执行，记录本地历史与成员消息

    如果模式是 fixed：
        记录交付物，终止任务，不发布新版本
        继续下一任务

    chairman 提交交付物 y_t
    等待外部反馈 r_t；不自行构造真值

    L1：成员利用本地上下文和 r_t 写入行为补丁或技能
        collaborative 可交换证据，local 禁止反思消息
        等待全部活跃成员完成

    如果模式是 collaborative：
        L2：依据实际合作关系，更新伙伴画像与协作记录
            等待成员完成；无合作伙伴者自动完成
        L3：成员提出建议，chairman 暂存并采用/跳过团队修改

    如果正常完成：
        验证发布所需的文件和角色配置
        将 W_t 保存为新快照，更新 HEAD
    如果中止：
        保留检查记录，不更新 HEAD
```

这段伪代码描述本插件的主要流程，不是梯度下降、全局最优搜索或对所有任务的改进保证。

### 8. 一个方便讲给别人听的例子

假设实现者提交了“计算正确”的说明，但审查者反馈没有实际测试记录。下面只是机制示例，不是已经取得的实验结果：

1. **外部反馈**：指出证据不足，而不是直接称任务完全成功。
2. **L1**：实现者保存“提交结论时同时交付核验依据”的规则；审查者保存一个检查流程 skill。
3. **L2**：实现者记录审查者需要哪种证据，双方约定交接时说明已做与未做的验证。
4. **L3**：chairman 将“关键结论要附验证状态”写入共同规则；不一定需要新增角色。
5. **下一任务**：团队加载新版本，检查这些更新是否真的减少无依据交付。

**与“大家各自反思”的区别**：成员自己的行为、对伙伴的认识与共同规则都可以更新；但每个尺度作用不同，不能用一条泛泛的“下次更小心”代替全部改进。

### 9. 当前算法没有做什么？

- **没有逐候选的性能择优保证**：L1/L2 工具主要保存文件，L3 主要检查路径与配置；目前不是对每项修改都进行“重跑 → 比较 → 择优采用”。
- **没有证明下游因果关系**：成员解释和交流提供线索，不等于严格因果归因。
- **没有自动验证泛化**：文件成功写入不代表未来任务一定改善，需用留出任务和成本对照验证。
- **没有演化运行时或评分器**：DSH 核心、模型参数、权限配置及外部评价逻辑不在本流程中自动更新。

因此，准确的介绍是：**这是一个基于执行经验与成员交流、持久更新团队 scaffold 的实验实现**，而非已证明有效或已完整复现原论文的算法。

### 10. 讲解时可以指向的代码

- [插件入口与 DSH 接入](plugins/meta-team/src/index.ts)：成员 Session、作用域工具、外部控制与事件记录。
- [算法状态机](plugins/meta-team/src/engine.ts)：执行、外部反馈、L1/L2/L3、工具权限与阶段推进。
- [快照存储](plugins/meta-team/src/store.ts)：工作副本、单写入者锁、`HEAD`、冻结与路径检查。
- [项目提示资源](scripts/build-resources.mjs)：各阶段指令与工具参数定义。
- [Python 实验控制](python/metateam_dsh.py)：分开处理任务执行、外部评价和反思完成。

### 模式

| 模式 | 行为 |
|---|---|
| `fixed` | 只执行任务，不更新配置；`set_final_output` 后 `terminate` |
| `local` | 各成员执行 L1，反思阶段不交换成员消息 |
| `collaborative` | L1、L2、L3，允许相关成员交换证据 |

### 控制命令

插件注册 `/meta` 命令：

```text
/meta status
/meta begin {"id":"task-001","task":"实际任务内容"}
/meta inspect
/meta feedback {"success":false,"summary":"实际评价反馈"}
/meta abort 停止原因
/meta freeze {"name":"frozen-team"}
```

`begin` 挂载任务配置，但不自动发起模型请求；之后再向相同 Session 提交任务。L1/L2 成员用对应的 `skip_l1_reflection`、`skip_l2_reflection` 声明本阶段完成，无论是否已经写入修改。

### Python SDK 的控制方式

在当前验证版本，`Session.run('/meta ...')` **不会**执行任意自定义命令，它可能被当成模型输入。SDK 实验请用 `python/metateam_dsh.py` 的控制客户端。

启用本机接口需额外配置：

```yaml
    controlSocket: /absolute/path/to/short-control.sock
    controlToken: replace-with-a-long-random-private-token
```

token 至少 16 字符；使用自己生成的随机 token，**不要提交到 GitHub**。socket 不监听 TCP，文件权限为 `0600`；在多用户机器上将其放入只有自己可访问的目录。Unix socket 路径有长度限制，尽量保持简短。

## 源码开发与测试

仓库提交了运行所需的 `dist/` 和项目自编写的提示资源。从 GitHub 安装插件无需先克隆 Meta-Team。

```sh
git clone https://github.com/yangjingbo123/dsh-metateam.git
cd dsh-metateam
npm install --ignore-scripts
npm run build
npm test
```

如果使用已构建的 DSH 本地源码，可以链接依赖而不修改 DSH 仓库：

```sh
export DSH_CHECKOUT=/absolute/path/to/deepseek-harness
python3 scripts/link-local-deps.py
npm run build
npm test
```

真实 DSH 的无付费模型测试：

```sh
export DSH_CHECKOUT=/absolute/path/to/built/deepseek-harness
# node 不在 PATH 时，额外设置 RUNTIME_NODE=/absolute/path/to/node
python3 scripts/smoke-dsh-plugin.py
python3 scripts/smoke-dsh-plugin.py --scripted
```

这些测试不会调用外部模型；模拟测试驱动实际 DSH 工具循环，检查消息、L1/L2/L3、快照及冻结文件。系统若禁止本机 socket 监听，需要为该测试授权。

## 当前限制

- 尚未完成 Meta-Team 所有行为的逐项一致性核对，不宣称完整复现。
- 官方 Docker/MCP benchmark 工具未移植；尤其不能把 `docker_bash` 默认为本机 `bash`。
- 尚无自动预算内任务重试、全部上游反思校验或超时后强制反思恢复。
- 保留成员的 DSH 会话，但其 token 历史和压缩策略不保证与原版一致。
- 费用使用显式单价估计，尚未分别计价缓存和全部失败重试。`maxCostUsd: 0` 表示关闭美元上限，不代表请求免费；正上限需要有效单价。
- 一实例一任务、一状态目录一写入者；崩溃后需人工确认旧进程退出，再处理遗留写锁。不要盲目删锁或复用中断状态。
- 一般环境工具可读写哪些路径由 DSH 沙箱决定，插件的局部修改检查不是完整安全隔离。
- 尚未运行真实模型或完整 benchmark。

## 参考来源

机制参考 **Evolve as a Team: Collaborative Self-Evolution for LLM-based Multi-Agent Systems**。本项目核对的 Meta-Team 上游提交：`36dc85d9dc2219d292fa180f347479738a84acb2`。

- Meta-Team：<https://github.com/zz-haooo/Meta-Team>
- DeepSeek Harness：<https://github.com/deepseek-ai/deepseek-harness>

本仓库不包含上游完整代码。发布提示词与工具说明由本项目重新编写，并在资源中记录来源关系。插件本身与研究方法仍处于开发阶段。

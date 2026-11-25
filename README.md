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

| 项目 | 当前验证范围 |
|---|---|
| Node.js | ≥ 24.9.0 |
| DSH 包接口 | **0.2.2-rc.4** |
| Cordis | 4.1.0 |
| 本机控制 socket | macOS / Linux；Windows 暂不支持此入口 |
| 模型 | 使用 DSH 中已配置的 provider/model，插件不内置密钥 |

DSH 接口仍在快速变化。目前依赖明确锁定版本；安装失败时先检查版本，不要盲目使用版本豁免或关闭兼容检查。已核对的 DSH 源码提交为 `ca33fd6843b205e279c7ccb6cb73a472c78f5760`。

## 在 DSH 中安装

仓库：<https://github.com/yangjingbo123/dsh-metateam>

### 方法一：从 GitHub 安装

在希望使用插件的 profile 中安装；下面以 `web` 为例：

```sh
dsh plugin --profile web add git+https://github.com/yangjingbo123/dsh-metateam.git#v0.1.0
```

软件包名称是 **`dsh-meta-team`**，仓库名称是 **`dsh-metateam`**，两者不同。包内包含编译后的入口，无需在安装时运行构建脚本。也可以在 DSH 的插件管理页面中输入同一个 Git 地址。

安装成功后，bundle 中的 `meta-team-research` 行仍默认禁用。这是正常行为，避免未配置路径时启动失败。

### 方法二：安装 GitHub Release 中的压缩包

如果 Git 下载不稳定，可以使用仓库 Release 中的 `dsh-meta-team-0.1.0.tgz` 下载地址：

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

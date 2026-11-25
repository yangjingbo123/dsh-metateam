/** Build project-authored tool descriptions/prompts; upstream checkout is optional. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const string = { type: 'string' }
const array = { type: 'array', items: string }
const definitions = {
  list_pool: ['列出候选角色、模型、工具与已启动状态。', {}, []],
  start_agent: ['chairman 启动一个候选成员；随后发送任务消息。', { name: string }, ['name']],
  stop_agent: ['chairman 停止指定成员，不删除其已保存的能力。', { name: string }, ['name']],
  set_final_output: ['固定模式下记录最终交付物，随后调用 terminate。', { output: string }, ['output']],
  terminate: ['固定模式下提交结果后结束任务。', { reason: string }, []],
  finalize_task: ['演化模式下提交真实结果，等待外部反馈后进入反思。', { output: string }, ['output']],
  update_prompt_patch: ['L1：查看、追加或替换自己的行为补丁；避免记录题目答案。', { action: { type: 'string', enum: ['view', 'add', 'replace_all'] }, patch: string, patches: array }, ['action']],
  update_skill: ['L1：保存自己的可复用 skill。完成后调用 skip_l1_reflection。', { skill_name: string, content: string }, ['skill_name', 'content']],
  skip_l1_reflection: ['结束本成员的 L1，无论是否有修改；全部成员结束后推进阶段。', { reason: string }, ['reason']],
  update_teammate_profile: ['L2：记录伙伴的可观察能力与配合方式，profile 为 YAML 文本。', { teammate_name: string, profile: string }, ['teammate_name', 'profile']],
  update_correlation: ['L2：替换与伙伴的协作记录，保留仍有效的旧经验。', { partner_name: string, suggestion: string }, ['partner_name', 'suggestion']],
  skip_l2_reflection: ['结束本成员 L2，等待其他成员完成。', { reason: string }, ['reason']],
  propose_reflection: ['L3：提交完整团队文件的新内容。新成员需 config.yaml 与 prompt.md；删除用 config.yaml 的 __REMOVE__。', { target_file: string, content: string, reason: string }, ['target_file', 'content', 'reason']],
  view_reflection: ['查看暂存的团队修改和成员建议。', {}, []],
  view_current_config: ['查看允许修改的团队规则或成员配置。', { target_file: string }, ['target_file']],
  suggest_team_improvement: ['L3：向 chairman 提供有执行证据的分工、流程或团队规则建议。', { category: string, description: string, evidence: string, action: string, agent_name: string, team: string, role: string, expertise: string }, ['category', 'description', 'evidence']],
  apply_reflection: ['chairman 用 confirmation=apply 采用 L3 修改，提交新快照。', { confirmation: string }, ['confirmation']],
  skip_reflection: ['chairman 不修改团队结构，结束 L3 并保存已产生的 L1/L2 更新。', { reason: string }, ['reason']],
  skip_l3_reflection: ['普通成员完成 L3 建议；chairman 可决定最终结构更新。', { reason: string }, ['reason']],
  send_message: ['向当前团队的其他活跃成员发送内容。', { to: array, content: string }, ['to', 'content']],
  read_messages: ['读取发给自己的消息；默认只读未读内容，并标记为已读。', { sender: string, unread_only: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 1000 } }, []],
  wait_for_replies: ['在短暂、有取消支持的等待内检查回复，之后用 read_messages 读取。', { from_agents: array, reason: string }, ['reason']],
  check_agent_status: ['查看当前任务中的成员和阶段状态。', { agent_name: string }, []],
}
const schemas = Object.fromEntries(Object.entries(definitions).map(([name, [description, properties, required]]) => [name, {
  name, description, parameters: { type: 'object', properties, required },
}]))
const prompts = {
  overview: '按 L1 成员、L2 交互、L3 团队三个阶段复盘。基于真实执行证据，不伪造测试或评分。保存能帮助未来任务的规则，而非当前题目答案。',
  l1_agent: '现在是 L1。结合自己的执行和外部结果，识别可改进的观察、验证、工具使用和输出行为。可向相关伙伴询问证据。用 update_prompt_patch 或 update_skill 保存本地经验，完成后调用 skip_l1_reflection；无需修改也要声明完成。',
  l1_forced: '执行未正常完成。先区分中止原因与可证实的行为问题；不要把缺少证据当成错误根因。若仍有有效经验，可保存本地修改，否则明确跳过。',
  l2_communication: '现在是 L2。只复盘实际发生的消息交接，确认自己的输出怎样被伙伴使用。必要时向伙伴核对，记录长期有效的伙伴画像或成对协作说明。用 update_teammate_profile、update_correlation 保存，完成后调用 skip_l2_reflection。',
  l3_suggest: '现在是 L3。根据本次执行和前两阶段发现，提出有证据的角色、分工或共享规则建议。用 suggest_team_improvement 提交；无需更多建议时 skip_l3_reflection。不要直接编辑其他成员的文件。',
  l3_structure: '现在是 L3。chairman 查看成员建议，判断团队规则、角色或组织是否需要变化。先 view_current_config，再用 propose_reflection 暂存完整文件。新角色需要配置和角色指令配套；不能删除当前 chairman。需采用时 apply_reflection，无需结构更新时 skip_reflection。普通成员提交建议并完成本阶段。',
}
const target = resolve(root, 'plugins/meta-team/resources/upstream.json')
mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, JSON.stringify({
  upstream_commit: '36dc85d9dc2219d292fa180f347479738a84acb2',
  resource_origin: 'Project-authored descriptions and prompts; tool vocabulary informed by Meta-Team.',
  schemas, prompts,
}, null, 2) + '\n')
console.log(`Built ${Object.keys(schemas).length} project-authored tool schemas and ${Object.keys(prompts).length} prompts`)

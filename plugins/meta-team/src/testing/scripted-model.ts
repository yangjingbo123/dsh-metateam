/** Test-only provider: deterministic tool calls, no HTTP or model inference. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'

export const name = 'meta-team-scripted-test-model'
export const inject = ['llm']

type Call = [string, Record<string, unknown>]
const scripts: Record<string, Record<string, Call[]>> = {
  chairman: {
    execution: [
      ['start_agent', { name: 'worker' }],
      ['send_message', { to: ['worker'], content: 'Check the evidence.' }],
      ['wait_for_replies', { from_agents: ['worker'], reason: 'Need evidence' }],
      ['finalize_task', { output: 'Scripted answer with evidence.' }],
    ],
    l1: [
      ['update_prompt_patch', { action: 'add', patch: 'Attach source identifiers to conclusions.' }],
      ['skip_l1_reflection', { reason: 'Patch written' }],
    ],
    l2: [
      ['update_teammate_profile', { teammate_name: 'worker', profile: 'strengths: [verification]' }],
      ['skip_l2_reflection', { reason: 'Profile recorded' }],
    ],
    l3: [
      ['propose_reflection', { target_file: 'constitution.md', content: 'Verify citations before handing off conclusions.', reason: 'Downstream evidence requirements' }],
      ['apply_reflection', { confirmation: 'apply' }],
    ],
  },
  worker: {
    execution: [['send_message', { to: ['chairman'], content: 'Evidence checked.' }]],
    l1: [
      ['update_skill', { skill_name: 'verify-evidence', content: '---\nname: verify-evidence\ndescription: inspect sources\n---\nCheck source identifiers.' }],
      ['skip_l1_reflection', { reason: 'Skill recorded' }],
    ],
    l2: [
      ['update_correlation', { partner_name: 'chairman', suggestion: 'Include source identifiers when delegating verification.' }],
      ['skip_l2_reflection', { reason: 'Note recorded' }],
    ],
    l3: [
      ['suggest_team_improvement', { category: 'constitution', description: 'Verify citations', evidence: 'Shared evidence requirements' }],
      ['skip_l3_reflection', { reason: 'Suggestion submitted' }],
    ],
  },
}

class ScriptedAdapter extends LlmAdapter {
  private readonly counts = new Map<string, number>()
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    const all = JSON.stringify(options.messages)
    const role = all.includes('You are worker.') ? 'worker' : 'chairman'
    const matches = [...all.matchAll(/Current phase: ([a-z0-9-]+)/g)]
    const phase = matches.at(-1)?.[1] ?? 'execution'
    const key = `${role}:${phase}`
    const index = this.counts.get(key) ?? 0
    this.counts.set(key, index + 1)
    const entry = scripts[role]?.[phase]?.[index]
    if (entry) {
      const [name, args] = entry
      if (!options.tools?.some(tool => tool.name === name)) throw new Error(`Scripted ${role}/${phase} requested unavailable tool ${name}`)
      const id = brandString<ToolCallId>(`scripted-${role}-${phase}-${index}`)
      const argumentsText = JSON.stringify(args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsText }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsText } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Waiting for the next phase.' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Waiting for the next phase.' } }
    }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['meta-scripted'], new ScriptedAdapter())
}

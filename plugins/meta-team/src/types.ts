/** Persisted research state. DSH Session history remains owned by DSH. */
export type Phase = 'execution' | 'awaiting-feedback' | 'l1' | 'l2' | 'l3' | 'complete' | 'aborted'
export type Mode = 'fixed' | 'local' | 'collaborative'
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export interface Role {
  name: string
  directory: string
  prompt: string
  model: string
  tools: string[]
  maxTokens: number
  maxSteps: number
  temperature: number
}
export interface Pool {
  chairman: string
  roles: Record<string, Role>
  constitution: string
}
export interface Message {
  id: string
  sender: string
  receiver: string
  content: string
  read: boolean
  phase: Phase
}
export interface Proposal { content: string; reason: string; author: string }
export interface Episode {
  format: 1
  id: string
  version: string
  task: string
  mode: Mode
  phase: Phase
  phaseStartedAt: number
  active: string[]
  completed: string[]
  sessions: Record<string, string>
  output: string
  feedback: Json | null
  messages: Message[]
  proposals: Record<string, Proposal>
  suggestions: Json[]
  deadline: number
  costUsd: number
  tokens: number
}
export interface Options {
  poolDir: string
  stateDir: string
  workspace: string
  mode: Mode
  phaseTimeoutMs: number
  executionTimeoutMs: number
  maxMessages: number
  maxCostUsd: number
  model?: string
}
export interface Transport {
  start(role: Role, sessionId: string): Promise<void>
  deliver(name: string, content: string, wake: boolean): void
  stop(name: string): void
  close(): Promise<void>
}
export interface ToolSchema { name: string; description: string; parameters: Json }

/** Reject prototype-bearing argument containers and require a JSON object. */
export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object')
  return value as Record<string, unknown>
}
export function text(value: unknown, label: string, optional = false): string {
  if (optional && value === undefined) return ''
  if (typeof value !== 'string' || (!optional && !value.trim())) throw new Error(`${label} must be nonempty text`)
  if (value.length > 200_000) throw new Error(`${label} exceeds the configured text limit`)
  return value
}
export function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(x => typeof x !== 'string')) throw new Error(`${label} must be a string array`)
  return value as string[]
}
export function identifier(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(value)) throw new Error(`Invalid identifier: ${value}`)
  return value
}

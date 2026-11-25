import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MetaTeamEngine } from '../src/engine.ts'
import { safePath } from '../src/store.ts'
import type { Mode, Transport } from '../src/types.ts'

function fixture(mode: Mode = 'collaborative') {
  const root = mkdtempSync(join(tmpdir(), 'meta-team-test-'))
  const pool = join(root, 'pool'); mkdirSync(pool)
  writeFileSync(join(pool, 'pool.yaml'), 'chairman: chairman\n')
  writeFileSync(join(pool, 'constitution.md'), 'Use evidence.\n')
  for (const name of ['chairman', 'worker']) {
    mkdirSync(join(pool, name))
    writeFileSync(join(pool, name, 'config.yaml'), `name: ${name}\nmodel: test\ntools: []\n`)
    writeFileSync(join(pool, name, 'prompt.md'), `Role ${name}`)
  }
  const delivery: { name: string; content: string }[] = []
  const stopped: string[] = []
  const transport: Transport = {
    async start() {}, deliver(name, content) { delivery.push({ name, content }) },
    stop(name) { stopped.push(name) }, async close() {},
  }
  const opts = { poolDir: pool, stateDir: join(root, 'state'), workspace: root, mode, phaseTimeoutMs: 10000, executionTimeoutMs: 60000, maxMessages: 10, maxCostUsd: 1 }
  const engine = new MetaTeamEngine(opts, transport, {})
  const call = (actor: string, tool: string, args: unknown = {}) => engine.call(actor, tool, args, new AbortController().signal)
  return { root, pool, engine, call, delivery, stopped, cleanup: async () => { await engine.close(); rmSync(root, { recursive: true, force: true }) } }
}

test('execution → external feedback → L1/L2/L3 → immutable snapshot and freeze', async () => {
  const f = fixture()
  try {
    await f.engine.begin('run1', 'Find evidence', 'session-root')
    await f.call('chairman', 'start_agent', { name: 'worker' })
    await f.call('chairman', 'send_message', { to: ['worker'], content: 'Check source.' })
    await f.call('worker', 'send_message', { to: ['chairman'], content: 'Found source.' })
    await f.call('chairman', 'finalize_task', { output: 'Answer' })
    assert.equal(f.engine.episode?.phase, 'awaiting-feedback')
    assert.throws(() => f.engine.feedback(undefined as never)) // invalid values rejected on persistence
    f.engine.feedback({ success: false, summary: 'Missing citation' })
    await f.call('worker', 'update_prompt_patch', { action: 'add', patch: 'Attach evidence to claims.' })
    await f.call('worker', 'update_skill', { skill_name: 'verify', content: '---\nname: verify\ndescription: verify evidence\n---\nInspect sources.' })
    assert.match(await f.call('worker', 'use_skill', { skill_name: 'verify' }), /Inspect sources/)
    await f.call('worker', 'skip_l1_reflection', { reason: 'Done' })
    assert.equal(f.engine.episode?.phase, 'l1')
    await f.call('chairman', 'skip_l1_reflection', { reason: 'Done' })
    assert.equal(f.engine.episode?.phase, 'l2')
    await f.call('chairman', 'update_teammate_profile', { teammate_name: 'worker', profile: 'strengths: [checking]' })
    await f.call('worker', 'update_correlation', { partner_name: 'chairman', suggestion: 'Include source ids.' })
    await f.call('worker', 'skip_l2_reflection', { reason: 'Done' })
    await f.call('chairman', 'skip_l2_reflection', { reason: 'Done' })
    assert.equal(f.engine.episode?.phase, 'l3')
    await f.call('worker', 'suggest_team_improvement', { category: 'constitution', description: 'Cite sources', evidence: 'Missing citation' })
    await f.call('chairman', 'propose_reflection', { target_file: 'constitution.md', content: 'Cite all sources.', reason: 'Evidence gap' })
    await f.call('chairman', 'apply_reflection', { confirmation: 'apply' })
    assert.equal(f.engine.episode?.phase, 'complete')
    assert.equal(f.engine.store.head(), 'v000001')
    assert.equal(readFileSync(join(f.engine.store.snapshot('v000000'), 'constitution.md'), 'utf8'), 'Use evidence.\n')
    const frozen = join(f.root, 'export')
    f.engine.store.freeze('v000001', frozen)
    assert.equal(readFileSync(join(frozen, 'constitution.md'), 'utf8'), 'Cite all sources.')
    assert.equal(readFileSync(join(f.pool, 'constitution.md'), 'utf8'), 'Use evidence.\n')
    await f.engine.begin('run2', 'New task', 'new-session')
    assert.match(f.engine.context('worker'), /Attach evidence/)
    assert.equal(f.engine.episode?.version, 'v000001')
  } finally { await f.cleanup() }
})

test('fixed mode does not persist a new harness snapshot', async () => {
  const f = fixture('fixed')
  try {
    await f.engine.begin('fixed1', 'Task', 'root')
    assert.equal(f.engine.canCall('chairman', 'finalize_task'), false)
    await f.call('chairman', 'set_final_output', { output: 'Answer' })
    await f.call('chairman', 'terminate')
    assert.equal(f.engine.episode?.phase, 'complete')
    assert.equal(f.engine.store.head(), 'v000000')
  } finally { await f.cleanup() }
})

test('local mode ends after L1 and does not expose reflection messaging', async () => {
  const f = fixture('local')
  try {
    await f.engine.begin('local1', 'Task', 'root')
    await f.call('chairman', 'finalize_task', { output: 'Answer' })
    f.engine.feedback({ success: true })
    assert.equal(f.engine.canCall('chairman', 'send_message'), false)
    await f.call('chairman', 'skip_l1_reflection', { reason: 'Done' })
    assert.equal(f.engine.episode?.phase, 'complete')
  } finally { await f.cleanup() }
})

test('phase and chairman permissions are enforced at execution, not only discovery', async () => {
  const f = fixture()
  try {
    await f.engine.begin('auth', 'Task', 'root')
    await f.call('chairman', 'start_agent', { name: 'worker' })
    await assert.rejects(f.call('worker', 'finalize_task', { output: 'Forged' }), /unavailable/)
    await assert.rejects(f.call('worker', 'update_skill', { skill_name: 'x', content: 'x' }), /unavailable/)
    await assert.rejects(f.call('worker', 'send_message', { to: ['unknown'], content: 'x' }), /Recipients/)
    assert.throws(() => f.engine.feedback({ success: true }), /after finalization/)
  } finally { await f.cleanup() }
})

test('artifact paths reject traversal and symlinks', async () => {
  const f = fixture()
  try {
    assert.throws(() => safePath(f.root, '../outside'), /Unsafe/)
    symlinkSync(f.pool, join(f.root, 'link'))
    assert.throws(() => safePath(f.root, 'link/prompt.md'), /Symlinks/)
    await f.engine.begin('paths', 'Task', 'root')
    await f.call('chairman', 'finalize_task', { output: 'Answer' }); f.engine.feedback({ success: false })
    await assert.rejects(f.call('chairman', 'update_skill', { skill_name: '../x', content: 'x' }), /Invalid identifier/)
    assert.equal(existsSync(join(f.root, 'x')), false)
  } finally { await f.cleanup() }
})

test('timeouts abort without publishing candidates', async () => {
  const f = fixture()
  try {
    await f.engine.begin('timed', 'Task', 'root')
    f.engine.tick(Date.now() + 70000)
    assert.equal(f.engine.episode?.phase, 'aborted')
    assert.equal(f.engine.store.head(), 'v000000')
    assert.deepEqual(f.stopped, ['chairman'])
  } finally { await f.cleanup() }
})

test('bounded reply waiting is cancelled and listeners are cleaned', async () => {
  const f = fixture()
  try {
    await f.engine.begin('wait', 'Task', 'root')
    const abort = new AbortController()
    const wait = f.engine.wait('chairman', [], abort.signal, 2000)
    abort.abort(new Error('cancel wait'))
    await assert.rejects(wait, /cancel wait/)
  } finally { await f.cleanup() }
})

test('L3 can add a complete candidate role; incomplete role never publishes', async () => {
  const f = fixture()
  try {
    await f.engine.begin('roles', 'Task', 'root')
    await f.call('chairman', 'finalize_task', { output: 'Answer' }); f.engine.feedback({ success: false })
    await f.call('chairman', 'skip_l1_reflection', { reason: 'Done' })
    assert.equal(f.engine.episode?.phase, 'l3') // no actual interacting pairs
    await f.call('chairman', 'propose_reflection', { target_file: 'tester/config.yaml', content: 'name: tester\nmodel: test\ntools: []', reason: 'Need tests' })
    await assert.rejects(f.call('chairman', 'apply_reflection', { confirmation: 'apply' }), /requires/)
    assert.equal(f.engine.store.head(), 'v000000')
    await f.call('chairman', 'propose_reflection', { target_file: 'tester/prompt.md', content: 'Verify outputs.', reason: 'Need tests' })
    await f.call('chairman', 'apply_reflection', { confirmation: 'apply' })
    await f.engine.begin('roles2', 'Task', 'root2')
    assert.equal(f.engine.pool.roles.tester.name, 'tester')
  } finally { await f.cleanup() }
})

test('unsettled persisted episode blocks implicit restart', async () => {
  const f = fixture()
  try {
    await f.engine.begin('unfinished', 'Task', 'root')
    assert.throws(() => new MetaTeamEngine(f.engine.options, f.engine.transport, {}), /Interrupted episode|writer lock/)
  } finally { await f.cleanup() }
})

test('cost budget aborts and snapshots cannot overwrite', async () => {
  const f = fixture()
  try {
    await f.engine.begin('budget', 'Task', 'root')
    f.engine.usage(1, 10)
    assert.equal(f.engine.episode?.phase, 'aborted')
    assert.equal(f.engine.store.head(), 'v000000')
    assert.throws(() => f.engine.store.freeze('v000000', f.pool), /must not exist/)
  } finally { await f.cleanup() }
})

test('message budget aborts instead of silently dropping delivery', async () => {
  const f = fixture()
  try {
    await f.engine.begin('messages', 'Task', 'root')
    await f.call('chairman', 'start_agent', { name: 'worker' })
    for (let index = 0; index < 10; index++) await f.call('chairman', 'send_message', { to: ['worker'], content: `message ${index}` })
    await assert.rejects(f.call('chairman', 'send_message', { to: ['worker'], content: 'too many' }), /budget/)
    assert.equal(f.engine.episode?.phase, 'aborted')
    assert.equal(f.engine.episode?.messages.length, 10)
  } finally { await f.cleanup() }
})

test('stopped roles can be recruited again under a fresh Session identity', async () => {
  const f = fixture()
  try {
    await f.engine.begin('recruit', 'Task', 'root')
    await f.call('chairman', 'start_agent', { name: 'worker' })
    const initial = f.engine.episode?.sessions.worker
    await f.call('chairman', 'stop_agent', { name: 'worker' })
    await f.call('chairman', 'start_agent', { name: 'worker' })
    assert.notEqual(f.engine.episode?.sessions.worker, initial)
  } finally { await f.cleanup() }
})

test('L3 removes an optional role without editing the initial pool', async () => {
  const f = fixture()
  try {
    await f.engine.begin('remove', 'Task', 'root')
    await f.call('chairman', 'finalize_task', { output: 'Answer' }); f.engine.feedback({ success: false })
    await f.call('chairman', 'skip_l1_reflection', { reason: 'Done' })
    await f.call('chairman', 'propose_reflection', { target_file: 'chairman/config.yaml', content: '__REMOVE__', reason: 'Bad request' })
    await assert.rejects(f.call('chairman', 'apply_reflection', { confirmation: 'apply' }), /chairman/)
    await f.call('chairman', 'propose_reflection', { target_file: 'chairman/config.yaml', content: 'name: chairman\nmodel: test\ntools: []', reason: 'Preserve owner' })
    await f.call('chairman', 'propose_reflection', { target_file: 'worker/config.yaml', content: '__REMOVE__', reason: 'Unused role' })
    await f.call('chairman', 'apply_reflection', { confirmation: 'apply' })
    await f.engine.begin('removed2', 'Task', 'root2')
    assert.equal(Object.hasOwn(f.engine.pool.roles, 'worker'), false)
    assert.equal(existsSync(join(f.pool, 'worker/config.yaml')), true)
  } finally { await f.cleanup() }
})

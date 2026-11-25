import { brandString } from '@deepseek-ai/dsh-brand';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MetaTeamEngine } from "./engine.js";
import { startControl } from "./control.js";
import { identifier, object, text } from "./types.js";
export const name = 'meta-team';
export const inject = ['agents', 'tools', 'systemPrompt', 'commands'];
/** Substitute only the generated upstream example name lists, not task evidence. */
function schemasFor(resources, names) {
    const serialized = JSON.stringify(resources.schemas)
        .replaceAll('chairman, worker', names.join(', '))
        .replaceAll('["chairman","worker"]', JSON.stringify(names));
    const schemas = Object.values(JSON.parse(serialized));
    schemas.push({ name: 'use_skill', description: 'Load the full content of one of your local skills.', parameters: { type: 'object', properties: { skill_name: { type: 'string' } }, required: ['skill_name'] } });
    return schemas;
}
/** Mount one team coordinator plus agent-local prompt/tool contributions. */
export async function apply(ctx, config) {
    for (const key of ['poolDir', 'stateDir', 'workspace']) {
        if (typeof config?.[key] !== 'string' || !config[key].trim())
            throw new Error(`Meta-Team 配置缺少 ${key}；请配置该路径后再启用插件。`);
    }
    try {
        await mount(ctx, config);
    }
    catch (error) {
        if (existsSync(config.stateDir))
            writeFileSync(resolve(config.stateDir, 'plugin-startup-error.json'), JSON.stringify({ error: error instanceof Error ? error.stack : String(error) }));
        throw error;
    }
}
async function mount(ctx, config) {
    const directory = dirname(fileURLToPath(import.meta.url));
    const resourcePath = config.resources ?? [resolve(directory, '../resources/upstream.json'), resolve(directory, '../plugins/meta-team/resources/upstream.json')].find(existsSync);
    if (!resourcePath)
        throw new Error('Generate upstream resources and provide their explicit path');
    const resources = JSON.parse(readFileSync(resourcePath, 'utf8'));
    const inputRate = config.inputUsdPerMillion ?? 0;
    const outputRate = config.outputUsdPerMillion ?? 0;
    if ((config.maxCostUsd ?? 0) > 0 && inputRate === 0 && outputRate === 0)
        throw new Error('A dollar budget requires explicit estimate rates');
    if (![inputRate, outputRate].every(n => Number.isFinite(n) && n >= 0))
        throw new Error('Invalid token prices');
    const handles = new Map();
    const members = new Map();
    const roleNames = new Map();
    let engine;
    const message = (content) => createUserMessage({ content: [{ type: 'text', text: content }], source: { kind: 'user' } });
    const transport = {
        async start(role, sessionId) {
            const prior = handles.get(role.name);
            if (prior) {
                const id = String(prior.agent.id);
                await prior.dispose();
                for (const dispose of (mounted.get(id) ?? []).reverse())
                    dispose();
                mounted.delete(id);
                roleNames.delete(id);
                handles.delete(role.name);
                members.delete(role.name);
            }
            const provider = config.provider ?? members.get(engine.pool.chairman)?.model.current()?.provider;
            if (!provider)
                throw new Error('Member requires an explicit or inherited model provider');
            const handle = await ctx.agents.create({
                sessionId: brandString(sessionId),
                meta: { cwd: resolve(config.workspace) },
                agentOptions: { provider, model: config.model ?? role.model, maxTokens: role.maxTokens },
                setup: scoped => { install(scoped, role.name, sessionId); },
            });
            handles.set(role.name, handle);
            members.set(role.name, handle.agent);
        },
        deliver(role, content, wake) {
            const agent = members.get(role);
            if (!agent)
                throw new Error(`Missing live member ${role}`);
            if (wake)
                agent.followup(message(content));
            else
                agent.inject(message(content));
        },
        stop(role) { members.get(role)?.cancel({ kind: 'user' }); },
        async close() {
            for (const handle of handles.values())
                await handle.dispose();
            handles.clear();
            members.clear();
            roleNames.clear();
        },
    };
    engine = new MetaTeamEngine({
        poolDir: resolve(config.poolDir), stateDir: resolve(config.stateDir), workspace: resolve(config.workspace),
        mode: config.mode ?? 'collaborative', phaseTimeoutMs: config.phaseTimeoutMs ?? 120_000,
        executionTimeoutMs: config.executionTimeoutMs ?? 600_000, maxMessages: config.maxMessages ?? 600,
        maxCostUsd: config.maxCostUsd ?? 0, ...(config.model ? { model: config.model } : {}),
    }, transport, resources.prompts);
    const environmentMap = { read_file: 'read', write_file: 'write', bash: 'bash', ...config.environmentTools };
    const mounted = new Map();
    function install(scoped, roleName, sessionId) {
        if (mounted.has(sessionId))
            throw new Error('Session has already been mounted');
        const role = engine.role(roleName);
        const cleanup = [];
        // Never silently map docker_bash to host bash: the environment changes.
        const environment = role.tools.map(tool => {
            const target = environmentMap[tool];
            if (!target || !ctx.tools.get(target))
                throw new Error(`Upstream environment tool ${tool} has no installed DSH binding; configure an equivalent backend explicitly`);
            return target;
        });
        try {
            cleanup.push(scoped.tools.restrict({ allow: [...new Set(environment)] }));
            cleanup.push(scoped.systemPrompt.section({
                name: 'meta-team:role', order: 0, complete: true, interpolate: false,
                text: () => engine.context(roleName),
            }));
            let stepPhase = '';
            let stepCount = 0;
            cleanup.push(scoped.on('agent/pre-step', async ({ agent }, next) => {
                if (String(agent.id) !== sessionId)
                    return next();
                const phase = engine.episode?.phase ?? '';
                if (['complete', 'aborted', 'awaiting-feedback'].includes(phase) || engine.episode?.completed.includes(roleName))
                    return { kind: 'reject' };
                if (stepPhase !== phase) {
                    stepPhase = phase;
                    stepCount = 0;
                }
                if (++stepCount > role.maxSteps) {
                    engine.abort(`step limit for ${roleName}`);
                    return { kind: 'reject' };
                }
                return next();
            }));
            cleanup.push(scoped.on('agent/request', async (_payload, next) => ({ ...await next(), temperature: role.temperature })));
            for (const schema of schemasFor(resources, Object.keys(engine.pool.roles))) {
                const definition = {
                    name: schema.name, description: schema.description,
                    parameters: schema.parameters,
                    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
                    async execute(args, exec) {
                        if (String(exec.agent?.id) !== sessionId)
                            throw new Error('Member Session does not match tool caller');
                        const result = await engine.call(roleName, schema.name, args, exec.signal);
                        const phase = engine.episode?.phase;
                        if (['finalize_task', 'terminate', 'apply_reflection', 'skip_reflection', 'skip_l1_reflection', 'skip_l2_reflection', 'skip_l3_reflection'].includes(schema.name))
                            exec.concludeTurn();
                        if (phase === 'awaiting-feedback' || phase === 'complete' || phase === 'aborted') {
                            for (const [name, agent] of members)
                                if (name !== roleName)
                                    agent.cancel({ kind: 'user' });
                        }
                        return result;
                    },
                };
                cleanup.push(scoped.tools.register(definition, { when: () => engine.canCall(roleName, schema.name) }));
            }
            roleNames.set(sessionId, roleName);
            mounted.set(sessionId, cleanup);
        }
        catch (error) {
            for (const dispose of cleanup.reverse())
                dispose();
            throw error;
        }
    }
    // A trusted SDK/human command feeds external evaluator results. Model tools
    // cannot forge verdicts, choose arbitrary state paths, or freeze themselves.
    ctx.commands.register({
        name: 'meta', description: 'Control the external Meta-Team experiment plugin.',
        input: { hint: 'status | begin <JSON> | inspect | feedback <JSON> | abort <reason> | freeze <JSON>' },
        async handler(invocation) {
            try {
                invocation.signal.throwIfAborted();
                const raw = invocation.rawInput.trim();
                const space = raw.indexOf(' ');
                const operation = space < 0 ? raw : raw.slice(0, space);
                const payload = space < 0 ? '' : raw.slice(space + 1).trim();
                if (operation === 'status')
                    return { kind: 'success', text: JSON.stringify(engine.status()) };
                if (operation === 'begin') {
                    const args = object(JSON.parse(payload));
                    const id = identifier(text(args.id, 'id'));
                    const task = text(args.task, 'task');
                    if (engine.episode && !['complete', 'aborted'].includes(engine.episode.phase))
                        throw new Error('Active episode must finish first');
                    // Dispose every old scope registration, including on the reused root.
                    for (const cleanup of mounted.values())
                        for (const dispose of cleanup.reverse())
                            dispose();
                    mounted.clear();
                    await transport.close();
                    await engine.begin(id, task, String(invocation.agent.id));
                    members.set(engine.pool.chairman, invocation.agent);
                    try {
                        install(invocation.agent.ctx, engine.pool.chairman, String(invocation.agent.id));
                    }
                    catch (error) {
                        engine.abort('Failed to mount member capabilities');
                        throw error;
                    }
                    if (config.model) {
                        const provider = config.provider ?? invocation.agent.model.current()?.provider;
                        if (!provider)
                            throw new Error('Configure provider for the migrated model');
                        invocation.agent.model.select({ provider, model: config.model });
                    }
                    return { kind: 'success', text: JSON.stringify({ id, chairman: engine.pool.chairman, phase: 'execution', task }) };
                }
                // Control commands require the exact episode owner, not merely a role name.
                if (String(invocation.agent.id) !== engine.episode?.sessions[engine.pool.chairman])
                    throw new Error('Only the episode owner may control feedback or snapshots');
                if (operation === 'inspect') {
                    const selection = invocation.agent.model.current();
                    if (!selection)
                        throw new Error('Session has no configured model selection');
                    const set = await invocation.agent.ctx.tools.resolve({ agent: invocation.agent, modelSelection: selection, signal: invocation.signal });
                    try {
                        return { kind: 'success', text: JSON.stringify({ role: engine.pool.chairman, tools: [...set.view(invocation.agent).keys()], context: engine.context(engine.pool.chairman) }) };
                    }
                    finally {
                        set.dispose();
                    }
                }
                if (operation === 'feedback')
                    engine.feedback(JSON.parse(payload));
                else if (operation === 'abort')
                    engine.abort(text(payload, 'reason'));
                else if (operation === 'freeze') {
                    if (!engine.episode || !['complete', 'aborted'].includes(engine.episode.phase))
                        throw new Error('Freeze only after episode settlement');
                    const args = object(JSON.parse(payload));
                    const destination = resolve(config.stateDir, 'exports', identifier(text(args.name, 'name')));
                    engine.store.freeze(args.version === undefined ? engine.store.head() : text(args.version, 'version'), destination);
                    return { kind: 'success', text: JSON.stringify({ destination }) };
                }
                else
                    throw new Error('Unknown /meta operation');
                return { kind: 'success', text: JSON.stringify(engine.status()) };
            }
            catch (error) {
                return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
            }
        },
    });
    ctx.on('session/event', (session, event) => {
        const role = roleNames.get(String(session.id));
        if (!role || !engine.episode)
            return;
        // Keep raw trace separate from model-visible feedback. Never feed all logs
        // into every agent; individual DSH Session history remains authoritative.
        if (['tool/call', 'tool/result', 'assistant/message', 'user/message', 'turn/end', 'step/end'].includes(event.type))
            engine.store.audit(engine.episode.id, 'session-event', { role, event });
        if (event.type === 'assistant/message' && event.data.usage) {
            const u = event.data.usage;
            const input = u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
            engine.usage((input * inputRate + u.outputTokens * outputRate) / 1_000_000, input + u.outputTokens);
        }
    });
    ctx.effect(() => {
        const timer = setInterval(() => engine.tick(), 250);
        return async () => {
            clearInterval(timer);
            for (const cleanup of mounted.values())
                for (const dispose of cleanup.reverse())
                    dispose();
            mounted.clear();
            await engine.close();
        };
    });
    if (config.controlSocket) {
        if (!config.controlToken)
            throw new Error('controlToken is required with controlSocket');
        const dispose = await startControl(resolve(config.controlSocket), config.controlToken, async (request, signal) => {
            const agent = ctx.agents.get(brandString(request.sessionId));
            if (!agent)
                throw new Error('Create the Session through SDK before issuing control commands');
            const result = await ctx.commands.execute(agent, request.command, [], signal);
            if (!result)
                throw new Error('Meta-Team command not registered');
            return result.result;
        });
        ctx.effect(() => dispose);
    }
}

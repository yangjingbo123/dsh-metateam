/** Runtime-independent Meta-Team state machine; adapters own model execution. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { randomUUID } from 'node:crypto';
import { Store, readPool, safePath } from "./store.js";
import { identifier, object, strings, text } from "./types.js";
const PHASE_TOOLS = {
    execution: ['list_pool', 'start_agent', 'stop_agent', 'finalize_task', 'set_final_output', 'terminate'],
    l1: ['update_prompt_patch', 'update_skill', 'skip_l1_reflection'],
    l2: ['update_teammate_profile', 'update_correlation', 'skip_l2_reflection'],
    l3: ['propose_reflection', 'view_reflection', 'view_current_config', 'suggest_team_improvement', 'apply_reflection', 'skip_reflection', 'skip_l3_reflection'],
};
const COMMON = ['send_message', 'read_messages', 'wait_for_replies', 'check_agent_status', 'use_skill'];
const CHAIRMAN_ONLY = new Set(['start_agent', 'stop_agent', 'finalize_task', 'set_final_output', 'terminate', 'apply_reflection', 'skip_reflection']);
const TERMINAL = new Set(['complete', 'aborted']);
export class MetaTeamEngine {
    store;
    episode;
    pool;
    listeners = new Set();
    busy = false;
    closing = false;
    options;
    transport;
    prompts;
    constructor(options, transport, prompts) {
        this.options = options;
        this.transport = transport;
        this.prompts = prompts;
        for (const key of ['phaseTimeoutMs', 'executionTimeoutMs', 'maxMessages', 'maxCostUsd']) {
            if (!Number.isFinite(options[key]) || options[key] < 0)
                throw new Error(`Invalid ${key}`);
        }
        this.store = new Store(options.stateDir, options.poolDir);
        // Do not silently resume an episode whose DSH processes/history were lost.
        const episodes = join(this.store.root, 'episodes');
        try {
            this.pool = readPool(this.store.snapshot(this.store.head()), options.model);
            if (existsSync(episodes))
                for (const entry of readdirSync(episodes)) {
                    const state = safePath(episodes, `${identifier(entry)}/state.json`);
                    if (existsSync(state)) {
                        const old = object(JSON.parse(readFileSync(state, 'utf8')));
                        if (!TERMINAL.has(old.phase))
                            throw new Error(`Interrupted episode ${entry}; explicitly archive/recover it before starting this plugin`);
                    }
                }
        }
        catch (error) {
            this.store.release();
            throw error;
        }
    }
    status() {
        return this.episode ? JSON.parse(JSON.stringify(this.episode)) : { head: this.store.head(), phase: 'not-started' };
    }
    current() {
        if (!this.episode)
            throw new Error('No active episode');
        return this.episode;
    }
    save(event, data = {}) {
        const e = this.current();
        this.store.save(e);
        this.store.audit(e.id, event, data);
        for (const notify of this.listeners)
            notify();
    }
    phase(phase) {
        const e = this.current();
        e.phase = phase;
        e.completed = [];
        e.phaseStartedAt = Date.now();
        this.save('phase', { phase });
        if (['l1', 'l2', 'l3'].includes(phase)) {
            const key = phase === 'l1' ? 'l1_agent' : phase === 'l2' ? 'l2_communication' : 'l3_structure';
            for (const name of e.active) {
                if (phase === 'l2' && this.partners(name).length === 0)
                    e.completed.push(name);
                const context = phase === 'l2' ? `Actual communication partners: ${this.partners(name).join(', ') || '(none)'}` : '';
                const prompt = phase === 'l3' && name !== this.pool.chairman ? this.prompts.l3_suggest : this.prompts[key];
                this.transport.deliver(name, `[PHASE: ${phase.toUpperCase()}]\n${prompt ?? ''}\n${context}\nTask outcome: ${JSON.stringify(e.feedback)}\nFinal deliverable: ${e.output}`, true);
            }
            this.save('phase-notifications');
            if (phase === 'l2')
                this.maybeAdvance();
        }
    }
    async begin(id, task, chairmanSession) {
        if (this.episode && !TERMINAL.has(this.episode.phase))
            throw new Error('An episode is already active');
        if (!existsSync(this.options.workspace))
            throw new Error('Workspace must exist');
        identifier(id);
        text(task, 'task');
        this.store.create(id);
        this.pool = readPool(this.store.working(id), this.options.model);
        const now = Date.now();
        this.episode = {
            format: 1, id, version: this.store.head(), task, mode: this.options.mode, phase: 'execution',
            phaseStartedAt: now, active: [this.pool.chairman], completed: [],
            sessions: { [this.pool.chairman]: text(chairmanSession, 'Session id') }, output: '', feedback: null,
            messages: [], proposals: Object.create(null), suggestions: [],
            deadline: this.options.executionTimeoutMs ? now + this.options.executionTimeoutMs : 0, costUsd: 0, tokens: 0,
        };
        this.save('begin');
    }
    canCall(name, tool) {
        const e = this.episode;
        if (!e || !e.active.includes(name) || TERMINAL.has(e.phase))
            return false;
        if (e.phase === 'awaiting-feedback')
            return tool === 'read_messages' || tool === 'check_agent_status';
        if (e.mode === 'local' && e.phase !== 'execution' && ['send_message', 'read_messages', 'wait_for_replies'].includes(tool))
            return false;
        if (e.completed.includes(name) && tool !== 'read_messages')
            return false;
        if (CHAIRMAN_ONLY.has(tool) && name !== this.pool.chairman)
            return false;
        if (tool === 'finalize_task' && e.mode === 'fixed')
            return false;
        if (tool === 'set_final_output' && e.mode !== 'fixed')
            return false;
        return COMMON.includes(tool) || (PHASE_TOOLS[e.phase] ?? []).includes(tool);
    }
    nameForSession(session) {
        return Object.entries(this.episode?.sessions ?? {}).find(([, id]) => id === session)?.[0];
    }
    bind(name, session) {
        const e = this.current();
        this.role(name);
        if (!e.active.includes(name))
            throw new Error('Cannot bind an inactive member');
        if (Object.values(e.sessions).includes(session) && e.sessions[name] !== session)
            throw new Error('Session already bound to another member');
        e.sessions[name] = session;
        this.save('bind', { name, session });
    }
    role(name) {
        identifier(name);
        if (!Object.hasOwn(this.pool.roles, name))
            throw new Error(`Unknown member: ${name}`);
        return this.pool.roles[name];
    }
    partners(name) {
        const e = this.current();
        return [...new Set(e.messages.filter(m => m.phase === 'execution' && (m.sender === name || m.receiver === name)).map(m => m.sender === name ? m.receiver : m.sender))].filter(p => e.active.includes(p));
    }
    context(name) {
        const role = this.role(name);
        const e = this.current();
        const files = ['evolution/prompt_patches.md', 'evolution/teammate_profiles.yaml'];
        const parts = [role.prompt, this.pool.constitution, `You are ${name}. Chairman: ${this.pool.chairman}. Current phase: ${e.phase}.`];
        for (const file of files)
            parts.push(this.store.read(e.id, `${role.directory}/${file}`));
        const correlations = safePath(this.store.working(e.id), `${role.directory}/evolution/correlations`);
        if (existsSync(correlations))
            for (const file of readdirSync(correlations))
                if (file.endsWith('.md'))
                    parts.push(this.store.read(e.id, `${role.directory}/evolution/correlations/${file}`));
        const skills = safePath(this.store.working(e.id), `${role.directory}/skills`);
        if (existsSync(skills)) {
            const catalog = readdirSync(skills).map(identifier).map(skill => {
                const body = this.store.read(e.id, `${role.directory}/skills/${skill}/SKILL.md`);
                const match = /^---\s*\n([\s\S]*?)\n---/.exec(body);
                const meta = match ? object(load(match[1])) : {};
                return `${skill}: ${String(meta.description ?? '')}`;
            });
            parts.push(`Available skills (call use_skill to load):\n${catalog.join('\n')}`);
        }
        return parts.filter(Boolean).join('\n\n');
    }
    feedback(value) {
        const e = this.current();
        if (e.phase !== 'awaiting-feedback')
            throw new Error('Feedback is only admitted after finalization');
        if (value === undefined || typeof value === 'function')
            throw new Error('Feedback must be JSON');
        JSON.stringify(value); // reject cycles before mutating the episode
        e.feedback = value;
        this.save('feedback', value);
        this.phase('l1');
    }
    maybeAdvance() {
        const e = this.current();
        if (!e.active.every(name => e.completed.includes(name)))
            return;
        if (e.phase === 'l1') {
            if (e.mode === 'local')
                this.complete();
            else
                this.phase('l2');
        }
        else if (e.phase === 'l2')
            this.phase('l3');
        else if (e.phase === 'l3')
            this.complete();
    }
    markDone(name) {
        const e = this.current();
        if (!e.completed.includes(name))
            e.completed.push(name);
        this.save('member-complete', { name, phase: e.phase });
        this.maybeAdvance();
    }
    complete() {
        const e = this.current();
        const head = e.mode === 'fixed' ? e.version : this.store.commit(e.id, e.version);
        this.phase('complete');
        this.store.audit(e.id, 'committed', { version: head });
        // Transport adapters stop other active model loops after the calling tool settles.
    }
    abort(reason) {
        const e = this.current();
        if (TERMINAL.has(e.phase))
            return;
        this.phase('aborted');
        this.store.audit(e.id, 'abort', { reason });
        for (const name of e.active)
            this.transport.stop(name);
    }
    tick(now = Date.now()) {
        const e = this.episode;
        if (!e || TERMINAL.has(e.phase))
            return;
        if (e.deadline && now >= e.deadline) {
            this.abort('episode timeout');
            return;
        }
        if (this.options.phaseTimeoutMs && ['l1', 'l2', 'l3', 'awaiting-feedback'].includes(e.phase) && now - e.phaseStartedAt >= this.options.phaseTimeoutMs)
            this.abort(`phase timeout: ${e.phase}`);
    }
    usage(costUsd, tokens) {
        if (!this.episode || TERMINAL.has(this.episode.phase))
            return;
        if (![costUsd, tokens].every(v => Number.isFinite(v) && v >= 0))
            throw new Error('Invalid usage delta');
        this.episode.costUsd += costUsd;
        this.episode.tokens += tokens;
        this.save('usage', { costUsd, tokens });
        if (this.options.maxCostUsd && this.episode.costUsd >= this.options.maxCostUsd)
            this.abort('cost budget exceeded');
    }
    async wait(name, from, signal, timeoutMs = 1000) {
        const ready = () => this.current().messages.some(m => m.receiver === name && !m.read && (!from.length || from.includes(m.sender)));
        if (!ready())
            await new Promise((resolveWait, rejectWait) => {
                let timer;
                const cleanup = () => { clearTimeout(timer); this.listeners.delete(changed); signal.removeEventListener('abort', aborted); };
                const changed = () => { if (ready() || this.closing) {
                    cleanup();
                    resolveWait();
                } };
                const aborted = () => { cleanup(); rejectWait(signal.reason ?? new Error('Aborted')); };
                this.listeners.add(changed);
                timer = setTimeout(() => { cleanup(); resolveWait(); }, timeoutMs);
                signal.addEventListener('abort', aborted, { once: true });
                if (signal.aborted)
                    aborted();
            });
        return ready() ? 'Requested reply is available; use read_messages.' : 'No matching reply before the bounded wait ended.';
    }
    /** Serialize mutation calls so phase transitions cannot race with multi-tool batches. */
    async call(name, tool, raw, signal) {
        if (!this.canCall(name, tool))
            throw new Error(`${tool} is unavailable for ${name} in ${this.episode?.phase}`);
        const args = object(raw);
        signal.throwIfAborted();
        if (tool === 'wait_for_replies')
            return this.wait(name, args.from_agents === undefined ? [] : strings(args.from_agents, 'from_agents'), signal);
        if (this.busy)
            throw new Error('Concurrent Meta-Team mutation; retry after the current call');
        this.busy = true;
        try {
            return await this.dispatch(name, tool, args, signal);
        }
        finally {
            this.busy = false;
        }
    }
    async dispatch(name, tool, args, signal) {
        const e = this.current();
        const role = this.role(name);
        const local = (file) => `${role.directory}/${file}`;
        switch (tool) {
            case 'list_pool': return JSON.stringify(Object.values(this.pool.roles).map(r => ({ name: r.name, started: e.active.includes(r.name), model: r.model, tools: r.tools })));
            case 'start_agent': {
                const target = text(args.name, 'name');
                const member = this.role(target);
                if (e.active.includes(target))
                    return `${target} is already active.`;
                const session = `${e.id}-${target}-${randomUUID()}`;
                e.active.push(target);
                e.sessions[target] = session;
                try {
                    await this.transport.start(member, session);
                    signal.throwIfAborted();
                }
                catch (error) {
                    this.transport.stop(target);
                    e.active = e.active.filter(n => n !== target);
                    delete e.sessions[target];
                    throw error;
                }
                this.save('member-start', { target });
                return `Started ${target}; send_message to assign work.`;
            }
            case 'stop_agent': {
                const target = text(args.name, 'name');
                if (target === this.pool.chairman)
                    throw new Error('Cannot stop chairman');
                if (!e.active.includes(target))
                    throw new Error('Member is not active');
                this.transport.stop(target);
                e.active = e.active.filter(n => n !== target);
                this.save('member-stop', { target });
                return `Stopped ${target}`;
            }
            case 'send_message': {
                const recipients = [...new Set(strings(args.to, 'to').filter(p => p !== name))];
                if (!recipients.length || recipients.some(p => !e.active.includes(p)))
                    throw new Error('Recipients must be active teammates other than caller');
                const content = text(args.content, 'content');
                if (e.messages.length + recipients.length > this.options.maxMessages) {
                    this.abort('message budget exceeded');
                    throw new Error('Message budget exceeded');
                }
                for (const receiver of recipients) {
                    e.messages.push({ id: `msg_${e.messages.length + 1}`, sender: name, receiver, content, read: false, phase: e.phase });
                    this.transport.deliver(receiver, `[Message from ${name}]\n${content}`, true);
                }
                this.save('messages', { name, recipients });
                return `Message sent to ${recipients.join(', ')}`;
            }
            case 'read_messages': {
                const limit = args.limit ?? 20;
                if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 1000)
                    throw new Error('Invalid limit');
                const selected = e.messages.filter(m => m.receiver === name && (args.unread_only === false || !m.read) && (!args.sender || args.sender === m.sender)).slice(0, limit);
                selected.forEach(m => { m.read = true; });
                this.save('messages-read', { name, count: selected.length });
                return selected.length ? selected.map(m => `${m.sender}: ${m.content}`).join('\n') : 'No messages.';
            }
            case 'check_agent_status': return JSON.stringify(e.active.filter(n => !args.agent_name || args.agent_name === n).map(n => ({ name: n, phase: e.phase, completed: e.completed.includes(n), session: e.sessions[n] })));
            case 'finalize_task':
                e.output = text(args.output, 'output');
                this.phase('awaiting-feedback');
                return 'Deliverable recorded. Await external evaluator feedback; no synthetic verdict is supplied.';
            case 'set_final_output':
                e.output = text(args.output, 'output');
                this.save('deliverable');
                return 'Output recorded; call terminate.';
            case 'terminate':
                if (!e.output)
                    throw new Error('Finalize output before terminating');
                this.complete();
                return 'Episode complete.';
            case 'use_skill': {
                const skill = identifier(text(args.skill_name, 'skill_name'));
                const body = this.store.read(e.id, local(`skills/${skill}/SKILL.md`));
                if (!body)
                    throw new Error('Unknown skill');
                return body;
            }
            case 'update_prompt_patch': {
                const action = args.action;
                const file = local('evolution/prompt_patches.md');
                let patches = this.store.read(e.id, file).split('\n').filter(Boolean).map(p => p.replace(/^- /, ''));
                if (action === 'add')
                    patches.push(text(args.patch, 'patch'));
                else if (action === 'replace_all')
                    patches = strings(args.patches, 'patches').map(p => p.trim()).filter(Boolean);
                else if (action !== 'view')
                    throw new Error('Invalid patch action');
                if (action !== 'view')
                    this.store.write(e.id, file, patches.map(p => `- ${p}`).join('\n') + '\n');
                this.save('patches', { name, action });
                return patches.join('\n') || '(none)';
            }
            case 'update_skill': {
                const skill = identifier(text(args.skill_name, 'skill_name'));
                this.store.write(e.id, local(`skills/${skill}/SKILL.md`), text(args.content, 'content'));
                this.save('skill', { name, skill });
                return `Skill ${skill} saved. Call skip_l1_reflection when done.`;
            }
            case 'update_teammate_profile': {
                const target = text(args.teammate_name, 'teammate_name');
                this.role(target);
                if (target === name)
                    throw new Error('Cannot profile yourself');
                const file = local('evolution/teammate_profiles.yaml');
                const profiles = this.store.yaml(e.id, file);
                const input = text(args.profile, 'profile');
                let parsed;
                try {
                    parsed = load(input);
                }
                catch {
                    parsed = { notes: input };
                }
                const profile = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? object(parsed) : { notes: input };
                const old = Object.hasOwn(profiles, target) ? object(profiles[target]) : {};
                for (const [key, value] of Object.entries(profile)) {
                    if (['__proto__', 'constructor', 'prototype'].includes(key))
                        throw new Error('Unsafe profile key');
                    old[key] = Array.isArray(old[key]) && Array.isArray(value) ? [...new Set([...old[key], ...value])] : value;
                }
                Object.defineProperty(profiles, target, { value: old, enumerable: true, writable: true, configurable: true });
                this.store.writeYaml(e.id, file, profiles);
                this.save('profile', { name, target });
                return 'Teammate profile saved.';
            }
            case 'update_correlation': {
                const target = identifier(text(args.partner_name, 'partner_name'));
                this.role(target);
                if (target === name)
                    throw new Error('Cannot record a correlation with yourself');
                this.store.write(e.id, local(`evolution/correlations/${target}.md`), text(args.suggestion, 'suggestion') + '\n');
                this.save('correlation', { name, target });
                return 'Correlation replaced; preserve still-relevant notes before completing L2.';
            }
            case 'skip_l1_reflection':
            case 'skip_l2_reflection':
            case 'skip_l3_reflection':
                text(args.reason, 'reason');
                this.markDone(name);
                return `Member reflection complete; phase is ${e.phase}.`;
            case 'suggest_team_improvement':
                text(args.category, 'category');
                text(args.description, 'description');
                text(args.evidence, 'evidence');
                e.suggestions.push(JSON.parse(JSON.stringify({ ...args, suggested_by: name })));
                this.save('suggestion');
                return 'Suggestion recorded for chairman.';
            case 'view_reflection': return JSON.stringify({ proposals: e.proposals, suggestions: e.suggestions });
            case 'view_current_config': return this.store.read(e.id, this.proposalPath(text(args.target_file, 'target_file')));
            case 'propose_reflection': {
                const file = this.proposalPath(text(args.target_file, 'target_file'));
                const content = text(args.content, 'content');
                const reason = text(args.reason, 'reason');
                e.proposals[file] = { content, reason, author: name };
                this.save('proposal', { name, file });
                return 'Proposal stored; chairman must apply it.';
            }
            case 'apply_reflection':
                if (args.confirmation !== 'apply')
                    throw new Error('Type apply to confirm');
                this.applyProposals();
                this.complete();
                return 'Team revision committed.';
            case 'skip_reflection':
                text(args.reason, 'reason');
                this.complete();
                return 'Structural reflection skipped; L1/L2 artifacts committed.';
            default: throw new Error(`Unimplemented tool ${tool}`);
        }
    }
    proposalPath(file) {
        const parts = file.split('/');
        const governance = file === 'pool.yaml' || file === 'constitution.md';
        if (!governance && !((parts.length === 2 || parts.length === 3) && ['config.yaml', 'prompt.md'].includes(parts.at(-1))))
            throw new Error('Unsupported proposal file');
        for (const component of parts.slice(0, -1))
            identifier(component);
        safePath(this.store.working(this.current().id), file);
        return file;
    }
    applyProposals() {
        const e = this.current();
        const entries = Object.entries(e.proposals);
        if (!entries.length)
            throw new Error('No proposals to apply');
        // Validate every proposal before any write. Failed apply leaves staged artifacts,
        // never an invalid published HEAD. Full filesystem transaction is not claimed.
        const remove = new Set();
        for (const [file, proposal] of entries) {
            this.proposalPath(file);
            if (proposal.content.trim() === '__REMOVE__') {
                if (!file.endsWith('/config.yaml'))
                    throw new Error('Removal must target config.yaml');
                const directory = file.slice(0, -'/config.yaml'.length);
                if (directory === this.role(this.pool.chairman).directory)
                    throw new Error('Cannot remove current chairman');
                remove.add(directory);
            }
            else if (file.endsWith('/config.yaml')) {
                const cfg = object(load(proposal.content));
                identifier(text(cfg.name, 'config name'));
                const directory = file.slice(0, -'/config.yaml'.length);
                if (!this.store.read(e.id, `${directory}/prompt.md`) && !e.proposals[`${directory}/prompt.md`])
                    throw new Error('New role requires config.yaml and prompt.md');
            }
            else if (file === 'pool.yaml')
                object(load(proposal.content));
        }
        for (const [file, proposal] of entries) {
            const dir = file.slice(0, file.lastIndexOf('/'));
            if (remove.has(dir))
                continue;
            this.store.write(e.id, file, proposal.content);
        }
        for (const directory of remove)
            this.store.removeRole(e.id, directory);
        readPool(this.store.working(e.id), this.options.model);
        this.save('proposals-applied', { files: entries.map(([file]) => file) });
    }
    async close() {
        this.closing = true;
        if (this.episode && !TERMINAL.has(this.episode.phase))
            this.abort('plugin disposed before episode completed');
        for (const notify of this.listeners)
            notify();
        this.listeners.clear();
        try {
            await this.transport.close();
        }
        finally {
            this.store.release();
        }
    }
}

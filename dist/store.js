/** Immutable pool snapshots and per-episode working copies with explicit recovery. */
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { load, dump } from 'js-yaml';
import { identifier, object, text } from "./types.js";
/** Reject escapes and symlink traversal, including for a not-yet-created leaf. */
export function safePath(root, relativePath) {
    if (isAbsolute(relativePath) || relativePath.split(/[\\/]/).some(p => p === '..' || p === ''))
        throw new Error('Unsafe relative path');
    const target = resolve(root, relativePath);
    const rel = relative(resolve(root), target);
    if (rel.startsWith('..') || isAbsolute(rel))
        throw new Error('Path escapes root');
    let cursor = resolve(root);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink())
        throw new Error('Symlink root not allowed');
    for (const part of rel.split('/')) {
        cursor = join(cursor, part);
        if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink())
            throw new Error('Symlinks not allowed in artifacts');
    }
    return target;
}
export function atomicWrite(path, value) {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
        writeFileSync(temp, value, { flag: 'wx', mode: 0o600 });
        renameSync(temp, path);
    }
    finally {
        if (existsSync(temp))
            rmSync(temp);
    }
}
function rejectLinks(root) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (entry.isSymbolicLink())
            throw new Error(`Pool contains symlink: ${path}`);
        if (entry.isDirectory())
            rejectLinks(path);
    }
}
export function readPool(root, modelOverride) {
    rejectLinks(root);
    const yaml = object(load(readFileSync(join(root, 'pool.yaml'), 'utf8')));
    const chairman = identifier(text(yaml.chairman, 'chairman'));
    const roles = Object.create(null);
    // Upstream supports nested candidate pools; retain relative directory names.
    function scan(directory) {
        if (existsSync(join(directory, 'config.yaml')) && directory !== root) {
            const config = object(load(readFileSync(join(directory, 'config.yaml'), 'utf8')));
            const name = identifier(text(config.name, 'agent name'));
            if (roles[name])
                throw new Error(`Duplicate role: ${name}`);
            roles[name] = {
                name, directory: relative(root, directory), prompt: readFileSync(join(directory, 'prompt.md'), 'utf8'),
                model: modelOverride ?? text(config.model ?? 'claude-sonnet-4.6', 'model'),
                tools: Array.isArray(config.tools) ? config.tools.map(x => text(x, 'tool')) : [],
                maxTokens: typeof config.max_tokens === 'number' ? config.max_tokens : 32768,
                maxSteps: typeof config.max_steps === 'number' ? config.max_steps : 50,
                temperature: typeof config.temperature === 'number' ? config.temperature : 0.2,
            };
            if (!Number.isInteger(roles[name].maxTokens) || roles[name].maxTokens < 1 || !Number.isInteger(roles[name].maxSteps) || roles[name].maxSteps < 1)
                throw new Error('Role limits must be positive integers');
            if (!Number.isFinite(roles[name].temperature))
                throw new Error('Invalid role temperature');
            return;
        }
        for (const entry of readdirSync(directory, { withFileTypes: true }))
            if (entry.isDirectory() && !entry.name.startsWith('.'))
                scan(join(directory, entry.name));
    }
    scan(root);
    if (!roles[chairman])
        throw new Error('Chairman must be present in the candidate pool');
    return { chairman, roles, constitution: existsSync(join(root, 'constitution.md')) ? readFileSync(join(root, 'constitution.md'), 'utf8') : '' };
}
export class Store {
    root;
    ownsLock = false;
    constructor(stateDir, poolDir) {
        this.root = resolve(stateDir);
        mkdirSync(this.root, { recursive: true });
        safePath(this.root, 'HEAD');
        const lock = safePath(this.root, 'writer-lock');
        try {
            mkdirSync(lock);
        }
        catch {
            throw new Error('State root already has a writer lock; verify the old process exited before explicit recovery');
        }
        this.ownsLock = true;
        try {
            writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, started: Date.now() }), { flag: 'wx', mode: 0o600 });
            if (!existsSync(join(this.root, 'HEAD'))) {
                readPool(poolDir);
                const destination = this.snapshot('v000000');
                if (existsSync(destination))
                    throw new Error('Unpublished initial snapshot already exists; inspect recovery state');
                cpSync(poolDir, destination, { recursive: true, errorOnExist: true, force: false });
                atomicWrite(join(this.root, 'HEAD'), 'v000000\n');
            }
            readPool(this.snapshot(this.head()));
        }
        catch (error) {
            this.release();
            throw error;
        }
    }
    release() {
        if (this.ownsLock) {
            rmSync(join(this.root, 'writer-lock'), { recursive: true });
            this.ownsLock = false;
        }
    }
    head() { return identifier(readFileSync(join(this.root, 'HEAD'), 'utf8').trim()); }
    snapshot(version) { return safePath(this.root, `versions/${identifier(version)}`); }
    episodeRoot(id) { return safePath(this.root, `episodes/${identifier(id)}`); }
    working(id) { return safePath(this.root, `episodes/${identifier(id)}/team`); }
    create(id) {
        const destination = this.working(id);
        if (existsSync(this.episodeRoot(id)))
            throw new Error('Episode id already exists');
        cpSync(this.snapshot(this.head()), destination, { recursive: true, errorOnExist: true, force: false });
        return destination;
    }
    save(episode) { atomicWrite(join(this.episodeRoot(episode.id), 'state.json'), JSON.stringify(episode, null, 2) + '\n'); }
    audit(id, event, data) {
        const directory = safePath(this.episodeRoot(id), 'audit');
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, `${Date.now()}-${randomUUID()}.json`), JSON.stringify({ event, data, at: Date.now() }) + '\n', { flag: 'wx', mode: 0o600 });
    }
    read(id, file) {
        const path = safePath(this.working(id), file);
        return existsSync(path) ? readFileSync(path, 'utf8') : '';
    }
    write(id, file, value) { atomicWrite(safePath(this.working(id), file), value); }
    yaml(id, file) {
        const content = this.read(id, file);
        return content.trim() ? object(load(content)) : {};
    }
    writeYaml(id, file, value) { this.write(id, file, dump(value, { noRefs: true, sortKeys: true })); }
    removeRole(id, directory) { rmSync(safePath(this.working(id), directory), { recursive: true, force: false }); }
    commit(id, expectedHead) {
        if (this.head() !== expectedHead)
            throw new Error('Snapshot conflict: HEAD changed');
        readPool(this.working(id));
        const versions = readdirSync(dirname(this.snapshot('v000000'))).filter(x => /^v\d{6}$/.test(x));
        const next = `v${String(Math.max(...versions.map(x => Number(x.slice(1)))) + 1).padStart(6, '0')}`;
        const target = this.snapshot(next);
        cpSync(this.working(id), target, { recursive: true, errorOnExist: true, force: false });
        atomicWrite(join(this.root, 'HEAD'), `${next}\n`);
        return next;
    }
    freeze(version, destination) {
        const target = resolve(destination);
        if (existsSync(target))
            throw new Error('Freeze destination must not exist');
        readPool(this.snapshot(version));
        cpSync(this.snapshot(version), target, { recursive: true, force: false, errorOnExist: true });
        atomicWrite(join(target, 'FROZEN_FROM.md'), `# Frozen Meta-Team\n\nSource version: ${version}\n`);
    }
}

/**
 * dsh-autocompact — universal auto context compaction for DeepSeek Harness.
 *
 * Evidence-driven design (forensics on one long session, 2026-09):
 *  - The session died with 0 compaction events while surface tokens grew past
 *    1M; the final request failed upstream with a context-limit error
 *    ("prompt is too long: N tokens > M maximum") yet the harness retried it
 *    100+ times as generic SERVER errors — the session went unresponsive. Two
 *    independent defects:
 *      (a) the active preset mounted NO compaction group;
 *      (b) providers mislabel context overflow, so the official recovery
 *          listener (failure.code === CONTEXT_WINDOW_EXCEEDED) never fires,
 *          and declared contextWindows are inflated (one third-party route
 *          declared 1M against a real 100K upstream cap), so pressure
 *          thresholds compute against the wrong capacity.
 *
 * This plugin is model-agnostic and preset-agnostic. Three layers:
 *  1. LLM seam classification (host plane, patched once): every ctx.llm.stream
 *     failure whose text matches known overflow patterns is re-classified as
 *     CONTEXT_WINDOW_EXCEEDED — the exact code the official compaction engine
 *     listens for — and any explicit upstream limit is learned into a
 *     per-provider/model true-window table.
 *  2. Truthful windows: ctx.llm.resolveModelInfo is wrapped so the learned (or
 *     seeded) window shrinks the declared capacity, which corrects every
 *     consumer — compaction pressure thresholds, the token meter projection,
 *     and the UI context ring.
 *  3. Engine mount: preset agent.cordis.yml files missing the official
 *     compaction group (compaction-basic + command-compact +
 *     tool-result-pruner) get it appended (with a .bak-autocompact backup),
 *     copying the same block compaction-enabled presets use.
 *
 * Verification: `/autocompact status` reports the window table, classification
 * counters, injection results and engine availability.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { CONTEXT_WINDOW_EXCEEDED_CODE, LlmError, isContextWindowExceededError, } from '@deepseek-ai/dsh-llm';
import { overflowLikely, captureWindow } from './overflow.js';
export { overflowLikely, captureWindow } from './overflow.js';
export const name = 'dsh-autocompact';
/** Only llm is mandatory; settings/commands are resolved defensively. */
export const inject = ['llm'];
/**
 * Built-in seeds are intentionally EMPTY: the public plugin carries no
 * provider-specific entries. Personal measured windows belong in the
 * user-directory file `~/.dsh/dsh-autocompact/seeds.json` (outside git),
 * merged between these defaults and runtime-learned state.json entries.
 */
const SEED_WINDOWS = {};
const PLUGIN_DIR_NAME = 'dsh-autocompact';
function dshHome() {
    return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
}
function statePath() {
    return path.join(dshHome(), PLUGIN_DIR_NAME, 'state.json');
}
function userSeedsPath() {
    return path.join(dshHome(), PLUGIN_DIR_NAME, 'seeds.json');
}
/** Personal seed table kept outside the repository; tolerant reader. */
function loadUserSeeds() {
    try {
        const parsed = JSON.parse(fs.readFileSync(userSeedsPath(), 'utf8'));
        const out = {};
        for (const [key, value] of Object.entries(parsed)) {
            if (typeof value?.contextWindow === 'number' && Number.isFinite(value.contextWindow)) {
                out[key] = {
                    contextWindow: Math.floor(value.contextWindow),
                    source: typeof value.source === 'string' && value.source.length > 0 ? value.source : 'user seeds.json',
                    updatedAt: 0,
                };
            }
        }
        return out;
    }
    catch {
        return {};
    }
}
function loadState() {
    const base = {
        version: 1,
        windows: { ...SEED_WINDOWS, ...loadUserSeeds() },
        classified: 0,
        learned: 0,
        injected: [],
    };
    try {
        const raw = fs.readFileSync(statePath(), 'utf8');
        const parsed = JSON.parse(raw);
        return {
            version: 1,
            windows: { ...SEED_WINDOWS, ...loadUserSeeds(), ...(parsed.windows ?? {}) },
            classified: parsed.classified ?? 0,
            learned: parsed.learned ?? 0,
            injected: parsed.injected ?? [],
        };
    }
    catch {
        return base;
    }
}
function saveState(state) {
    try {
        const file = statePath();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
        fs.renameSync(tmp, file);
    }
    catch {
        // persistence is best-effort; the runtime table stays valid in memory
    }
}
// ── preset injection ─────────────────────────────────────────────────────────
/** The official compaction group block (mirrors compaction-enabled presets). */
function compactionBlock(groupId) {
    return [
        '',
        '# ── compaction (injected by dsh-autocompact) ─────────────────────────────────',
        '# Official compaction family: auto-compaction under token pressure, the',
        '# /compact command, and tool-result pruning — mounted for every preset so',
        '# long sessions compact instead of exceeding the provider context limit.',
        `- id: ${groupId}`,
        '  name: cordis:group',
        '  group: true',
        '  isolate:',
        '    compaction: true',
        '    toolResultPruner: true',
        '  config:',
        '    - id: compaction-basic',
        "      name: '@deepseek-ai/dsh-compaction-basic'",
        '    - id: command-compact',
        "      name: '@deepseek-ai/dsh-command-compact'",
        '    - id: tool-result-pruner',
        "      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
        '      config:',
        '        thresholdChars: 8192',
        '        headChars: 4096',
        '        tailChars: 1024',
        '',
    ].join('\n');
}
/** Best-effort probe: can the loader resolve the official compaction packages? */
function resolutionProbe() {
    const home = dshHome();
    const here = path.dirname(fileURLToPath(import.meta.url));
    const anchors = [
        path.join(home, 'profiles', 'desktop'),
        path.join(home, '.agent-presets'),
        here,
        path.resolve(here, '..'),
    ];
    const pkgs = [
        '@deepseek-ai/dsh-compaction-basic',
        '@deepseek-ai/dsh-command-compact',
        '@deepseek-ai/dsh-compaction-tool-result-pruner',
    ];
    for (const anchor of anchors) {
        try {
            const req = createRequire(path.join(anchor, 'noop.js'));
            if (pkgs.every((p) => { try {
                req.resolve(p);
                return true;
            }
            catch {
                return false;
            } })) {
                return { ok: true, anchors };
            }
        }
        catch {
            // try next anchor
        }
    }
    return { ok: false, anchors };
}
function injectPresets(state, { write = false } = {}) {
    const results = [];
    const presetsDir = path.join(dshHome(), '.agent-presets');
    let entries = [];
    try {
        entries = fs.readdirSync(presetsDir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name);
    }
    catch {
        return results;
    }
    const probe = resolutionProbe();
    for (const presetName of entries) {
        const file = path.join(presetsDir, presetName, 'agent.cordis.yml');
        let content;
        try {
            content = fs.readFileSync(file, 'utf8');
        }
        catch {
            continue;
        }
        if (/^\s*- id: compaction-basic\s*$/m.test(content) || /name:\s*['"]?@deepseek-ai\/dsh-compaction-basic['"]?/.test(content)) {
            results.push({ preset: presetName, action: 'already-mounted' });
            continue;
        }
        const groupId = /^\s*- id: compaction\s*$/m.test(content)
            ? 'compaction-autocompact'
            : 'compaction';
        const backup = `${file}.bak-autocompact`;
        if (!write) {
            results.push({
                preset: presetName,
                action: 'pending',
                note: 'dry-run: run /autocompact inject to write this preset (backup will be .bak-autocompact)',
            });
            continue;
        }
        try {
            fs.copyFileSync(file, backup);
            fs.writeFileSync(file, content.replace(/\s*$/, '\n') + compactionBlock(groupId), 'utf8');
            results.push({
                preset: presetName,
                action: 'injected',
                backup,
                ...(probe.ok ? {} : { note: 'official compaction packages not resolvable from probe anchors; if this preset fails to boot, restore the .bak and run: dsh plugin --profile desktop add @deepseek-ai/dsh-compaction-basic' }),
            });
        }
        catch (error) {
            results.push({ preset: presetName, action: 'failed', note: String(error) });
        }
    }
    return results;
}
function failureMessage(failure) {
    if (failure instanceof Error)
        return failure.message;
    try {
        return String(failure);
    }
    catch {
        return '';
    }
}
export function apply(ctx) {
    const state = loadState();
    const llm = ctx.get('llm');
    const log = (msg) => ctx.logger.info(`[autocompact] ${msg}`);
    const remember = (provider, model, window, source) => {
        const key = `${provider}/${model}`;
        const existing = state.windows[key];
        if (existing !== undefined && existing.contextWindow === window)
            return;
        state.windows[key] = { contextWindow: window, source, updatedAt: Date.now() };
        state.learned += 1;
        saveState(state);
        log(`learned true context window ${key} = ${window} (${source.slice(0, 120)})`);
    };
    /** Classify one failure; learn any explicit upstream window. */
    const classify = (provider, model, failure) => {
        const message = failureMessage(failure);
        const already = isContextWindowExceededError(message) ||
            failure?.code === CONTEXT_WINDOW_EXCEEDED_CODE;
        const likely = overflowLikely(message);
        if (!likely)
            return failure;
        state.classified += 1;
        if (provider !== undefined && provider.length > 0 && model !== undefined && model.length > 0) {
            const learned = captureWindow(message);
            if (learned !== undefined)
                remember(provider, model, learned, `learned: ${message.slice(0, 160)}`);
        }
        if (already)
            return failure;
        const code = failure?.code ?? 'unknown';
        log(`re-classified ${provider}/${model} failure ${code} -> ${CONTEXT_WINDOW_EXCEEDED_CODE}: ${message.slice(0, 160)}`);
        try {
            return new LlmError(message, CONTEXT_WINDOW_EXCEEDED_CODE, {
                cause: failure,
            });
        }
        catch {
            try {
                failure.code = CONTEXT_WINDOW_EXCEEDED_CODE;
            }
            catch {
                // immutable failure: classification could not be applied
            }
            return failure;
        }
    };
    const originalStream = llm !== undefined && typeof llm.stream === 'function' ? llm.stream.bind(llm) : null;
    const originalResolve = llm !== undefined && typeof llm.resolveModelInfo === 'function' ? llm.resolveModelInfo.bind(llm) : null;
    if (llm !== undefined && typeof llm.stream === 'function' && llm.__autocompactStream !== true) {
        llm.stream = async function* patchedStream(options, ...rest) {
            const provider = options?.provider;
            const model = options?.model;
            try {
                for await (const chunk of originalStream(options, ...rest)) {
                    if (chunk !== null && typeof chunk === 'object' && chunk.kind === 'error' && chunk.failure !== undefined) {
                        yield { ...chunk, failure: classify(provider, model, chunk.failure) };
                    }
                    else {
                        yield chunk;
                    }
                }
            }
            catch (error) {
                throw classify(provider, model, error);
            }
        };
        llm.__autocompactStream = true;
        log('llm.stream overflow classification armed (host plane, applies to every preset realm)');
    }
    if (llm !== undefined && typeof llm.resolveModelInfo === 'function' && llm.__autocompactResolve !== true) {
        llm.resolveModelInfo = async function patchedResolve(provider, model, ...rest) {
            const info = await originalResolve(provider, model, ...rest);
            try {
                const entry = state.windows[`${provider}/${model}`];
                const declared = info?.context?.contextWindow;
                if (entry !== undefined && typeof declared === 'number' && declared !== entry.contextWindow) {
                    const corrected = Math.min(declared, entry.contextWindow);
                    if (corrected !== declared) {
                        log(`window override ${provider}/${model}: declared ${declared} -> ${corrected}`);
                        return { ...info, context: { ...info?.context, contextWindow: corrected } };
                    }
                }
            }
            catch {
                // never break model resolution
            }
            return info;
        };
        llm.__autocompactResolve = true;
    }
    // ── preset mounting ────────────────────────────────────────────────────────
    // Boot is dry-run: never rewrite ~/.dsh/.agent-presets unless the user
    // explicitly runs `/autocompact inject`.
    let injections = injectPresets(state, { write: false });
    state.injected = injections.filter((r) => r.action === 'injected').map((r) => r.preset);
    saveState(state);
    for (const r of injections) {
        if (r.action === 'pending')
            log(`preset "${r.preset}": compaction group missing — run /autocompact inject to write (dry-run)`);
        if (r.action === 'injected')
            log(`preset "${r.preset}": compaction group injected (backup: ${r.backup ?? 'n/a'})${r.note !== undefined ? ` — ${r.note}` : ''}`);
        if (r.action === 'failed')
            log(`preset "${r.preset}": injection FAILED — ${r.note ?? 'unknown'}`);
    }
    // ── /autocompact command ───────────────────────────────────────────────────
    const statusText = () => {
        const lines = [];
        lines.push('dsh-autocompact status');
        lines.push('');
        lines.push('True context-window table (min(declared, learned) is applied at resolveModelInfo):');
        const keys = Object.keys(state.windows).sort();
        if (keys.length === 0)
            lines.push('  (empty)');
        for (const key of keys) {
            const e = state.windows[key];
            const when = e.updatedAt > 0 ? new Date(e.updatedAt).toISOString() : 'seed';
            lines.push(`  ${key} = ${e.contextWindow}  [${when}]  ${e.source}`);
        }
        lines.push('');
        lines.push(`Overflow failures classified: ${state.classified}; windows learned: ${state.learned}`);
        lines.push('');
        lines.push('Preset compaction-group injections:');
        if (injections.length === 0)
            lines.push('  (no presets found)');
        for (const r of injections) {
            lines.push(`  ${r.preset}: ${r.action}${r.note !== undefined ? ` — ${r.note}` : ''}`);
        }
        const probe = resolutionProbe();
        lines.push('');
        lines.push(`Official compaction packages resolvable from profile dir: ${probe.ok ? 'yes' : 'not from profile dir (usually fine — DSH resolves preset plugin rows from the app bundle; restore the .bak only if an injected preset fails to boot)'}`);
        lines.push(`State file: ${statePath()}`);
        lines.push(`User seeds file: ${userSeedsPath()} (personal entries, not in git)`);
        return lines.join('\n');
    };
    const commands = ctx.get('commands');
    if (commands !== undefined && typeof commands.register === 'function') {
        try {
            commands.register({
                name: 'autocompact',
                description: '上下文自动压缩守护：status（默认）或 inject（显式写入 preset）',
                input: { hint: '[status | inject]' },
                handler: async (inv) => {
                    const sub = String(inv?.rawInput ?? '').trim().split(/\s+/)[0]?.toLowerCase() || 'status';
                    if (sub === 'inject') {
                        injections = injectPresets(state, { write: true });
                        state.injected = injections.filter((r) => r.action === 'injected').map((r) => r.preset);
                        saveState(state);
                        return { kind: 'success', text: statusText() };
                    }
                    return { kind: 'success', text: statusText() };
                },
            });
        }
        catch (error) {
            ctx.logger.warn(`[autocompact] /autocompact command registration failed: ${String(error)}`);
        }
    }
    const dispose = () => {
        if (llm !== undefined) {
            if (originalStream)
                llm.stream = originalStream;
            if (originalResolve)
                llm.resolveModelInfo = originalResolve;
            delete llm.__autocompactStream;
            delete llm.__autocompactResolve;
        }
    };
    try {
        ctx.effect?.(() => dispose, 'dsh-autocompact: llm seam');
    }
    catch {
        // host without ctx.effect — patch stays until process exit
    }
    log(`boot complete — windows=${Object.keys(state.windows).length}, streamPatched=${llm?.__autocompactStream === true}, resolvePatched=${llm?.__autocompactResolve === true}`);
}

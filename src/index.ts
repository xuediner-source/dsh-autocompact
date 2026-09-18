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
import type { Context } from '@deepseek-ai/cordis';
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  LlmError,
  isContextWindowExceededError,
} from '@deepseek-ai/dsh-llm';

export const name = 'dsh-autocompact';
/** Only llm is mandatory; settings/commands are resolved defensively. */
export const inject = ['llm'];

// ── overflow detection ───────────────────────────────────────────────────────

/** Message patterns emitted by upstreams when the prompt exceeds the window. */
const OVERFLOW_RES: RegExp[] = [
  /prompt is too long/i,
  /context_length_exceeded/i,
  /maximum context/i,
  /context window/i,
  /exceeds the model context/i,
  /model context limit/i,
  /超出模型长度上限/,
  /request_body_too_large/i,
  /request.{0,24}too.{0,12}large/i,
  /\b11115\b/,
];

/** Extract the upstream's stated token limit, when the message carries one. */
const WINDOW_CAPTURE_RES: RegExp[] = [
  /tokens?\s*>\s*([\d,]+)\s*maximum/i,
  /maximum context length is\s*([\d,]+)/i,
  /context[_\s-]?length\D{0,24}([\d,]{4,})/i,
];

function overflowLikely(message: string): boolean {
  return OVERFLOW_RES.some((re) => re.test(message));
}

function captureWindow(message: string): number | undefined {
  for (const re of WINDOW_CAPTURE_RES) {
    const m = re.exec(message);
    if (m === null) continue;
    const n = Number(m[1].replace(/,/g, ''));
    if (Number.isFinite(n) && n >= 1000 && n <= 10_000_000) return Math.floor(n);
  }
  return undefined;
}

// ── persisted state (true-window table) ─────────────────────────────────────

interface WindowEntry {
  contextWindow: number;
  source: string;
  updatedAt: number;
}

interface AutocompactState {
  version: 1;
  windows: Record<string, WindowEntry>;
  classified: number;
  learned: number;
  injected: string[];
}

/**
 * Built-in seeds are intentionally EMPTY: the public plugin carries no
 * provider-specific entries. Personal measured windows belong in the
 * user-directory file `~/.dsh/dsh-autocompact/seeds.json` (outside git),
 * merged between these defaults and runtime-learned state.json entries.
 */
const SEED_WINDOWS: Record<string, WindowEntry> = {};

const PLUGIN_DIR_NAME = 'dsh-autocompact';

function dshHome(): string {
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
}

function statePath(): string {
  return path.join(dshHome(), PLUGIN_DIR_NAME, 'state.json');
}

function userSeedsPath(): string {
  return path.join(dshHome(), PLUGIN_DIR_NAME, 'seeds.json');
}

/** Personal seed table kept outside the repository; tolerant reader. */
function loadUserSeeds(): Record<string, WindowEntry> {
  try {
    const parsed = JSON.parse(fs.readFileSync(userSeedsPath(), 'utf8')) as Record<string, Partial<WindowEntry>>;
    const out: Record<string, WindowEntry> = {};
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
  } catch {
    return {};
  }
}

function loadState(): AutocompactState {
  const base: AutocompactState = {
    version: 1,
    windows: { ...SEED_WINDOWS, ...loadUserSeeds() },
    classified: 0,
    learned: 0,
    injected: [],
  };
  try {
    const raw = fs.readFileSync(statePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<AutocompactState>;
    return {
      version: 1,
      windows: { ...SEED_WINDOWS, ...loadUserSeeds(), ...(parsed.windows ?? {}) },
      classified: parsed.classified ?? 0,
      learned: parsed.learned ?? 0,
      injected: parsed.injected ?? [],
    };
  } catch {
    return base;
  }
}

function saveState(state: AutocompactState): void {
  try {
    const file = statePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    // persistence is best-effort; the runtime table stays valid in memory
  }
}

// ── preset injection ─────────────────────────────────────────────────────────

/** The official compaction group block (mirrors novel-solo/liangshen presets). */
function compactionBlock(groupId: string): string {
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
function resolutionProbe(): { ok: boolean; anchors: string[] } {
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
      if (pkgs.every((p) => { try { req.resolve(p); return true; } catch { return false; } })) {
        return { ok: true, anchors };
      }
    } catch {
      // try next anchor
    }
  }
  return { ok: false, anchors };
}

interface InjectionResult {
  preset: string;
  action: 'injected' | 'already-mounted' | 'failed';
  backup?: string;
  note?: string;
}

function injectPresets(state: AutocompactState): InjectionResult[] {
  const results: InjectionResult[] = [];
  const presetsDir = path.join(dshHome(), '.agent-presets');
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(presetsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return results;
  }
  const probe = resolutionProbe();
  for (const presetName of entries) {
    const file = path.join(presetsDir, presetName, 'agent.cordis.yml');
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (/^\s*- id: compaction-basic\s*$/m.test(content)) {
      results.push({ preset: presetName, action: 'already-mounted' });
      continue;
    }
    const groupId = /^\s*- id: compaction\s*$/m.test(content)
      ? 'compaction-autocompact'
      : 'compaction';
    try {
      const backup = `${file}.bak-autocompact`;
      fs.copyFileSync(file, backup);
      fs.writeFileSync(file, content.replace(/\s*$/, '\n') + compactionBlock(groupId), 'utf8');
      results.push({
        preset: presetName,
        action: 'injected',
        backup,
        ...(probe.ok ? {} : { note: 'official compaction packages not resolvable from probe anchors; if this preset fails to boot, restore the .bak and run: dsh plugin --profile desktop add @deepseek-ai/dsh-compaction-basic' }),
      });
    } catch (error) {
      results.push({ preset: presetName, action: 'failed', note: String(error) });
    }
  }
  return results;
}

// ── llm seam patch ───────────────────────────────────────────────────────────

interface LlmStreamChunkLike {
  kind?: string;
  failure?: { code?: string; message?: string; status?: number };
}

function failureMessage(failure: unknown): string {
  if (failure instanceof Error) return failure.message;
  try {
    return String(failure);
  } catch {
    return '';
  }
}

export function apply(ctx: Context): void {
  const state = loadState();
  const llm = ctx.get('llm') as Record<string, unknown> | undefined;
  const log = (msg: string) => ctx.logger.info(`[autocompact] ${msg}`);

  const remember = (provider: string, model: string, window: number, source: string): void => {
    const key = `${provider}/${model}`;
    const existing = state.windows[key];
    if (existing !== undefined && existing.contextWindow === window) return;
    state.windows[key] = { contextWindow: window, source, updatedAt: Date.now() };
    state.learned += 1;
    saveState(state);
    log(`learned true context window ${key} = ${window} (${source.slice(0, 120)})`);
  };

  /** Classify one failure; learn any explicit upstream window. */
  const classify = (
    provider: string | undefined,
    model: string | undefined,
    failure: unknown,
  ): unknown => {
    const message = failureMessage(failure);
    const already =
      isContextWindowExceededError(message) ||
      (failure as { code?: string } | null)?.code === CONTEXT_WINDOW_EXCEEDED_CODE;
    const likely = overflowLikely(message);
    if (!likely) return failure;
    state.classified += 1;
    if (provider !== undefined && provider.length > 0 && model !== undefined && model.length > 0) {
      const learned = captureWindow(message);
      if (learned !== undefined) remember(provider, model, learned, `learned: ${message.slice(0, 160)}`);
    }
    if (already) return failure;
    const code = (failure as { code?: string } | null)?.code ?? 'unknown';
    log(`re-classified ${provider}/${model} failure ${code} -> ${CONTEXT_WINDOW_EXCEEDED_CODE}: ${message.slice(0, 160)}`);
    try {
      return new LlmError(message, CONTEXT_WINDOW_EXCEEDED_CODE, {
        cause: failure,
      });
    } catch {
      try {
        (failure as { code?: string }).code = CONTEXT_WINDOW_EXCEEDED_CODE;
      } catch {
        // immutable failure: classification could not be applied
      }
      return failure;
    }
  };

  if (llm !== undefined && typeof llm.stream === 'function' && llm.__autocompactStream !== true) {
    const originalStream = llm.stream.bind(llm);
    llm.stream = async function* patchedStream(
      options: { provider?: string; model?: string } | undefined,
      ...rest: unknown[]
    ): AsyncGenerator<LlmStreamChunkLike> {
      const provider = options?.provider;
      const model = options?.model;
      try {
        for await (const chunk of originalStream(options, ...rest) as AsyncIterable<LlmStreamChunkLike>) {
          if (chunk !== null && typeof chunk === 'object' && chunk.kind === 'error' && chunk.failure !== undefined) {
            yield { ...chunk, failure: classify(provider, model, chunk.failure) as typeof chunk.failure };
          } else {
            yield chunk;
          }
        }
      } catch (error) {
        throw classify(provider, model, error);
      }
    };
    llm.__autocompactStream = true;
    log('llm.stream overflow classification armed (host plane, applies to every preset realm)');
  }

  if (llm !== undefined && typeof llm.resolveModelInfo === 'function' && llm.__autocompactResolve !== true) {
    const originalResolve = llm.resolveModelInfo.bind(llm);
    llm.resolveModelInfo = async function patchedResolve(
      provider: string,
      model: string,
      ...rest: unknown[]
    ): Promise<{ context?: { contextWindow?: number } } | undefined> {
      const info = await originalResolve(provider, model, ...rest) as { context?: { contextWindow?: number } } | undefined;
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
      } catch {
        // never break model resolution
      }
      return info;
    };
    llm.__autocompactResolve = true;
  }

  // ── preset mounting ────────────────────────────────────────────────────────
  const injections = injectPresets(state);
  state.injected = injections.filter((r) => r.action === 'injected').map((r) => r.preset);
  saveState(state);
  for (const r of injections) {
    if (r.action === 'injected') log(`preset "${r.preset}": compaction group injected (backup: ${r.backup ?? 'n/a'})${r.note !== undefined ? ` — ${r.note}` : ''}`);
    if (r.action === 'failed') log(`preset "${r.preset}": injection FAILED — ${r.note ?? 'unknown'}`);
  }

  // ── /autocompact command ───────────────────────────────────────────────────
  const statusText = (): string => {
    const lines: string[] = [];
    lines.push('dsh-autocompact status');
    lines.push('');
    lines.push('True context-window table (min(declared, learned) is applied at resolveModelInfo):');
    const keys = Object.keys(state.windows).sort();
    if (keys.length === 0) lines.push('  (empty)');
    for (const key of keys) {
      const e = state.windows[key];
      const when = e.updatedAt > 0 ? new Date(e.updatedAt).toISOString() : 'seed';
      lines.push(`  ${key} = ${e.contextWindow}  [${when}]  ${e.source}`);
    }
    lines.push('');
    lines.push(`Overflow failures classified: ${state.classified}; windows learned: ${state.learned}`);
    lines.push('');
    lines.push('Preset compaction-group injections:');
    if (injections.length === 0) lines.push('  (no presets found)');
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

  const commands = ctx.get('commands') as
    | { register?: (cmd: { name: string; description: string; handler: () => Promise<{ kind: string; text: string }> }) => unknown }
    | undefined;
  if (commands !== undefined && typeof commands.register === 'function') {
    try {
      commands.register({
        name: 'autocompact',
        description: '上下文自动压缩守护：真实窗口表 / 溢出分类计数 / preset 压缩组注入状态',
        handler: async () => ({ kind: 'success', text: statusText() }),
      });
    } catch (error) {
      ctx.logger.warn(`[autocompact] /autocompact command registration failed: ${String(error)}`);
    }
  }

  log(`boot complete — windows=${Object.keys(state.windows).length}, streamPatched=${llm?.__autocompactStream === true}, resolvePatched=${llm?.__autocompactResolve === true}`);
}

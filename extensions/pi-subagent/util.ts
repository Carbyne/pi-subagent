/**
 * Shared helpers for the pi-subagent extension.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

/**
 * Parse a duration to milliseconds. Plain numbers are SECONDS (600 -> 600000).
 * Strings may carry a unit: "1500ms", "60s", "10m", "1h" (default unit: s).
 * Throws on garbage so misconfiguration fails loudly.
 */
export function parseDuration(v: unknown): number {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.floor(v * 1000);
    if (typeof v === "string") {
        const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i);
        if (m) {
            const n = Number(m[1]);
            const mul = ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const)[
                (m[2] ?? "s").toLowerCase() as "ms" | "s" | "m" | "h"
            ];
            return Math.floor(n * mul);
        }
        const num = Number(v.trim());
        if (Number.isFinite(num) && num >= 0) return Math.floor(num * 1000);
    }
    throw new Error(
        `pi-subagent: invalid duration ${JSON.stringify(v)} (use seconds or a unit, e.g. 600, 5m, 1h, 1500ms)`
    );
}

/** Human-readable age for user-facing messages. */
export function formatAge(ms: number): string {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
    return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export function fmtDur(ms: number): string {
    return ms < 1000 ? `${ms}ms` : formatAge(ms);
}

/**
 * Resolve how to invoke pi as a subprocess, mirroring the current process
 * (works for the bundled binary, a node-installed CLI, or a source checkout).
 */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
    const currentScript = process.argv[1];
    const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
    if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
        return { command: process.execPath, args: [currentScript, ...args] };
    }

    const execName = path.basename(process.execPath).toLowerCase();
    const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
    if (!isGenericRuntime) {
        return { command: process.execPath, args };
    }

    return { command: "pi", args };
}

export async function writePromptToTempFile(
    agentName: string,
    prompt: string
): Promise<{ dir: string; filePath: string }> {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
    const safeName = agentName.replace(/[^\w.-]+/g, "_");
    const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
    await withFileMutationQueue(filePath, async () => {
        await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
    });
    return { dir: tmpDir, filePath };
}

// ── Control plane: glob matching + model policy (pure, unit-testable) ─────

/** Glob match: * and ? wildcards. A pattern without "/" also matches the
 *  bare model id part of "provider/id" (so "qwen*" matches "yoda/qwen3"). */
export function globMatch(pattern: string, value: string): boolean {
    const rx = (p: string) =>
        new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
    if (rx(pattern).test(value)) return true;
    if (!pattern.includes("/")) {
        const bare = value.includes("/") ? value.split("/").slice(1).join("/") : value;
        if (rx(pattern).test(bare)) return true;
    }
    return false;
}

export function matchAny(patterns: string[], value: string): boolean {
    return patterns.some((p) => globMatch(p, value));
}

export interface ModelPolicy {
    /** free: anything goes. inherit: children always run the parent model.
     *  allowlist: only patterns in `allow` (parent model always allowed).
     *  denylist: anything except patterns in `deny` (parent model always allowed). */
    mode: "free" | "inherit" | "allowlist" | "denylist";
    allow?: string[];
    deny?: string[];
}

export interface ModelPolicyResult {
    ok: boolean;
    model?: string;
    error?: string;
}

/** Resolve the model a child may use under the configured policy.
 *  `requested` is the agent-file/inline model override; parent model is the
 *  session model. The current main-agent model is ALWAYS permitted (that is
 *  the baseline the user trusts); policy only restricts deviations. */
export function applyModelPolicy(
    requested: string | undefined,
    parentModel: string | undefined,
    policy?: ModelPolicy
): ModelPolicyResult {
    if (!policy || policy.mode === "free") return { ok: true, model: requested ?? parentModel };
    if (policy.mode === "inherit") {
        if (requested && parentModel && requested !== parentModel)
            return {
                ok: false,
                error: `subagent model policy is 'inherit' — the current model (${parentModel}) must be used; agent requested '${requested}'`,
            };
        return { ok: true, model: parentModel };
    }
    const candidate = requested ?? parentModel;
    if (!candidate) return { ok: true, model: undefined };
    if (parentModel && candidate === parentModel) return { ok: true, model: candidate };
    if (policy.mode === "allowlist") {
        const list = policy.allow ?? [];
        return matchAny(list, candidate)
            ? { ok: true, model: candidate }
            : {
                  ok: false,
                  error: `model '${candidate}' is not in the subagent allowlist [${list.join(", ") || "(empty)"}] — only the current session model${parentModel ? ` (${parentModel})` : ""} and allowlisted models may be used`,
              };
    }
    if (policy.mode === "denylist") {
        const list = policy.deny ?? [];
        return matchAny(list, candidate)
            ? {
                  ok: false,
                  error: `model '${candidate}' is blocked by the subagent denylist [${list.join(", ")}]`,
              }
            : { ok: true, model: candidate };
    }
    return { ok: true, model: candidate };
}

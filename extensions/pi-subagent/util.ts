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

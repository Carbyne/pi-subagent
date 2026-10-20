/**
 * RPC child wrapper for background subagents.
 *
 * Spawns `pi --mode rpc` as a long-lived child process and drives it over
 * stdin (JSONL commands: prompt / steer / follow_up / abort) while consuming
 * its JSONL event stream on stdout. Every raw event line is appended to a
 * per-run log file (which is also handed to pi-bg-jobs via bg-jobs:adopt so
 * `bg_jobs` list/output/kill work on background subagents) and a small ring
 * buffer of rendered turns is kept in memory for `peek`.
 *
 * Framing follows pi's RPC spec: split on "\n" only, strip trailing "\r".
 */

import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, openSync, closeSync } from "node:fs";
import { formatAge } from "./util.ts";

export interface RpcUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens: number;
    turns: number;
}

export interface RingEntry {
    kind: "user" | "assistant" | "tool" | "result" | "system";
    text: string;
    at: number;
}

export type SettleListener = () => void;
export type ExitListener = (code: number | null) => void;

const RING_LIMIT = 120;

/** Truncate long strings for the ring/peek view. */
function clip(s: string, n: number): string {
    const t = s.replace(/\s+$/g, "");
    return t.length > n ? `${t.slice(0, n)}…` : t;
}

function messageText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((p) => {
                const part = p as { type?: string; text?: string };
                return part?.type === "text" ? (part.text ?? "") : "";
            })
            .join("\n");
    }
    return "";
}

export class RpcSubagent {
    readonly proc: ChildProcess;
    readonly logPath: string;
    private logFd: number | undefined;
    private buffer = "";
    private exited = false;
    private exitCode: number | null = null;
    private exitWaiters: Array<(code: number | null) => void> = [];
    private settleWaiters: Array<() => void> = [];
    private settleListeners = new Set<SettleListener>();
    private lastError: string | undefined;
    private aborted = false;

    readonly ring: RingEntry[] = [];
    readonly messages: unknown[] = [];
    readonly usage: RpcUsage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
    };
    model: string | undefined;
    stopReason: string | undefined;
    running = false;
    startedAt = Date.now();
    lastActivityAt = Date.now();

    readonly exit: Promise<number | null>;

    constructor(opts: {
        command: string;
        args: string[];
        cwd: string;
        env?: NodeJS.ProcessEnv;
        logPath: string;
    }) {
        this.logPath = opts.logPath;
        // Open the log ourselves (0600) rather than passing an fd: we need to
        // tee stdout into both the parser and the file.
        this.logFd = openSync(opts.logPath, "w", 0o600);
        this.proc = spawn(opts.command, opts.args, {
            cwd: opts.cwd,
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
            detached: true, // own process group → kill the tree, not just pi
            env: opts.env ?? process.env,
        });
        this.proc.unref();

        this.exit = new Promise<number | null>((resolve) => {
            const finish = (code: number | null) => {
                if (this.exited) return;
                this.exited = true;
                this.exitCode = code;
                this.flushBuffer();
                if (this.logFd !== undefined) {
                    try {
                        closeSync(this.logFd);
                    } catch {
                        /* already closed */
                    }
                    this.logFd = undefined;
                }
                // Release any waiters with final state.
                for (const w of this.exitWaiters) w(code);
                this.exitWaiters = [];
                for (const w of this.settleWaiters) w();
                this.settleWaiters = [];
                resolve(code);
            };
            this.proc.on("close", (code) => finish(code));
            this.proc.on("error", () => finish(1));
        });

        this.proc.stdout?.on("data", (data: Buffer) => {
            this.writeLog(data);
            this.buffer += data.toString("utf8");
            const lines = this.buffer.split("\n");
            this.buffer = lines.pop() ?? "";
            for (const line of lines) this.handleEventLine(line);
        });
        this.proc.stderr?.on("data", (data: Buffer) => {
            try {
                appendFileSync(this.logPath, `[stderr] ${data.toString("utf8")}`);
            } catch {
                /* log gone */
            }
        });
    }

    private flushBuffer(): void {
        if (this.buffer.trim()) {
            this.handleEventLine(this.buffer);
            this.buffer = "";
        }
    }

    private writeLog(data: Buffer): void {
        if (this.logFd === undefined) return;
        try {
            appendFileSync(this.logFd, data);
        } catch {
            /* disk/log issue — never break the stream */
        }
    }

    private pushRing(kind: RingEntry["kind"], text: string): void {
        if (!text.trim()) return;
        this.ring.push({ kind, text, at: Date.now() });
        if (this.ring.length > RING_LIMIT) this.ring.shift();
    }

    private handleEventLine(line: string): void {
        const trimmed = line.replace(/\r$/, "").trim();
        if (!trimmed) return;
        let ev: any;
        try {
            ev = JSON.parse(trimmed);
        } catch {
            return;
        }
        switch (ev?.type) {
            case "agent_start":
                this.running = true;
                this.lastActivityAt = Date.now();
                break;
            case "agent_settled":
                this.running = false;
                this.lastActivityAt = Date.now();
                {
                    const waiters = this.settleWaiters;
                    this.settleWaiters = [];
                    for (const w of waiters) w();
                    for (const l of this.settleListeners) {
                        try {
                            l();
                        } catch {
                            /* listener errors must not kill the stream */
                        }
                    }
                }
                break;
            case "message_end": {
                const msg = ev.message as any;
                if (!msg) break;
                this.messages.push(msg);
                this.lastActivityAt = Date.now();
                if (msg.role === "assistant") {
                    this.usage.turns++;
                    const u = msg.usage;
                    if (u) {
                        this.usage.input += u.input || 0;
                        this.usage.output += u.output || 0;
                        this.usage.cacheRead += u.cacheRead || 0;
                        this.usage.cacheWrite += u.cacheWrite || 0;
                        this.usage.cost += u.cost?.total || 0;
                        this.usage.contextTokens = u.totalTokens || this.usage.contextTokens;
                    }
                    if (!this.model && msg.model) this.model = msg.model;
                    if (msg.stopReason) this.stopReason = msg.stopReason;
                    if (msg.errorMessage) {
                        this.lastError = String(msg.errorMessage);
                        this.pushRing("system", `⚠ ${clip(this.lastError, 300)}`);
                    }
                    for (const part of (msg.content ?? []) as any[]) {
                        if (part?.type === "text" && part.text) this.pushRing("assistant", clip(part.text, 1500));
                        else if (part?.type === "toolCall" || part?.type === "tool_use") {
                            const name = part.name ?? part.toolName ?? "tool";
                            const args = JSON.stringify(part.arguments ?? part.input ?? {});
                            this.pushRing("tool", `→ ${name} ${clip(args, 140)}`);
                        }
                    }
                } else if (msg.role === "toolResult" || msg.role === "tool") {
                    this.pushRing("result", clip(messageText(msg.content), 240));
                } else if (msg.role === "user") {
                    this.pushRing("user", clip(messageText(msg.content), 240));
                }
                break;
            }
            case "extension_error":
                this.lastError = String(ev?.message ?? ev?.error ?? "extension error");
                this.pushRing("system", `⚠ extension_error: ${clip(this.lastError, 200)}`);
                break;
            default:
                break;
        }
    }

    /** Send a JSONL command to the child's stdin. Returns false when dead. */
    send(cmd: Record<string, unknown>): boolean {
        if (this.exited) return false;
        try {
            this.proc.stdin?.write(JSON.stringify(cmd) + "\n");
            return true;
        } catch {
            return false;
        }
    }

    prompt(message: string): boolean {
        // Optimistically mark running: agent_start arrives asynchronously, and
        // waitSettled() called right after must not see !running and resolve.
        this.running = true;
        this.lastActivityAt = Date.now();
        return this.send({ type: "prompt", message });
    }

    /** Queue mid-turn input (delivered between tool calls) or after settle. */
    continue_(message: string, mode: "steer" | "follow_up"): boolean {
        if (!this.running) {
            this.running = true;
            this.lastActivityAt = Date.now();
            return this.send({ type: "prompt", message });
        }
        if (mode === "steer") return this.send({ type: "steer", message });
        return this.send({ type: "follow_up", message });
    }

    abort(): boolean {
        return this.send({ type: "abort" });
    }

    /** Resolve when the child is fully settled (no retry/compaction/queue left). */
    waitSettled(timeoutMs: number, signal?: AbortSignal): Promise<"settled" | "exited" | "timeout" | "aborted"> {
        if (this.exited) return Promise.resolve("exited");
        if (!this.running && this.messages.length > 0) return Promise.resolve("settled");
        return new Promise((resolve) => {
            let done = false;
            const finish = (r: "settled" | "exited" | "timeout" | "aborted") => {
                if (done) return;
                done = true;
                clearTimeout(t);
                this.settleWaiters = this.settleWaiters.filter((w) => w !== onSettle);
                this.exitWaiters = this.exitWaiters.filter((w) => w !== onExit);
                signal?.removeEventListener("abort", onAbort);
                resolve(r);
            };
            const onSettle = () => finish("settled");
            const onExit = () => finish("exited");
            const onAbort = () => finish("aborted");
            const t = setTimeout(() => finish("timeout"), timeoutMs);
            t.unref();
            this.settleWaiters.push(onSettle);
            this.exitWaiters.push(onExit);
            signal?.addEventListener("abort", onAbort, { once: true });
        });
    }

    onExit(listener: ExitListener): void {
        void this.exit.then(listener);
    }

    onSettled(listener: SettleListener): () => void {
        this.settleListeners.add(listener);
        return () => this.settleListeners.delete(listener);
    }

    /** Terminate the whole process group. */
    kill(signal: NodeJS.Signals = "SIGTERM"): void {
        const pid = this.proc.pid;
        if (!pid) return;
        const fire = (sig: NodeJS.Signals) => {
            try {
                process.kill(-pid, sig);
            } catch {
                try {
                    process.kill(pid, sig);
                } catch {
                    /* already dead */
                }
            }
        };
        fire(signal);
        setTimeout(() => {
            if (this.proc.exitCode === null) fire("SIGKILL");
        }, 5000).unref();
    }

    getLastError(): string | undefined {
        return this.lastError;
    }

    /** Format the last `n` ring entries for a peek. */
    peek(n = 8): string {
        const items = this.ring.slice(-n);
        if (items.length === 0) return "(no activity yet)";
        const mark = { user: "•", assistant: "🤖", tool: " ", result: " ", system: "!" } as const;
        return items
            .map((it) => {
                const age = formatAge(Date.now() - it.at);
                const head = `${mark[it.kind]} [${it.kind} ${age}]`;
                return it.text
                    .split("\n")
                    .map((l, i) => (i === 0 ? `${head} ${l}` : `  ${l}`))
                    .join("\n");
            })
            .join("\n");
    }

    finalOutput(): string {
        for (let i = this.messages.length - 1; i >= 0; i--) {
            const m = this.messages[i] as { role?: string; content?: unknown };
            if (m?.role === "assistant") {
                const t = messageText(m.content);
                if (t.trim()) return t;
            }
        }
        return "";
    }

    alive(): boolean {
        return this.proc.exitCode === null && !this.proc.killed;
    }
}

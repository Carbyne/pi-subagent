/**
 * companion.ts — child-side half of the pi-subagent mailbox.
 *
 * Loaded into every spawned subagent via `--extension <abs path>` (see
 * index.ts). It is inert unless PI_SUBAGENT_TOKEN + PI_SUBAGENT_MAIL_SOCK
 * are set by the parent, so attaching it to unrelated pi runs costs nothing.
 *
 * Registers `ask_main_agent`: the subagent asks the delegating (main) agent
 * a question and BLOCKS until the answer arrives, a timeout expires, or the
 * tool call is aborted. Foreground runs get the question surfaced to the
 * user; background runs get it injected into the main agent's conversation
 * (see index.ts question routing).
 */

import * as fs from "node:fs";
import * as net from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_ASK_TIMEOUT_MS = 10 * 60 * 1000;

interface Pending {
    qid: number;
    resolve: (text: string) => void;
    reject: (err: Error) => void;
}

class MailboxClient {
    private socket: net.Socket | null = null;
    private buffer = "";
    private qid = 0;
    private pending = new Map<number, Pending>();

    constructor(
        private readonly sockPath: string,
        private readonly token: string
    ) {}

    private ensure(): Promise<void> {
        if (this.socket && !this.socket.destroyed) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const socket = net.createConnection(this.sockPath, () => {
                this.socket = socket;
                resolve();
            });
            socket.on("data", (data) => {
                this.buffer += data.toString("utf8");
                let idx: number;
                while ((idx = this.buffer.indexOf("\n")) >= 0) {
                    const line = this.buffer.slice(0, idx).replace(/\r$/, "").trim();
                    this.buffer = this.buffer.slice(idx + 1);
                    if (!line) continue;
                    let msg: any;
                    try {
                        msg = JSON.parse(line);
                    } catch {
                        continue;
                    }
                    if (msg?.type === "answer" && typeof msg.qid === "number") {
                        const p = this.pending.get(msg.qid);
                        if (p) {
                            this.pending.delete(msg.qid);
                            p.resolve(typeof msg.text === "string" ? msg.text : String(msg.text ?? ""));
                        }
                    }
                }
            });
            const dead = (err: Error) => {
                this.socket = null;
                for (const p of this.pending.values()) p.reject(err);
                this.pending.clear();
            };
            socket.on("error", (err) => dead(err instanceof Error ? err : new Error(String(err))));
            socket.on("close", () => dead(new Error("mailbox connection closed")));
        });
    }

    async ask(text: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
        await this.ensure();
        const id = ++this.qid;
        const promise = new Promise<string>((resolve, reject) => {
            this.pending.set(id, { qid: id, resolve, reject });
        });
        const send = () => {
            this.socket!.write(JSON.stringify({ type: "question", token: this.token, qid: id, text }) + "\n");
        };
        try {
            send();
        } catch {
            this.pending.delete(id);
            // Socket died between ensure and write — reconnect once.
            await this.ensure();
            send();
        }
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<string>((_, reject) => {
            timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
            timer.unref();
        });
        const abort = new Promise<string>((_, reject) => {
            signal?.addEventListener(
                "abort",
                () => {
                    this.pending.delete(id);
                    reject(new Error("aborted"));
                },
                { once: true }
            );
        });
        try {
            return await Promise.race([promise, timeout, abort]);
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            if (reason === "timeout") {
                return "(No answer received before the timeout — proceed with your best judgment and state the assumption you made.)";
            }
            if (reason === "aborted") throw new Error("aborted");
            throw err;
        } finally {
            if (timer) clearTimeout(timer);
            this.pending.delete(id);
        }
    }

    close(): void {
        try {
            this.socket?.destroy();
        } catch {
            /* ignore */
        }
        this.socket = null;
    }
}

export default function (pi: ExtensionAPI): void {
    const token = process.env.PI_SUBAGENT_TOKEN;
    const sockPath = process.env.PI_SUBAGENT_MAIL_SOCK;
    const parentName = process.env.PI_SUBAGENT_NAME ?? "subagent";
    const askTimeoutMs = Number(process.env.PI_SUBAGENT_ASK_TIMEOUT_MS ?? DEFAULT_ASK_TIMEOUT_MS);

    // Consume then scrub: anything this child spawns (nested subagents when
    // allowNesting is on) must NOT inherit our mailbox credentials — its
    // questions belong to ITS parent, not ours.
    delete process.env.PI_SUBAGENT_TOKEN;
    delete process.env.PI_SUBAGENT_MAIL_SOCK;
    delete process.env.PI_SUBAGENT_NAME;
    delete process.env.PI_SUBAGENT_ASK_TIMEOUT_MS;

    if (!token || !sockPath) return; // not spawned by pi-subagent → stay silent
    if (!fs.existsSync(sockPath)) return; // parent's hub is gone

    const client = new MailboxClient(sockPath, token);

    pi.registerTool({
        name: "ask_main_agent",
        label: "Ask Main Agent",
        description: [
            `Ask the delegating (main) agent "${parentName}" a question and block until it replies.`,
            "Use only when a judgment call genuinely blocks progress and the main agent (or its user)",
            "holds context you lack. Prefer deciding yourself for low-stakes choices — this waits.",
            "Returns a placeholder note if nobody answers before the timeout; then proceed with your",
            "best judgment and state the assumption you made.",
        ].join(" "),
        promptSnippet: "Ask the main agent a blocking question",
        promptGuidelines: [
            "ask_main_agent blocks until the main agent/user answers or the timeout expires — keep questions essential and specific.",
        ],
        parameters: Type.Object({
            question: Type.String({
                description: "The question for the main agent. Be specific; offer options when applicable.",
            }),
            timeoutMinutes: Type.Optional(
                Type.Number({ description: `Max minutes to wait (default ${askTimeoutMs / 60000}).` })
            ),
        }),
        async execute(_toolCallId, params, signal) {
            const timeoutMs = Math.max(1000, (params.timeoutMinutes ?? askTimeoutMs / 60000) * 60_000);
            try {
                const answer = await client.ask(String(params.question ?? ""), timeoutMs, signal);
                return {
                    content: [{ type: "text" as const, text: `Main agent replied:\n${answer}` }],
                    details: {},
                };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (msg === "aborted") throw new Error("aborted");
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `(Could not reach the main agent: ${msg} — proceed with your best judgment and state the assumption.)`,
                        },
                    ],
                    details: {},
                };
            }
        },
    });

    pi.on("session_shutdown", async () => {
        client.close();
    });
}

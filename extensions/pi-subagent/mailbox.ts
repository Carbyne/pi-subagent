/**
 * Mailbox hub — parent-side transport for subagent ⇄ main-agent messages.
 *
 * The parent pi process (the one running the `subagent` tool) hosts one unix
 * domain socket. Every spawned child — foreground or background — gets
 * PI_SUBAGENT_TOKEN + PI_SUBAGENT_MAIL_SOCK env vars and loads
 * companion.ts, which registers the `ask_main_agent` tool. Questions arrive
 * as JSONL on the socket; the parent routes them to the run's handler and
 * later writes the answer back on the same connection.
 *
 * Protocol (line-delimited JSON):
 *   child → parent: { "type": "question", "token": "...", "qid": 1, "text": "..." }
 *   parent → child: { "type": "answer",   "qid": 1, "text": "..." }
 *
 * The token gates routing: a connection that never presents a registered
 * token is ignored. Sockets may outlive the run (child killed) — writes are
 * best-effort.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";

export interface IncomingQuestion {
    qid: number;
    text: string;
}

export type QuestionHandler = (q: IncomingQuestion, respond: (text: string) => boolean) => void;

interface Route {
    onQuestion: QuestionHandler;
    sockets: Set<net.Socket>;
}

export class MailboxHub {
    private server: net.Server | null = null;
    private routes = new Map<string, Route>();
    private sockPath: string | null = null;
    private dir: string;

    constructor() {
        const uid = (process as unknown as { uid?: number }).uid ?? os.userInfo().uid ?? 0;
        this.dir = path.join(os.tmpdir(), `pi-subagent-mail-${uid}`);
    }

    get socketPath(): string | null {
        return this.sockPath;
    }

    /** Create the listening socket lazily. Returns false when unavailable
     *  (no AF_UNIX support, permissions) — callers degrade gracefully. */
    ensureServer(): boolean {
        if (this.server) return true;
        try {
            fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
            // Stale sockets from crashed parents would block listen(); sweep
            // anything older than a day (own uid dir, safe to unlink).
            try {
                const now = Date.now();
                for (const name of fs.readdirSync(this.dir)) {
                    if (!name.endsWith(".sock")) continue;
                    const p = path.join(this.dir, name);
                    try {
                        const st = fs.statSync(p);
                        if (now - st.mtimeMs > 86_400_000) fs.unlinkSync(p);
                    } catch {
                        /* raced */
                    }
                }
            } catch {
                /* sweep is best-effort */
            }
            const sockPath = path.join(this.dir, `parent-${process.pid}.sock`);
            try {
                fs.unlinkSync(sockPath);
            } catch {
                /* not present */
            }
            const server = net.createServer((socket) => this.onConnection(socket));
            server.listen(sockPath);
            try {
                fs.chmodSync(sockPath, 0o600);
            } catch {
                /* best-effort */
            }
            this.server = server;
            this.sockPath = sockPath;
            return true;
        } catch {
            this.server = null;
            this.sockPath = null;
            return false;
        }
    }

    private onConnection(socket: net.Socket): void {
        let buffer = "";
        let token: string | undefined;
        socket.on("data", (data) => {
            buffer += data.toString("utf8");
            let idx: number;
            while ((idx = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, idx).replace(/\r$/, "").trim();
                buffer = buffer.slice(idx + 1);
                if (!line) continue;
                let msg: any;
                try {
                    msg = JSON.parse(line);
                } catch {
                    continue;
                }
                if (typeof msg?.token === "string") token = msg.token;
                if (!token) continue; // unauthenticated chatter
                const route = this.routes.get(token);
                if (!route) continue;
                if (msg.type === "question" && typeof msg.qid === "number" && typeof msg.text === "string") {
                    route.sockets.add(socket);
                    try {
                        route.onQuestion({ qid: msg.qid, text: msg.text }, (answer) =>
                            this.respond(token!, msg.qid, answer)
                        );
                    } catch {
                        /* handler must not kill the connection */
                    }
                }
            }
        });
        socket.on("error", () => socket.destroy());
        socket.on("close", () => {
            for (const route of this.routes.values()) route.sockets.delete(socket);
        });
    }

    /** Register (or replace) the question handler for a run token. */
    register(token: string, onQuestion: QuestionHandler): () => void {
        this.routes.set(token, { onQuestion, sockets: new Set() });
        return () => this.routes.delete(token);
    }

    unregister(token: string): void {
        const route = this.routes.get(token);
        if (!route) return;
        for (const s of route.sockets) {
            try {
                s.destroy();
            } catch {
                /* already gone */
            }
        }
        this.routes.delete(token);
    }

    /** Deliver an answer to a pending question. Returns false when the
     *  child's connection is gone (it timed out / crashed). */
    respond(token: string, qid: number, text: string): boolean {
        const route = this.routes.get(token);
        if (!route || route.sockets.size === 0) return false;
        const line = JSON.stringify({ type: "answer", qid, text }) + "\n";
        let delivered = false;
        for (const socket of route.sockets) {
            try {
                socket.write(line);
                delivered = true;
            } catch {
                route.sockets.delete(socket);
            }
        }
        return delivered;
    }

    /** Drop a dead run's route once its process is gone. */
    dispose(): void {
        try {
            this.server?.close();
        } catch {
            /* ignore */
        }
        if (this.sockPath) {
            try {
                fs.unlinkSync(this.sockPath);
            } catch {
                /* ignore */
            }
        }
        this.server = null;
        this.sockPath = null;
        this.routes.clear();
    }
}

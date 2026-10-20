/**
 * Runtime E2E battery — tests the INSTALLED extensions (pi update state),
 * loading real packages like a normal session.
 *
 * T1: ralph-loop — /ralph-config while inactive + resume + no extension errors
 * T2: subagent   — background launch, bg-jobs adoption, ask_main_agent → reply, completion
 * T3: agent-steer — unit-style: input intercept, q/a queueing, /unqueue, compaction deferral
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: Record<string, boolean | string> = {};

async function rpcSession(extraArgs: string[], tag: string) {
    const log = `/tmp/rt-${tag}.log`;
    fs.writeFileSync(log, "");
    const child = spawn("pi", ["--mode", "rpc", "--no-session", ...extraArgs], {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: "/home/jakob/git_projects",
    });
    const events: any[] = [];
    let buf = "";
    child.stdout.on("data", (d) => {
        buf += d.toString();
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).replace(/\r$/, "");
            buf = buf.slice(i + 1);
            fs.appendFileSync(log, line + "\n");
            if (!line.trim()) continue;
            try {
                events.push(JSON.parse(line));
            } catch {
                /* noise */
            }
        }
    });
    child.stderr.on("data", (d) => fs.appendFileSync(log, `[stderr] ${d}`));
    const send = (o: Record<string, unknown>) => child.stdin.write(JSON.stringify(o) + "\n");
    const stop = () => {
        try {
            child.kill("SIGTERM");
        } catch {
            /* dead */
        }
    };
    return { child, events, send, stop, log };
}

// ── T1: ralph-loop ────────────────────────────────────────────────────────────
async function t1() {
    const s = await rpcSession(["--thinking", "off"], "ralph");
    s.send({ type: "prompt", message: "/ralph-config --max 5 --delay 1s installed-ralph-test" });
    await sleep(3500);
    const notifyTexts = () =>
        s.events
            .filter((e) => e.type === "extension_ui_request" && e.method === "notify")
            .map((e) => e.message ?? "")
            .join("\n");
    results["T1 config-while-inactive"] = /config saved \(loop not active/.test(notifyTexts());
    s.send({ type: "prompt", message: "/ralph-resume" });
    await sleep(7000);
    results["T1 resumed"] = /Ralph loop resumed at iteration/.test(notifyTexts());
    results["T1 followup-fired"] = s.events.some(
        (e) => e.type === "message_start" && e.message?.role === "user" && /\[ralph-loop\]/.test(JSON.stringify(e.message.content ?? ""))
    );
    s.send({ type: "prompt", message: "/ralph-stop" });
    await sleep(2000);
    results["T1 no-extension-errors"] = !s.events.some(
        (e) => e.type === "extension_error" && !/No API key/.test(JSON.stringify(e))
    );
    s.stop();
    await sleep(1000);
}

// ── T2: background subagent (installed) ───────────────────────────────────────
async function t2() {
    const s = await rpcSession(["--thinking", "off"], "subagent");
    const seen = { launched: false, adopted: false, question: false, reply: false, completion: false };
    s.send({
        type: "prompt",
        message:
            "Call the `subagent` tool exactly ONCE with: agent=\"worker\", background=true, name=\"painter\", " +
            "task=\"Use the ask_main_agent tool to ask the main agent which color to use (offer RED, GREEN, BLUE). " +
            "When the answer arrives, print exactly COLOR=<answer> as your final reply.\". " +
            "Then reply LAUNCHED <id> and stop. Later, when a message says a subagent is asking, call the " +
            "subagent_control tool with action=\"reply\", its id, and text=\"GREEN\". After the completion notice arrives, reply DONE.",
    });
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
        await sleep(2500);
        for (const e of s.events) {
            if (e.type !== "message_end" || !e.message) continue;
            const m = e.message;
            const text = JSON.stringify(m.content ?? "");
            if ((m.role === "toolResult" || m.role === "tool")) {
                if (/sa-\d+-\d+/.test(text)) seen.launched = true;
                if (/bg-jobs: job-|· bg-jobs/.test(text)) seen.adopted = true;
            }
            if (m.role === "assistant" && m.content) {
                for (const part of m.content as any[]) {
                    if ((part.type === "toolCall" || part.type === "tool_use") && part.name === "subagent_control") {
                        if (/"reply"/.test(JSON.stringify(part.arguments ?? part.input ?? {}))) seen.reply = true;
                    }
                }
            }
            if (m.role !== "assistant" && m.role !== "toolResult" && m.role !== "tool" && /is asking/.test(text)) seen.question = true;
            if (m.role !== "assistant" && /COLOR=GREEN/.test(text) && /Background subagent/.test(text)) seen.completion = true;
        }
        if (Object.values(seen).every(Boolean)) break;
    }
    for (const [k, v] of Object.entries(seen)) results[`T2 ${k}`] = v;
    s.stop();
    await sleep(1000);
}

// ── T3: agent-steer (mock harness) ────────────────────────────────────────────
async function t3() {
    const { createJiti } = await import(
        "/home/jakob/git_projects/pi-subagent/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs"
    );
    const DEV = "/home/jakob/git_projects";
    const jiti = createJiti(import.meta.url, {
        alias: {
            "@earendil-works/pi-tui": `${DEV}/pi-agent-steer/node_modules/@earendil-works/pi-tui`,
            "@earendil-works/pi-coding-agent": `${DEV}/pi-agent-steer/node_modules/@earendil-works/pi-coding-agent`,
            "typebox": `${DEV}/pi-subagent/node_modules/typebox`,
        },
    });
    const mod = await jiti.import("/home/jakob/.pi/agent/git/github.com/Carbyne/pi-agent-steer/src/index.ts");

    const handlers: Record<string, Array<Function>> = {};
    const sent: Array<{ text: string; opts?: any }> = [];
    const status: Array<string | undefined> = [];
    const notifies: string[] = [];
    const commands: Record<string, Function> = {};
    const bus: Record<string, Array<Function>> = {};
    let idle = false;
    let harnessCompacting = false;
    let rejectOnce: string | undefined;

    const pi: any = {
        on(ev: string, fn: Function) {
            (handlers[ev] ??= []).push(fn);
        },
        registerCommand(name: string, opts: any) {
            commands[name] = opts.handler;
        },
        sendUserMessage(text: string, opts?: any) {
            if (harnessCompacting && /force-compact-on-send/.test(text))
                return Promise.reject(new Error("Cannot submit a prompt while compaction is in progress"));
            if (rejectOnce === text) {
                rejectOnce = undefined;
                return Promise.reject(new Error("Agent is not idle (completion notice raced the send)"));
            }
            sent.push({ text, opts });
            return Promise.resolve();
        },
        events: {
            on(ev: string, fn: Function) {
                (bus[ev] ??= []).push(fn);
            },
            emit() {
                /* no bg-jobs in harness */
            },
        },
    };
    mod.default(pi);

    const fixture = "/tmp/steer-fixture";
    fs.mkdirSync(`${fixture}/.pi`, { recursive: true });
    fs.writeFileSync(`${fixture}/.pi/settings.json`, JSON.stringify({ agentSteer: { } }));
    const ctx: any = {
        cwd: fixture,
        hasUI: true,
        isIdle: () => idle,
        ui: {
            custom: (factory: Function) =>
                new Promise((resolve) => {
                    const component = factory({}, { fg: (_c: string, t: string) => t }, {}, resolve);
                    (globalThis as any).__steerComponent = component;
                }),
            notify: (m: string) => notifies.push(m),
            setEditorText: (t: string) => ((globalThis as any).__editorText = t),
            setStatus: (_k: string, v?: string) => status.push(v),
        },
    };
    const fire = async (ev: string, event: any, context = ctx) => {
        for (const fn of handlers[ev] ?? []) await fn(event, context);
    };

    await fire("session_start", {});

    async function submit(text: string, key?: string) {
        (globalThis as any).__steerComponent = undefined;
        const ps = (handlers["input"] ?? []).map((fn) => fn({ source: "interactive", text }, ctx));
        await sleep(100); // let the modal component get constructed
        if (key) (globalThis as any).__steerComponent?.handleInput(key);
        return await Promise.all(ps);
    }

    /** Poll until the extension delivers `text` (nudging settle so the
     *  watchdog/flush keeps trying). Robust against grace + serialized
     *  multi-item flushes, unlike fixed sleeps. */
    async function expectSent(text: string, timeoutMs = 9000): Promise<boolean> {
        const t0 = Date.now();
        while (Date.now() - t0 < timeoutMs) {
            if (sent.some((m) => m.text === text)) return true;
            await fire("agent_settled", {});
            await sleep(400);
        }
        return sent.some((m) => m.text === text);
    }
    async function expectNotSent(text: string, ms: number): Promise<boolean> {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
            if (sent.some((m) => m.text === text)) return false;
            await fire("agent_settled", {});
            await sleep(150);
        }
        return true;
    }

    // 1) idle pass-through
    idle = true;
    let rs = await submit("hello while idle");
    results["T3 idle passthrough"] = rs.some((x: any) => x?.action === "continue");

    // 2) busy + choose 'q' → extension queue, not core queue
    idle = false;
    rs = await submit("queued msg", "q");
    results["T3 queue not core-queued"] =
        sent.length === 0 && rs.some((x: any) => x?.action === "handled") && status.some((v) => v && /queued/.test(v));

    // 3) settle → deliver via sendUserMessage WITHOUT deliverAs (no core queue widget)
    idle = true;
    results["T3 flush on settle"] =
        (await expectSent("queued msg")) && sent.some((m) => m.text === "queued msg" && !m.opts?.deliverAs);

    // 4) 'a' waits for bg jobs
    idle = false;
    await submit("idle-only msg", "a");
    for (const fn of bus["bg-jobs:status"]) fn({ running: 1, jobs: [] });
    idle = true;
    results["T3 waitidle held by bg"] = await expectNotSent("idle-only msg", 1200);
    for (const fn of bus["bg-jobs:status"]) fn({ running: 0, jobs: [] });
    results["T3 waitidle delivered after bg"] = await expectSent("idle-only msg");

    // 5) compaction: steer choice parks instead of erroring; drains after compact
    idle = false;
    harnessCompacting = true;
    await fire("session_before_compact", {});
    await submit("force-compact-on-send please", "s");
    results["T3 compaction park"] = sent.every((m) => m.text !== "force-compact-on-send please");
    harnessCompacting = false;
    await fire("session_compact", {});
    idle = true;
    results["T3 compaction drain"] = await expectSent("force-compact-on-send please");

    // 5b) /queue + /idlequeue commands bypass the prompt
    idle = false;
    await commands["queue"]("cmd-queue msg", ctx);
    results["T3 /queue enqueues"] =
        !sent.some((m) => m.text === "cmd-queue msg") && status.some((v) => v && /queued/.test(v));
    await commands["idlequeue"]("cmd-idle msg", ctx);
    for (const fn of bus["bg-jobs:status"]) fn({ running: 1, jobs: [] });
    idle = true;
    results["T3 /queue delivers"] = await expectSent("cmd-queue msg");
    results["T3 /idlequeue held by bg"] = await expectNotSent("cmd-idle msg", 1200);
    for (const fn of bus["bg-jobs:status"]) fn({ running: 0, jobs: [] });
    results["T3 /idlequeue delivers after bg"] = await expectSent("cmd-idle msg");

    // 5c) promptWhenIdleWithBg: idle agent + bg jobs → prompt appears
    idle = true;
    for (const fn of bus["bg-jobs:status"]) fn({ running: 2, jobs: [] });
    let rs7 = await submit("bg-idle prompt msg", "a");
    results["T3 idle+bg prompts"] = rs7.some((x: any) => x?.action === "handled");
    results["T3 idle+bg a held"] = await expectNotSent("bg-idle prompt msg", 800);
    for (const fn of bus["bg-jobs:status"]) fn({ running: 0, jobs: [] });
    results["T3 idle+bg a delivers"] = await expectSent("bg-idle prompt msg");
    for (const fn of bus["bg-jobs:status"]) fn({ running: 2, jobs: [] });
    await submit("send-now msg", "s");
    results["T3 idle+bg s sends now"] = sent.some((m) => m.text === "send-now msg");
    // idle with no bg jobs → normal pass-through, no prompt
    for (const fn of bus["bg-jobs:status"]) fn({ running: 0, jobs: [] });
    await sleep(1200);
    const rs8 = await submit("plain idle msg");
    results["T3 idle-no-bg passthrough"] = rs8.some((x: any) => x?.action === "continue");

    // 5d) waitidle grace: bg-jobs status flips to 0 IMMEDIATELY but its
    // completion notice comes ~coalesceMs later — delivery must not jump it.
    idle = true;
    for (const fn of bus["bg-jobs:status"]) fn({ running: 1, jobs: [] });
    await commands["idlequeue"]("grace race msg", ctx);
    for (const fn of bus["bg-jobs:status"]) fn({ running: 0, jobs: [] }); // drain now
    results["T3 waitidle respects grace"] = await expectNotSent("grace race msg", 600);
    results["T3 waitidle delivers after grace"] = await expectSent("grace race msg");

    // 5e) notice wakes agent (busy turn) → delivery additionally waits for settle
    for (const fn of bus["bg-jobs:status"]) fn({ running: 1, jobs: [] });
    await commands["idlequeue"]("notice first msg", ctx);
    for (const fn of bus["bg-jobs:status"]) fn({ running: 0, jobs: [] });
    await sleep(300);
    idle = false; // the coalesced completion notice starts a turn
    results["T3 no delivery during notice turn"] = await expectNotSent("notice first msg", 1400); // grace elapses mid-turn
    idle = true;
    await fire("agent_settled", {});
    results["T3 delivers after notice turn settles"] = await expectSent("notice first msg");

    // 5f) async send rejection must NOT lose the item (the exact
    //     "prompts vanish while bg jobs run" bug: bg-jobs' coalesced notice
    //     starts a turn between isIdle() and sendUserMessage → reject).
    idle = true;
    rejectOnce = "async reject msg";
    await commands["queue"]("async reject msg", ctx);
    await sleep(600); // give the (rejected) send a chance to swallow it
    results["T3 async reject keeps item queued"] =
        !sent.some((m) => m.text === "async reject msg") && status.some((v) => v && /1 queued/.test(v));
    results["T3 async reject retried to delivery"] = await expectSent("async reject msg", 12000);

    // 6) /unqueue restores to editor
    idle = false;
    await submit("recall me", "q");
    await sleep(200);
    await commands["unqueue"]("", ctx);
    results["T3 unqueue to editor"] = (globalThis as any).__editorText === "recall me";
}

// ── run ───────────────────────────────────────────────────────────────────────
console.log("── T1 ralph-loop (installed)");
if (!process.env.SKIP_T12) {
    await t1();
    console.log(JSON.stringify(results, null, 0));
    console.log("── T2 background subagent (installed)");
    await t2();
    console.log(JSON.stringify(results, null, 0));
}
console.log("── T3 agent-steer (installed, harness)");
await t3();
console.log(JSON.stringify(results, null, 0));
const fails = Object.entries(results).filter(([, v]) => v !== true);
console.log(fails.length === 0 ? "ALL TESTS PASS" : `FAILURES: ${fails.map(([k]) => k).join(", ")}`);
process.exit(fails.length === 0 ? 0 : 1);

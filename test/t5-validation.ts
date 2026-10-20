/**
 * T5: mode-validation UX — agent-without-task must return the helpful
 * modeError text (not "Invalid parameters. Provide exactly one mode."), and
 * task-without-agent must auto-run on worker.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = "/tmp/rt-t5.log";
fs.writeFileSync(log, "");
const child = spawn("pi", ["--mode", "rpc", "--no-session", "--thinking", "off"], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: "/tmp",
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
const toolResults = () =>
    events
        .filter((e) => e.type === "message_end" && (e.message?.role === "toolResult" || e.message?.role === "tool"))
        .map((e) => JSON.stringify(e.message?.content ?? ""));

// 1) deliberate bad call: agent only, no task
send({
    type: "prompt",
    message:
        "Call the subagent tool exactly once passing ONLY { agent: \"worker\" } with NO task key. " +
        "Then report the tool's error text verbatim, then stop.",
});
const t1 = Date.now();
while (Date.now() - t1 < 90_000 && !toolResults().some((t) => /requires BOTH/.test(t))) await sleep(1500);
const goodErr = toolResults().some(
    (t) => /you passed `agent` without `task`/.test(t) && /single:/.test(t) && /Available agents/.test(t)
);
console.log("helpful error:", goodErr);

// 2) task without agent → auto worker (should just run and return output)
send({
    type: "prompt",
    message:
        "Call the subagent tool exactly once passing ONLY { task: \"Reply with exactly AUTO-WORKER-OK\" } with no agent key. " +
        "Report the result, then stop.",
});
const t2 = Date.now();
while (Date.now() - t2 < 120_000 && !toolResults().some((t) => /AUTO-WORKER-OK/.test(t))) await sleep(1500);
const auto = toolResults().some((t) => /AUTO-WORKER-OK/.test(t));
console.log("auto-worker:", auto);

child.kill("SIGTERM");
await sleep(800);
console.log(goodErr && auto ? "T5 PASS" : "T5 FAIL");
process.exit(goodErr && auto ? 0 : 1);

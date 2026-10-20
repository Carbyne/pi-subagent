/**
 * T4 (v2): ralph-loop must hold follow-ups while an adopted background
 * subagent job runs, then resume after it settles.
 * Deterministic: /ralph driven as raw rpc extension-command prompts.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = "/tmp/rt-t4.log";
fs.writeFileSync(log, "");

const child = spawn("pi", ["--mode", "rpc", "--no-session", "--thinking", "off", "-xt", "read,grep,find"], {
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

const ralphFires = () =>
    events.filter(
        (e) =>
            e.type === "message_start" &&
            e.message?.role === "user" &&
            /\[ralph-loop\]/.test(JSON.stringify(e.message.content ?? ""))
    ).length;
const anyText = (re: RegExp) => events.some((e) => re.test(JSON.stringify(e)));

// 1) launch the background subagent (long bash sleep inside the worker)
send({
    type: "prompt",
    message:
        "Call the subagent tool exactly once with agent=\"worker\", background=true, and task=" +
        "\"Run the bash command: sleep 25 ; then reply exactly SLEPT-DONE\". Use no other tools. Reply LAUNCHED when it starts.",
});
const tLaunch = Date.now();
while (Date.now() - tLaunch < 120_000 && !anyText(/sa-\d+-\d+/)) await sleep(1500);
const launched = anyText(/sa-\d+-\d+/);
console.log("launched:", launched);
if (!launched) {
    child.kill("SIGTERM");
    console.log("T4 FAIL (launch)");
    process.exit(1);
}
await sleep(2000); // let the worker settle into its bash call

// 2) start ralph with an aggressive 1s delay — if waiting is broken it would
//    spam a follow-up every second while the 25s job runs.
send({ type: "prompt", message: "/ralph --max 2 --delay 1s --job-grace 2s T4 standing order" });
await sleep(1500);
const ralphStarted = anyText(/Ralph loop started/);
console.log("ralph started:", ralphStarted);

// 3) observe a 12s window while the job must still be running
const before = ralphFires();
await sleep(12_000);
const during = ralphFires() - before;
console.log("ralph fires during job window:", during);

// 4) wait for the completion notice, then ralph must resume and fire
const tDone = Date.now();
while (Date.now() - tDone < 90_000 && !anyText(/finished round|Background subagent .* (exited|was terminated)/)) await sleep(2000);
const gotCompletion = anyText(/finished round|Background subagent/);
const tResume = Date.now();
while (Date.now() - tResume < 45_000 && ralphFires() <= before) await sleep(2000);
const after = ralphFires() - before;
console.log("completion notice:", gotCompletion, "| ralph fires after settle:", after);

send({ type: "prompt", message: "/ralph-stop" });
await sleep(1500);
child.kill("SIGTERM");
await sleep(800);

const pass = launched && ralphStarted && gotCompletion && during === 0 && after >= 1;
console.log(JSON.stringify({ launched, ralphStarted, during, gotCompletion, after }));
console.log(pass ? "T4 PASS" : "T4 FAIL");
process.exit(pass ? 0 : 1);

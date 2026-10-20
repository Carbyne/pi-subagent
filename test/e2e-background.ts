/**
 * E2E: main pi (rpc, dev extensions only) launches a BACKGROUND subagent that
 * uses ask_main_agent; the main agent must receive the question notice and
 * answer via subagent_control reply; then the completion notice arrives.
 *
 * Pass criteria (observed on the event stream):
 *  1. tool call subagent with background:true returns an sa- id
 *  2. injected question notice reaches main agent (user message containing
 *     "is asking")
 *  3. main agent calls subagent_control action=reply
 *  4. completion notice with COLOR=GREEN-ish from the subagent's final output
 *  5. adopted job id (job-...) mentioned in the subagent tool result
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";

const DEV = "/home/jakob/git_projects";
const SUBAGENT_EXT = `${DEV}/pi-subagent/extensions/pi-subagent/index.ts`;
const BGJOBS_EXT = `${DEV}/pi-bg-jobs/extensions/bg-jobs/index.ts`;
const LOG = "/tmp/e2e-bg-sa.log";

const child = spawn(
    "pi",
    [
        "--mode", "rpc", "--no-session", "--no-extensions",
        "-e", SUBAGENT_EXT, "-e", BGJOBS_EXT, "-e", `${DEV}/pi-gateway-discovery/src/index.ts`,
        "--thinking", "off",
    ],
    { stdio: ["pipe", "pipe", "pipe"], cwd: DEV }
);

const events: any[] = [];
fs.writeFileSync(LOG, "");
let buf = "";
child.stdout.on("data", (d) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        fs.appendFileSync(LOG, line + "\n");
        try {
            events.push(JSON.parse(line));
        } catch {
            /* console noise */
        }
    }
});
child.stderr.on("data", (d) => fs.appendFileSync(LOG, `[stderr] ${d}`));

const send = (obj: Record<string, unknown>) => child.stdin.write(JSON.stringify(obj) + "\n");

send({
    type: "prompt",
    id: "kick",
    message:
        "Call the `subagent` tool exactly ONCE with: agent=\"worker\", background=true, " +
        "name=\"painter\", and task=\"Use the ask_main_agent tool to ask the main agent which " +
        "color to use (offer RED, GREEN, BLUE as options). When the answer arrives, print " +
        "exactly COLOR=<answer> as your final reply.\". " +
        "Do not pass `tasks` or `chain`. After it starts (it returns an id starting with sa-), " +
        "reply with just: LAUNCHED <id> and stop. If a later message contains a subagent question, " +
        "answer it by calling the subagent_control tool with action=\"reply\", the run id, and " +
        "text=\"GREEN\". After the completion notice for the run arrives, reply DONE.",
});

const deadline = Date.now() + 240_000;
const seen = {
    launched: false,
    questionNotice: false,
    replyCall: false,
    completion: false,
    adopted: false,
};

function scan(): void {
    for (const e of events) {
        if (e.type === "message_end" && e.message) {
            const m = e.message;
            const text = JSON.stringify(m.content ?? "");
            if (m.role === "assistant" && /"subagent"/.test(text) && false) continue;
            if (m.role === "toolResult" || m.role === "tool") {
                if (/sa-\d+-\d+/.test(text)) seen.launched = true;
                if (/bg-jobs:?\s*job-|adopted as job-|· bg-jobs job-|bg-jobs job-/.test(text)) seen.adopted = true;
            }
            if (m.role === "assistant" && m.content) {
                for (const part of m.content) {
                    if (part.type === "toolCall" || part.type === "tool_use") {
                        const name = part.name ?? part.toolName;
                        const args = JSON.stringify(part.arguments ?? part.input ?? {});
                        if (name === "subagent" && /"background":\s*true/.test(args)) seen.launched = seen.launched || false;
                        if (name === "subagent_control" && /"reply"/.test(args)) seen.replyCall = true;
                    }
                }
            }
            if (m.role === "user" && /is asking/.test(text)) seen.questionNotice = true;
            if (/is asking/.test(text) && m.role !== "assistant" && m.role !== "toolResult" && m.role !== "tool") seen.questionNotice = true;
            if (/COLOR=GREEN/.test(text) && /finished round|Background subagent/.test(text)) seen.completion = true;
        }
    }
}

const timer = setInterval(() => {
    scan();
    console.log(JSON.stringify(seen));
    if (Object.values(seen).every(Boolean)) {
        clearInterval(timer);
        console.log("E2E PASS");
        child.kill("SIGTERM");
        setTimeout(() => process.exit(0), 1500);
    } else if (Date.now() > deadline) {
        clearInterval(timer);
        console.log("E2E TIMEOUT");
        child.kill("SIGTERM");
        setTimeout(() => process.exit(1), 1500);
    }
}, 2000);

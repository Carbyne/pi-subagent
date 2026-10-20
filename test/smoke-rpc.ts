/**
 * Smoke test: RpcSubagent + companion.ts mailbox round-trip.
 * Spawns a real pi child in rpc mode with the companion extension and:
 *  1. asks it to use ask_main_agent (we answer "the color BLUE")
 *  2. verifies the final output mentions BLUE
 *  3. sends a follow-up prompt ("say DONE-2") and verifies settle events
 */
import { RpcSubagent } from "../extensions/pi-subagent/rpc.ts";
import { MailboxHub } from "../extensions/pi-subagent/mailbox.ts";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

const EXT_DIR = path.dirname(new URL(import.meta.url).pathname);
const COMPANION = path.join(EXT_DIR, "..", "extensions", "pi-subagent", "companion.ts");
const LOG_DIR = path.join(os.tmpdir(), "pi-subagent-smoke");
fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });

const hub = new MailboxHub();
if (!hub.ensureServer()) throw new Error("mailbox hub failed to start");
console.log("hub socket:", hub.socketPath);

const token = "smoke-token-1";
let questionSeen: string | null = null;
hub.register(token, (q, respond) => {
    questionSeen = q.text;
    console.log("Q from child:", q.text);
    respond("The color is BLUE. Use it verbatim.");
    return true;
});

const args = [
    "--mode", "rpc", "--no-session", "--no-themes", "--no-prompt-templates",
    "--exclude-tools", "subagent,search_subagent,subagent_control,bash,edit,write",
    "--extension", COMPANION,
];
const env = {
    ...process.env,
    PI_SUBAGENT_TOKEN: token,
    PI_SUBAGENT_MAIL_SOCK: hub.socketPath!,
    PI_SUBAGENT_NAME: "smoketest",
    PI_SUBAGENT_ASK_TIMEOUT_MS: "60000",
};

const rpc = new RpcSubagent({
    command: "pi",
    args,
    cwd: EXT_DIR,
    env,
    logPath: path.join(LOG_DIR, "smoke1.log"),
});

let settles = 0;
rpc.onSettled(() => { settles++; console.log("settled, count:", settles); });

rpc.prompt(
    "Use the ask_main_agent tool to ask the main agent: 'What color should I use?'. " +
    "When it answers, reply with exactly: CHOSEN=<color> and nothing else."
);

const outcome = await rpc.waitSettled(120_000);
console.log("first settle outcome:", outcome);
const out1 = rpc.finalOutput();
console.log("child output 1:", JSON.stringify(out1));

// Follow-up round
rpc.continue_("Reply with exactly: DONE-2", "follow_up");
const outcome2 = await rpc.waitSettled(60_000);
const out2 = rpc.finalOutput();
console.log("child output 2:", JSON.stringify(out2));

rpc.kill();
await rpc.exit;

const ok =
    questionSeen !== null &&
    /BLUE/.test(out1) &&
    /DONE-2/.test(out2) &&
    settles >= 2;
console.log(ok ? "SMOKE PASS" : "SMOKE FAIL");
process.exit(ok ? 0 : 1);

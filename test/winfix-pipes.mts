import { StringDecoder } from "node:string_decoder";
import * as net from "node:net";
import * as fs from "node:fs";
const { createJiti } = await import("/home/jakob/git_projects/pi-subagent/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs");
const RT = process.env.PI_SUBAGENT_DEV ?? "/home/jakob/git_projects";
const jiti = createJiti(import.meta.url, { alias: {
  "@earendil-works/pi-coding-agent": "/home/jakob/git_projects/pi-subagent/node_modules/@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui": "/home/jakob/git_projects/pi-subagent/node_modules/@earendil-works/pi-tui",
  "typebox": "/home/jakob/git_projects/pi-subagent/node_modules/typebox/build/index.mjs",
}});
let uncaught: any = null;
process.on("uncaughtException", (e) => { uncaught = e; console.log("SWALLOWED-UNCAUGHT:", e && e.stack || e); });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let ok = true; const log = (n: string, c: boolean) => { ok &&= c; console.log(`${c ? "PASS" : "FAIL"} ${n}`); };

try { console.log('-- A');
// ── A: huge stdin write to a dead child must NOT raise async EPIPE → uncaught ──
{
  const { RpcSubagent } = await jiti.import(`${RT}/pi-subagent/extensions/pi-subagent/rpc.ts`);
  const rpc = new RpcSubagent({ command: "node", args: ["-e", "setTimeout(()=>{},60000)"], cwd: "/tmp", logPath: "/tmp/rpc-epipe.log" });
  await sleep(400);
  rpc.proc.kill("SIGKILL");
  await sleep(300);
  const big = { type: "prompt", message: "🚨x".repeat(500_000) }; // ~2MB multi-byte
  for (let i = 0; i < 5 && !rpc.exited; i++) rpc.send(big);
  await sleep(1500);
  log("A: dead-child 2MB stdin writes → no uncaughtException", uncaught === null);
}

} catch (e) { ok = false; console.log('A THREW:', e && e.stack || e); }
try { console.log('-- B');
// ── B: mailbox question, multi-byte split across chunk boundaries ──
{
  const { MailboxHub } = await jiti.import(`${RT}/pi-subagent/extensions/pi-subagent/mailbox.ts`);
  const hub = new MailboxHub();
  log("B: hub server up", hub.ensureServer() === true);
  const text = "Ünïcödé 🚨 emoji ".repeat(30_000); // ~780KB, multi-byte heavy
  const line = JSON.stringify({ type: "question", token: "tok-A", qid: 7, text }) + "\n";
  const buf = Buffer.from(line, "utf8");
  let received: string | null = null;
  hub.register("tok-A", (q, respond) => { received = q.text; respond("ANSWERED"); });
  const client = net.createConnection(hub.socketPath!);
  await new Promise(r => client.on("connect", r));
  // Split deliberately INSIDE multi-byte sequences: pick a byte offset that
  // lands mid-emoji, then dribble 32KB chunks.
  const emojiAt = buf.indexOf(Buffer.from("🚨", "utf8"));
  const cut1 = emojiAt + 1; // mid-sequence of the first emoji we send after connect
  const chunkA = buf.subarray(0, cut1);
  const rest = buf.subarray(cut1);
  client.write(chunkA); await sleep(50);
  for (let o = 0; o < rest.length; o += 32768) { client.write(rest.subarray(o, o + 32768)); await sleep(20); }
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) { await sleep(200); if (received !== null) break; }
  log("B: giant multi-byte question delivered intact", received === text);
  client.destroy(); hub.dispose();
}

} catch (e) { ok = false; console.log('B THREW:', e && e.stack || e); }
try { console.log('-- C');
// ── C: RPC child stdout with multi-byte split across data events parses ──
{
  const { RpcSubagent } = await jiti.import(`${RT}/pi-subagent/extensions/pi-subagent/rpc.ts`);
  // Child generates the payload itself (small argv) and dribbles it out in
  // 40001-byte chunks — deliberately splitting 4-byte emoji sequences.
  const childScript = `
    const msg = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: String.fromCodePoint(0x1F6A8).repeat(60000) }] } };
    const b = Buffer.from(JSON.stringify(msg) + "\\n", "utf8");
    let o = 0;
    const t = setInterval(() => {
      const cut = Math.min(o + 40001, b.length);
      process.stdout.write(b.subarray(o, cut));
      o = cut;
      if (o >= b.length) { clearInterval(t); setTimeout(() => process.exit(0), 100); }
    }, 10);
  `;
  const rpc = new RpcSubagent({ command: "node", args: ["-e", childScript], cwd: "/tmp", logPath: "/tmp/rpc-decode.log" });
  let resolved: number | null | undefined;
  rpc.exit.then((c) => { resolved = c; });
  const t1 = Date.now();
  while (resolved === undefined && Date.now() - t1 < 15000) await sleep(500);
  const E = String.fromCodePoint(0x1F6A8).repeat(60000);
  const out = rpc.finalOutput();
  log("C: split multi-byte stdout line parsed intact (60000 emoji)", resolved !== undefined && out === E);
  try { rpc.proc.kill("SIGKILL"); } catch {}
}
} catch (e) { ok = false; console.log('C THREW:', e && e.stack || e); }
console.log(ok ? "WINFIX PASS" : "WINFIX FAIL");
process.exit(ok ? 0 : 1);

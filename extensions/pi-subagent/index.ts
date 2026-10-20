/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes (exactly ONE per call):
 *   - Single: { agent: "name", task: "..." }   (BOTH required)
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }  ← runs
 *     SEQUENTIALLY unless concurrency > 1 is passed
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Background mode (background: true, single or tasks[]): the child runs as a
 * long-lived `pi --mode rpc` process owned by the background manager. It is
 * adopted into pi-bg-jobs when that extension is loaded (so bg_jobs list/kill
 * and ralph-loop job-awareness see it), notifies you when it settles, and can
 * be steered/queried/answered via the `subagent_control` tool. Subagents can
 * ask YOU questions with their `ask_main_agent` tool — answer with
 * subagent_control action="reply".
 *
 * Uses JSON mode (foreground) / RPC mode (background) to capture structured
 * output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
    CONFIG_DIR_NAME,
    type ExtensionAPI,
    type ExtensionContext,
    getAgentDir,
    getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { fmtDur, formatAge, getPiInvocation, parseDuration, writePromptToTempFile } from "./util.ts";
import { RpcSubagent } from "./rpc.ts";
import { MailboxHub, type QuestionHandler } from "./mailbox.ts";

const DEFAULT_MAX_CONCURRENCY = 1;

const COLLAPSED_ITEM_COUNT = 10;

/** Child-side extension giving subagents the ask_main_agent tool. */
const COMPANION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "companion.ts");

/** Where background-run JSONL logs live. */
const RUN_LOG_DIR = (() => {
    const uid = (process as unknown as { uid?: number }).uid ?? os.userInfo().uid ?? 0;
    return path.join(os.tmpdir(), `pi-subagent-runs-${uid}`);
})();

function getAgentDisplayName(agent: string | InlineAgentConfig): string {
	return typeof agent === "string" ? agent : (agent as any)?.name ?? "inline";
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "builtin" | "user" | "project" | "inline" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	output?: string;
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
}

interface InlineAgentConfig {
	name?: string;
	description?: string;
	systemPrompt?: string;
	tools?: string[];
	model?: string;
	returnPrompt?: string;
	saveConversation?: boolean;
}

type AgentTarget =
	| { ok: true; agent: AgentConfig; displayName: string; inlineCfg?: InlineAgentConfig }
	| { ok: false; error: string };

/** Resolve a string agent name or inline config to a concrete AgentConfig.
 *  Shared by the foreground (runSingleAgent) and background paths. */
function resolveAgentTarget(
	agentName: string | InlineAgentConfig,
	agents: AgentConfig[],
	parentModel: string | undefined
): AgentTarget {
	let parsedInline: InlineAgentConfig | undefined;
	if (typeof agentName === "string" && agentName.trim().startsWith("{")) {
		try {
			parsedInline = JSON.parse(agentName) as InlineAgentConfig;
		} catch {
			// Not valid JSON, treat as agent name
		}
	}

	if (typeof agentName === "string" && !parsedInline) {
		const found = agents.find((a) => a.name === agentName);
		if (!found) {
			const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
			return { ok: false, error: `Unknown agent: "${agentName}". Available agents: ${available}.` };
		}
		// Inherit the current session model when the agent file omits one,
		// mirroring the inline-agent path (which falls back to parentModel).
		return { ok: true, agent: { ...found, model: found.model ?? parentModel }, displayName: found.name };
	}

	const inline = typeof agentName === "string" ? (parsedInline as InlineAgentConfig) : agentName;
	const displayName = inline.name ?? "inline";
	return {
		ok: true,
		displayName,
		inlineCfg: inline,
		agent: {
			name: displayName,
			description: inline.description ?? "Inline subagent",
			systemPrompt: inline.systemPrompt ?? "",
			tools: inline.tools, // omitted → inherit default toolset; explicit [] → no tools
			model: inline.model ?? parentModel,
			source: "inline" as const,
			filePath: "",
		},
	};
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

/** Persist a run transcript to ~/.pi/subagent-runs/ for search_subagent. */
export function saveRunSummary(agentName: string, task: string, messages: Message[]): string | undefined {
	try {
		const runsDir = path.join(os.homedir(), ".pi", "subagent-runs");
		fs.mkdirSync(runsDir, { recursive: true });
		const summaryFile = path.join(runsDir, `${agentName.replace(/[^\w.-]+/g, "_")}-${Date.now()}.json`);
		const summary = {
			agent: agentName,
			task: task,
			output: getFinalOutput(messages) || "(no output)",
			timestamp: new Date().toISOString(),
			messageCount: messages.length,
			messages: messages.map((m) => ({
				role: m.role,
				content: typeof m.content === "string" ? m.content : (m.content as Array<{ text?: string }>)[0]?.text || "",
			})),
		};
		fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
		return summaryFile;
	} catch {
		return undefined;
	}
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
    items: TIn[],
    concurrency: number,
    fn: (item: TIn, index: number) => Promise<TOut>
): Promise<TOut[]> {
    if (items.length === 0) return [];
    const limit = Math.max(1, Math.min(concurrency, items.length));
    const results: TOut[] = new Array(items.length);
    let nextIndex = 0;
    const workers = new Array(limit).fill(null).map(async () => {
        while (true) {
            const current = nextIndex++;
            if (current >= items.length) return;
            results[current] = await fn(items[current], current);
        }
    });
    await Promise.all(workers);
    return results;
}

// ── Settings ─────────────────────────────────────────────────────────────────

interface SaCfg {
    /** Default delay before a "peek at this background subagent" reminder fires. */
    peekAfterMs: number; // 0 = off
    /** How long an idle background subagent stays alive for follow-ups. */
    idleTtlMs: number;
    /** How long ask_main_agent may block before timing out. */
    askTimeoutMs: number;
    /** Delivery mode for question/completion/reminder injections. */
    notifyMode: "steer" | "followUp";
    /** Concurrent background subagents allowed. */
    maxBackground: number;
    /** Ring entries shown in reminder peeks. */
    peekTurns: number;
}

const SA_CFG_DEFAULTS: SaCfg = {
    peekAfterMs: 0,
    idleTtlMs: 10 * 60_000,
    askTimeoutMs: 10 * 60_000,
    notifyMode: "steer",
    maxBackground: 8,
    peekTurns: 6,
};

function loadSubagentSettings(cwd: string): SaCfg {
    const read = (p: string): Record<string, unknown> => {
        try {
            return JSON.parse(fs.readFileSync(p, "utf8"));
        } catch {
            return {};
        }
    };
    const merged = {
        ...read(path.join(getAgentDir(), "settings.json")),
        ...read(path.join(cwd, CONFIG_DIR_NAME, "settings.json")),
    };
    const s = (merged.subagent ?? {}) as Record<string, unknown>;
    const cfg: SaCfg = { ...SA_CFG_DEFAULTS };
    try {
        if (s.peekAfter !== undefined) cfg.peekAfterMs = parseDuration(s.peekAfter);
        if (s.idleTtl !== undefined) cfg.idleTtlMs = parseDuration(s.idleTtl);
        if (s.askTimeout !== undefined) cfg.askTimeoutMs = parseDuration(s.askTimeout);
    } catch {
        /* bad durations → keep defaults; surfaced on use */
    }
    if (s.notifyMode === "steer" || s.notifyMode === "followUp") cfg.notifyMode = s.notifyMode;
    if (typeof s.maxBackground === "number" && s.maxBackground > 0) cfg.maxBackground = Math.floor(s.maxBackground);
    if (typeof s.peekTurns === "number" && s.peekTurns > 0) cfg.peekTurns = Math.floor(s.peekTurns);
    return cfg;
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

/** Foreground runs get a mailbox too: their ask_main_agent questions are
 *  surfaced to the USER via an input dialog (the main agent itself is
 *  blocked awaiting the run, so it cannot answer). */
interface ForegroundMailbox {
	hub: MailboxHub;
	cfg: SaCfg;
	ctx: ExtensionContext;
}

let tokenCounter = 0;
function newToken(): string {
	return `sat-${process.pid}-${Date.now().toString(36)}-${++tokenCounter}`;
}

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string | InlineAgentConfig,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	piArgs: string[] | undefined,
	parentModel: string | undefined,
	returnPrompt: string | undefined,
	saveConversation: boolean | undefined,
	allowNesting: boolean | undefined,
	mailbox?: ForegroundMailbox,
): Promise<SingleResult> {
	const target = resolveAgentTarget(agentName, agents, parentModel);
	if (!target.ok) {
		const name = getAgentDisplayName(agentName);
		return {
			agent: name,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: target.error,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}
	const agent = target.agent;
	const displayName = target.displayName;
	const parsedInline = target.inlineCfg;

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	// Headless trim: no UI in -p mode, so themes and prompt templates are pure
	// startup cost with no benefit.
	args.push("--no-themes", "--no-prompt-templates");
	if (agent.model) args.push("--model", agent.model);
	const noTools = agent.tools && agent.tools.length === 0;
	if (agent.tools && agent.tools.length > 0) {
		args.push("--tools", agent.tools.join(","));
	} else if (noTools) {
		args.push("--no-tools"); // Explicitly disable all tools
	}
	// Recursion guard: by default a subagent must not spawn its own subagents
	// (each is a full pi startup; parallel mode would fan out unboundedly).
	// Skip when tools are already fully disabled. Set allowNesting to opt in.
	if (!allowNesting && !noTools) {
		args.push("--exclude-tools", "subagent,search_subagent,subagent_control");
	}
	if (piArgs && piArgs.length > 0) args.push(...piArgs);

	// Mailbox: child-side companion.ts registers ask_main_agent when the
	// token env vars are present; it scrubs them so nested spawns don't
	// inherit this route.
	let mailToken: string | undefined;
	let mailCleanup: (() => void) | undefined;
	if (mailbox && mailbox.hub.ensureServer()) {
		mailToken = newToken();
		args.push("--extension", COMPANION_PATH);
		mailCleanup = mailbox.hub.register(mailToken, (q, respond) => {
			void (async () => {
				if (!mailbox.ctx.hasUI) {
					respond("(no interactive UI available — proceed with your best judgment and state the assumption you made)");
					return;
				}
				const title = `Subagent "${displayName}" asks: ${q.text.length > 160 ? `${q.text.slice(0, 160)}…` : q.text}`;
				const answer = await mailbox.ctx.ui.input(title, "");
				respond(
					answer && answer.trim()
						? answer
						: "(no answer given — proceed with your best judgment and state the assumption you made)"
				);
			})();
		});
	}
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (mailToken) {
		env.PI_SUBAGENT_TOKEN = mailToken;
		env.PI_SUBAGENT_MAIL_SOCK = mailbox!.hub.socketPath!;
		env.PI_SUBAGENT_NAME = displayName;
		env.PI_SUBAGENT_ASK_TIMEOUT_MS = String(mailbox!.cfg.askTimeoutMs);
	}

	// Extract returnPrompt from inline config
	const inlineReturnPrompt = typeof agentName === "object" ? agentName.returnPrompt : undefined;
	const inlineSaveConversation = (typeof agentName === "object" ? agentName.saveConversation : undefined) ?? parsedInline?.saveConversation;
	const finalReturnPrompt = returnPrompt ?? inlineReturnPrompt;
	const finalSaveConversation = saveConversation ?? inlineSaveConversation ?? false;

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: displayName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		output: "",
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model,
		step,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		const fullTask = finalReturnPrompt ? `${task}

IMPORTANT: ${finalReturnPrompt}

Follow these instructions exactly for your response.` : task;
args.push(`Task: ${fullTask}`);
		let wasAborted = false;

		const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env,
			});
			
			const exitCode = await new Promise<number>((resolve) => {
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		// Save conversation summary if requested
		if (finalSaveConversation) {
			saveRunSummary(displayName, task, currentResult.messages);
		}
		return currentResult;
	} finally {
		mailCleanup?.();
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const InlineAgentSchema = Type.Object({
	name: Type.Optional(Type.String({ description: "Agent name (for display/logging)" })),
	description: Type.Optional(Type.String({ description: "Agent description" })),
	systemPrompt: Type.Optional(Type.String({ description: "Custom system prompt for this agent" })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Allowed tools, e.g. [\"read\", \"bash\", \"find\"]" })),
	model: Type.Optional(Type.String({ description: "Model override, e.g. \"anthropic/claude-sonnet-4\"" })),
	returnPrompt: Type.Optional(Type.String({ description: "Instructions appended to the task controlling exactly what the subagent reports back (keeps your context clean — e.g. \"return only the list of failing test names\")" })),
	saveConversation: Type.Optional(Type.Boolean({ description: "Save conversation summary for later search" })),
});

const TaskItem = Type.Object({
	agent: Type.Union([
		Type.String({ description: "Name of the agent to invoke" }),
		InlineAgentSchema,
	]),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	piArgs: Type.Optional(Type.Array(Type.String(), { description: "Extra CLI args to pass to the pi subprocess (e.g. --tools, --model, --extension)" })),
});

const ChainItem = Type.Object({
	agent: Type.Union([
		Type.String({ description: "Name of the agent to invoke" }),
		InlineAgentSchema,
	]),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	piArgs: Type.Optional(Type.Array(Type.String(), { description: "Extra CLI args to pass to the pi subprocess" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

/** Static shape of SubagentParams for the tool handler (typebox schemas are
 *  values; using them as types silently degrades to any/unknown). */
interface SubagentCallParams {
	agent?: string | InlineAgentConfig;
	task?: string;
	returnPrompt?: string;
	tasks?: Array<{ agent: string | InlineAgentConfig; task: string; cwd?: string; piArgs?: string[] }>;
	chain?: Array<{ agent: string | InlineAgentConfig; task: string; cwd?: string; piArgs?: string[] }>;
	background?: boolean;
	name?: string;
	peekAfter?: string | number;
	saveConversation?: boolean;
	agentScope?: AgentScope;
	confirmProjectAgents?: boolean;
	cwd?: string;
	piArgs?: string[];
	concurrency?: number;
	allowNesting?: boolean;
}

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.Union([
		Type.String({ description: "Name of the agent to invoke. REQUIRED together with `task` for single mode (pass BOTH, never agent alone)." }),
		InlineAgentSchema,
	])),
	task: Type.Optional(Type.String({ description: "Task to delegate. REQUIRED together with `agent` for single mode (pass BOTH, never agent alone)." })),
	returnPrompt: Type.Optional(Type.String({ description: "Single mode: instructions controlling exactly what the subagent reports back (keeps your context clean)." })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution. NOTE: runs SEQUENTIALLY unless you also pass concurrency > 1. Mutually exclusive with agent+task and chain." })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution, later steps may reference {previous} output. Mutually exclusive with agent+task and tasks." })),
	background: Type.Optional(Type.Boolean({
		description: "Run detached instead of blocking: applies to single mode and tasks mode. Returns an id immediately; manage with the subagent_control tool (list/peek/send/reply/abort/kill/wait/remind). You will be notified when each run settles and when a subagent asks a question (answer via subagent_control action='reply').",
	})),
	name: Type.Optional(Type.String({ description: "Human label for background runs (shown in listings and notifications)." })),
	peekAfter: Type.Optional(Type.Union([Type.String(), Type.Number()], {
		description: "Background only: after this duration, inject a reminder with the subagent's most recent turns so you can steer it (e.g. \"5m\", 300 = 300s). 0 disables. Overrides the 'subagent'.peekAfter setting.",
	})),
	saveConversation: Type.Optional(Type.Boolean({ description: "Save conversation summary for later search (applies to all modes)" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	piArgs: Type.Optional(Type.Array(Type.String(), { description: "Extra CLI args to pass to the pi subprocess (single mode only)" })),
	concurrency: Type.Optional(Type.Integer({ description: "Max SIMULTANEOUS subagents for parallel/chain mode. DEFAULT 1 = sequential (one at a time, despite the 'parallel' name). Pass 2-8 for genuine parallelism.", default: 1 })),
	allowNesting: Type.Optional(Type.Boolean({ description: "Allow subagents to spawn their own subagents. Default: false (the subagent/search_subagent/subagent_control tools are excluded from children to prevent unbounded recursion).", default: false })),
});

function modeError(detail: string, available: string): string {
	return (
		`subagent: ${detail}\n\n` +
		`Provide exactly ONE of these three shapes (never a mix):\n` +
		`  1. single:   { "agent": "worker", "task": "..." }  ← BOTH agent and task required\n` +
		`  2. parallel: { "tasks": [ { "agent": "scout", "task": "..." } ], "concurrency": 4 }  ← concurrency>1 for real parallelism\n` +
		`  3. chain:    { "chain": [ { "agent": "planner", "task": "plan X" }, { "agent": "worker", "task": "implement: {previous}" } ] }\n\n` +
		`Add "background": true (single/parallel) to detach and continue working — manage via subagent_control.\n\n` +
		`Available agents: ${available}`
	);
}

export default function (pi: ExtensionAPI) {
	// ── Background subagent machinery ────────────────────────────────────
	// State lives on globalThis so a /reload (extension re-instantiation in
	// the same Node process) adopts live runs instead of orphaning them:
	// listeners are re-bound to the fresh `pi` under a generation guard.
	interface BgRun {
		id: string;
		token: string;
		gen: number;
		agent: string;
		name?: string;
		task: string;
		status: "running" | "idle" | "exited" | "failed" | "killed";
		rpc: RpcSubagent;
		adoptedJobId?: string;
		/** Resolves the current bg-jobs adoption round (settle or exit). */
		adoptionResolve?: (code: number | null) => void;
		startTmp?: { dir: string; filePath: string };
		startedAt: number;
		endAt?: number;
		exitCode?: number | null;
		settleRounds: number;
		finalized?: boolean;
		questions: Array<{ qid: number; text: string; askedAt: number; answered?: string }>;
		responders: Map<number, (text: string) => boolean>;
		peekTimer?: NodeJS.Timeout;
		peekDueAt?: number;
		idleKillTimer?: NodeJS.Timeout;
		wasKilled?: boolean;
		saveConversation?: boolean;
	}

	interface BgState {
		hub: MailboxHub;
		runs: Map<string, BgRun>;
		terminalRuns: BgRun[];
		runCounter: number;
		gen: number;
	}

	const g = globalThis as { __piSubagentBg?: BgState };
	const state: BgState = (g.__piSubagentBg ??= {
		hub: new MailboxHub(),
		runs: new Map(),
		terminalRuns: [],
		runCounter: 0,
		gen: 0,
	});
	state.gen++;
	const myGen = state.gen;
	const hub = state.hub;
	const runs = state.runs;
	const terminalRuns = state.terminalRuns;
	let cfg: SaCfg = { ...SA_CFG_DEFAULTS };

	function clip(s: string, n: number): string {
		const t = (s ?? "").trim();
		return t.length > n ? `${t.slice(0, n)}…` : t;
	}

	function runLabel(r: BgRun): string {
		return `${r.id}${r.name ? ` "${r.name}"` : ""} [${r.agent}]`;
	}

	function textResult(text: string) {
		return { content: [{ type: "text" as const, text }], details: {} };
	}

	/** Inject an agent-visible notice (questions/completions/reminders). */
	function inject(content: string, customType: string, details: Record<string, unknown>): void {
		try {
			pi.sendMessage({ customType, content, display: true, details } as never, {
				deliverAs: cfg.notifyMode,
				triggerTurn: true,
			});
		} catch {
			/* stale context (session switched mid-flight) — notice dropped */
		}
	}

	function scheduleIdleKill(r: BgRun): void {
		if (r.idleKillTimer) clearTimeout(r.idleKillTimer);
		r.idleKillTimer = undefined;
		if (cfg.idleTtlMs <= 0) return;
		r.idleKillTimer = setTimeout(() => {
			r.wasKilled = true;
			r.rpc.kill();
		}, cfg.idleTtlMs);
		r.idleKillTimer.unref();
	}

	function schedulePeek(r: BgRun, delayMs: number): void {
		if (r.peekTimer) clearTimeout(r.peekTimer);
		r.peekTimer = undefined;
		r.peekDueAt = undefined;
		if (delayMs <= 0) return;
		r.peekDueAt = Date.now() + delayMs;
		r.peekTimer = setTimeout(() => {
			if (r.gen !== state.gen) return; // superseded by /reload
			r.peekTimer = undefined;
			r.peekDueAt = undefined;
			if (r.status !== "running" && r.status !== "idle") return;
			const pending = r.questions.find((q) => !q.answered);
			const head = `⏰ Subagent peek reminder — ${runLabel(r)}: status ${r.status}, running ${formatAge((r.endAt ?? Date.now()) - r.startedAt)}, ${r.rpc.usage.turns} turns${pending ? " — ⚠ QUESTION PENDING, answer it now (subagent_control action='reply')" : ""}.`;
			inject(
				`${head}\n\nMost recent turns:\n${r.rpc.peek(cfg.peekTurns)}\n\nIf off-track: subagent_control action="send" to steer, "kill" to stop, "abort" to interrupt, or "remind" (after=…) to re-arm this check.`,
				"subagent:reminder",
				{ runId: r.id }
			);
		}, delayMs);
		r.peekTimer.unref();
	}

	/** Hand the child to pi-bg-jobs for lifecycle (list/kill/sidebar, and
	 *  ralph-loop job-awareness via bg-jobs:status). Graceful when absent.
	 *  Adoption is ROUND-based: `exit` resolves when the current work round
	 *  ends (settle or process exit) — NOT at process death — because the RPC
	 *  child stays warm for follow-ups (idleTtl). Counting the warm process as
	 *  a "running job" would block ralph-loop indefinitely after the task is
	 *  actually done. New work opens a fresh adopted entry via openAdoption. */
	async function adoptToBgJobs(r: BgRun, exit: Promise<number | null>): Promise<void> {
		const result = await new Promise<{ ok: boolean; id?: string; error?: string }>((resolve) => {
			let settled = false;
			const done = (res: { ok: boolean; id?: string; error?: string }) => {
				if (!settled) {
					settled = true;
					resolve(res);
				}
			};
			const t = setTimeout(() => done({ ok: false, error: "bg-jobs not loaded" }), 100);
			t.unref();
			try {
				pi.events.emit("bg-jobs:adopt", {
					command: `subagent ${r.agent}: ${clip(r.task, 70)}`,
					name: `subagent:${r.name ?? r.agent}`,
					pid: r.rpc.proc.pid ?? -1,
					logPath: r.rpc.logPath,
					exit,
					proc: r.rpc.proc,
					silent: true, // we emit richer completion notices ourselves
					disablePromptStall: true, // JSONL stream — no interactive-prompt heuristic
					reply: done,
				});
			} catch {
				clearTimeout(t);
				done({ ok: false, error: "event bus unavailable" });
			}
		});
		if (result.ok) r.adoptedJobId = result.id;
	}

	/** Open a bg-jobs adoption for the current work round (idempotent). */
	function openAdoption(r: BgRun): void {
		if (r.adoptionResolve) return; // a round is already being counted
		let resolve!: (code: number | null) => void;
		const exit = new Promise<number | null>((res) => (resolve = res));
		r.adoptionResolve = (code) => {
			r.adoptionResolve = undefined;
			resolve(code);
		};
		void adoptToBgJobs(r, exit);
	}

	function bindRunLifecycle(r: BgRun): void {
		r.rpc.onSettled(() => {
			if (r.gen !== state.gen) return;
			if (r.status === "exited" || r.status === "failed" || r.status === "killed") return;
			r.status = "idle";
			r.settleRounds++;
			// Round over: close the adopted bg-job entry so ralph-loop resumes
			// its follow-ups (the warm RPC process must not count as "busy").
			r.adoptionResolve?.(0);
			scheduleIdleKill(r);
			const out = clip(r.rpc.finalOutput(), 3000) || "(no text output)";
			const u = r.rpc.usage;
			inject(
				`✅ Background subagent ${runLabel(r)} finished round ${r.settleRounds}` +
					` (${u.turns} turns, ↑${u.input} ↓${u.output}, $${u.cost.toFixed(4)})` +
					`. Stays alive ${fmtDur(cfg.idleTtlMs)} for follow-ups unless killed.\n\nFinal output:\n${out}\n\n` +
					`Continue it: subagent_control action="send" · inspect: action="peek" · stop now: action="kill".`,
				"subagent:finished",
				{ runId: r.id }
			);
		});
		void r.rpc.exit.then((code) => {
			if (r.finalized) return;
			r.finalized = true;
			if (r.gen !== state.gen) {
				// Reloaded-away instance: do minimal bookkeeping only.
				for (const [id, run] of runs) if (run === r) runs.delete(id);
				return;
			}
			if (r.peekTimer) clearTimeout(r.peekTimer);
			if (r.idleKillTimer) clearTimeout(r.idleKillTimer);
			hub.unregister(r.token);
			if (r.startTmp) {
				try {
					fs.unlinkSync(r.startTmp.filePath);
					fs.rmdirSync(r.startTmp.dir);
				} catch {
					/* ignore */
				}
			}
			r.endAt = Date.now();
			r.exitCode = code;
			r.adoptionResolve?.(code ?? null); // close any still-open round
			r.status = r.wasKilled || r.rpc.proc.signalCode
				? "killed"
				: r.status === "idle" || code === 0
					? "exited"
					: "failed";
			if (r.saveConversation) saveRunSummary(r.agent, r.task, r.rpc.messages as Message[]);
			if (r.status !== "exited") {
				// No settle happened (crash/kill) — announce the abnormal end.
				const lastErr = r.rpc.getLastError();
				const why =
					r.status === "killed"
						? "was terminated"
						: `exited with code ${code}${lastErr ? ` — ${clip(lastErr, 200)}` : ""}`;
				inject(
					`Background subagent ${runLabel(r)} ${why} after ${formatAge((r.endAt ?? Date.now()) - r.startedAt)}.\nLast output:\n${clip(r.rpc.finalOutput(), 2000) || "(none)"}`,
					"subagent:finished",
					{ runId: r.id }
				);
			}
			runs.delete(r.id);
			terminalRuns.unshift(r);
			if (terminalRuns.length > 20) terminalRuns.pop();
		});
	}

	function registerQuestionRoute(r: BgRun): void {
		if (!hub.socketPath) return;
		hub.register(r.token, (q, respond) => {
			if (r.gen !== state.gen) return;
			r.questions.push({ qid: q.qid, text: q.text, askedAt: Date.now() });
			r.responders.set(q.qid, respond);
			inject(
				`❓ Background subagent ${runLabel(r)} is asking — it is BLOCKED waiting for your reply:\n\n${q.text}\n\n` +
					`Answer with subagent_control { action: "reply", id: "${r.id}", text: "…" } (or ask the user first).`,
				"subagent:question",
				{ runId: r.id, qid: q.qid }
			);
		});
	}

	async function startBackgroundRun(
		ctx: ExtensionContext,
		agents: AgentConfig[],
		agentParam: string | InlineAgentConfig,
		task: string,
		opts: {
			name?: string;
			cwd?: string;
			piArgs?: string[];
			saveConversation?: boolean;
			returnPrompt?: string;
			peekAfterMs: number;
			parentModel?: string;
			allowNesting?: boolean;
		}
	): Promise<BgRun> {
		if (runs.size >= cfg.maxBackground) {
			throw new Error(
				`background subagent limit reached (${runs.size}/${cfg.maxBackground}) — free some up via subagent_control action="kill"`
			);
		}
		const target = resolveAgentTarget(agentParam, agents, opts.parentModel);
		if (!target.ok) throw new Error(target.error);
		const agent = target.agent;
		const displayName = target.displayName;

		const args: string[] = ["--mode", "rpc", "--no-session", "--no-themes", "--no-prompt-templates"];
		if (agent.model) args.push("--model", agent.model);
		const noTools = agent.tools && agent.tools.length === 0;
		if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
		else if (noTools) args.push("--no-tools");
		if (!opts.allowNesting && !noTools) {
			args.push("--exclude-tools", "subagent,search_subagent,subagent_control");
		}
		if (opts.piArgs && opts.piArgs.length > 0) args.push(...opts.piArgs);

		let startTmp: { dir: string; filePath: string } | undefined;
		if (agent.systemPrompt.trim()) {
			startTmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			args.push("--append-system-prompt", startTmp.filePath);
		}
		const mailboxUp = hub.ensureServer();
		if (mailboxUp) args.push("--extension", COMPANION_PATH);

		const fullTask = opts.returnPrompt
			? `${task}

IMPORTANT: ${opts.returnPrompt}

Follow these instructions exactly for your response.`
			: task;

		try {
			fs.mkdirSync(RUN_LOG_DIR, { recursive: true, mode: 0o700 });
		} catch {
			/* existing dir */
		}
		const id = `sa-${process.pid}-${++state.runCounter}`;
		const logPath = path.join(RUN_LOG_DIR, `${id}.log`);
		const token = newToken();
		const env: NodeJS.ProcessEnv = { ...process.env };
		if (mailboxUp && hub.socketPath) {
			env.PI_SUBAGENT_TOKEN = token;
			env.PI_SUBAGENT_MAIL_SOCK = hub.socketPath;
			env.PI_SUBAGENT_NAME = displayName;
			env.PI_SUBAGENT_ASK_TIMEOUT_MS = String(cfg.askTimeoutMs);
		}

		const invocation = getPiInvocation(args);
		const rpc = new RpcSubagent({
			command: invocation.command,
			args: invocation.args,
			cwd: opts.cwd ?? ctx.cwd,
			env,
			logPath,
		});

		const run: BgRun = {
			id,
			token,
			gen: myGen,
			agent: displayName,
			name: opts.name,
			task,
			status: "running",
			rpc,
			startTmp,
			startedAt: Date.now(),
			settleRounds: 0,
			questions: [],
			responders: new Map(),
			saveConversation: opts.saveConversation,
		};
		runs.set(id, run);
		registerQuestionRoute(run);
		bindRunLifecycle(run);
		openAdoption(run);
		rpc.prompt(`Task: ${fullTask}`);
		if (opts.peekAfterMs > 0) schedulePeek(run, opts.peekAfterMs);
		return run;
	}

	function findRun(idOrName?: string): BgRun | undefined {
		if (!idOrName) {
			if (runs.size === 1) return runs.values().next().value;
			return undefined;
		}
		const q = idOrName.trim();
		const norm = (s: string) => (s.startsWith("sa-") ? s : `sa-${s}`);
		const all = [...runs.values(), ...terminalRuns];
		return (
			runs.get(q) ??
			runs.get(norm(q)) ??
			all.find((r) => r.id === q || r.id === norm(q) || r.id.endsWith(`-${q}`) || r.name === q) ??
			undefined
		);
	}

	function requireRun(idOrName?: string): BgRun {
		const r = findRun(idOrName);
		if (!r) {
			const live = [...runs.values()].map((x) => x.id).join(", ") || "none";
			throw new Error(`unknown subagent id "${idOrName ?? ""}" — running: ${live}. Recent: ${terminalRuns.map((x) => x.id).join(", ") || "none"}. Use action="list".`);
		}
		return r;
	}

	// ── Session lifecycle ─────────────────────────────────────────────────
	pi.on("session_start", async (event, ctx) => {
		cfg = loadSubagentSettings(ctx.cwd);
		const reason = (event as { reason?: string })?.reason;
		if (reason === "reload") {
			// Adopt live runs from the pre-reload instance: re-stamp them to
			// this generation and re-bind listeners/notification to the new pi.
			for (const r of runs.values()) {
				r.gen = state.gen;
				registerQuestionRoute(r);
				bindRunLifecycle(r);
				if (r.status === "idle") scheduleIdleKill(r);
				if (r.peekDueAt) schedulePeek(r, Math.max(1000, r.peekDueAt - Date.now()));
			}
		} else {
			// Fresh session (new/resume/fork): the previous session's
			// background children go with it.
			for (const r of runs.values()) {
				r.wasKilled = true;
				try {
					r.rpc.kill();
				} catch {
					/* already dead */
				}
			}
			runs.clear();
		}
	});

	pi.on("session_shutdown", async (event) => {
		const reason = (event as { reason?: string })?.reason;
		if (reason !== "reload") {
			for (const r of runs.values()) {
				r.wasKilled = true;
				try {
					r.rpc.kill("SIGTERM");
				} catch {
					/* already dead */
				}
			}
		}
	});

	// ── subagent tool ──────────────────────────────────────────────────

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to subagents with isolated context. Supports inline agent definitions — no .md files needed.",
			"EXACTLY ONE mode per call: single (agent + task — BOTH keys required), parallel (tasks array), or chain (chain array).",
			"PARALLELISM: parallel/chain run tasks SEQUENTIALLY by default — pass concurrency > 1 for simultaneous execution. Do not assume parallelism from the mode name.",
			"Agent can be a string name (from ~/.pi/agent/agents/ + bundled) or an inline object with systemPrompt, tools, model.",
			"Use returnPrompt to control what the subagent returns (prevents context pollution).",
			"Use saveConversation: true to save conversation summary to ~/.pi/subagent-runs/ for later search.",
			"Use search_subagent tool to find past subagent conversations.",
			"Use piArgs for extra CLI flags. Use concurrency to control parallelism (default: 1 = sequential).",
			"BACKGROUND: background:true (single or tasks) detaches the run — returns an id immediately; you are notified when it settles and when the subagent uses its ask_main_agent tool (answer with subagent_control action='reply'). Manage lifecycle with subagent_control: list | peek | send | reply | abort | kill | wait | remind.",
			"Subagents run headless (no themes/prompt-templates) and cannot spawn their own subagents unless allowNesting is set.",
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params: SubagentCallParams, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;
			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasAgent =
				params.agent !== undefined &&
				params.agent !== null &&
				(typeof params.agent === "object" ? true : String(params.agent).trim() !== "");
			const hasTask = typeof params.task === "string" && params.task.trim() !== "";
			const wantsBackground = params.background === true;

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			// Recovery instead of rejection: a task with no agent is still an
			// obvious intent — run it on the general-purpose worker.
			let effectiveAgent = params.agent;
			if (!hasChain && !hasTasks && hasTask && !hasAgent) {
				effectiveAgent = agents.some((a) => a.name === "worker")
					? "worker"
					: {
							name: "general",
							systemPrompt: "You are a capable general-purpose subagent. Complete the task fully, then report the result concisely.",
						} as InlineAgentConfig;
			}
			const hasSingle = Boolean(effectiveAgent) && hasTask;
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			if (modeCount !== 1) {
				let detail: string;
				if (hasChain && hasTasks) detail = "you passed both `tasks` (parallel) and `chain` — pick one mode.";
				else if ((hasChain || hasTasks) && hasAgent) detail = "you passed `agent` alongside a `tasks`/`chain` array — set the agent INSIDE each array item instead.";
				else if (hasAgent && !hasTask) detail = "you passed `agent` without `task` — single mode requires BOTH keys (e.g. { agent: \"worker\", task: \"...\" }).";
				else if (hasTasks && params.tasks!.some((t: { task?: string }) => !t.task || !t.task.trim())) detail = "one or more tasks[] items are missing a non-empty `task`.";
				else if (hasChain && params.chain!.some((t: { task?: string }) => !t.task || !t.task.trim())) detail = "one or more chain[] items are missing a non-empty `task`.";
				else detail = "no valid mode found — pass agent+task, or tasks[], or chain[].";
				return {
					content: [{ type: "text", text: modeError(detail, available) }],
					details: makeDetails("single")([]),
				};
			}

			// ── Background dispatch (single / parallel only) ────────────────
			if (wantsBackground) {
				if (hasChain) {
					return {
						content: [{ type: "text", text: modeError("chain mode does not support background execution (steps feed each other) — run it in the foreground, or launch steps individually with background:true", available) }],
						details: makeDetails("chain")([]),
					};
				}
				const items = hasTasks
					? params.tasks!.map((t: { agent: string | InlineAgentConfig; task: string; cwd?: string; piArgs?: string[] }) => ({ agent: t.agent, task: t.task, cwd: t.cwd, piArgs: t.piArgs }))
					: [{ agent: effectiveAgent!, task: params.task!, cwd: params.cwd, piArgs: params.piArgs }];
				const peekAfterMs = params.peekAfter !== undefined ? parseDuration(params.peekAfter) : cfg.peekAfterMs;
				const started: BgRun[] = [];
				const errors: string[] = [];
				for (let i = 0; i < items.length; i++) {
					const it = items[i];
					try {
						const run = await startBackgroundRun(ctx, agents, it.agent, it.task, {
							name: items.length === 1 ? params.name : params.name ? `${params.name}-${i + 1}` : undefined,
							cwd: it.cwd,
							piArgs: it.piArgs,
							saveConversation: params.saveConversation,
							returnPrompt: params.returnPrompt,
							peekAfterMs,
							parentModel,
						});
						started.push(run);
					} catch (err) {
						errors.push(err instanceof Error ? err.message : String(err));
					}
				}
				const lines = started.map(
					(r) =>
						`• ${r.id}${r.name ? ` "${r.name}"` : ""} [${r.agent}] — ${r.status} · log: ${r.rpc.logPath}${r.adoptedJobId ? ` · bg-jobs: ${r.adoptedJobId}` : " (bg-jobs not loaded — tracked internally)"}`
				);
				const text = [
					started.length > 0
						? `Started ${started.length} background subagent(s). You are NOT blocked — keep working. You'll be notified when each settles and when one asks a question (answer with subagent_control action="reply").`
						: "",
					...lines,
					errors.length > 0 ? `Errors: ${errors.join("; ")}` : "",
					`Manage: subagent_control { action: "list" | "peek" | "send" | "reply" | "abort" | "kill" | "wait" | "remind", id }`,
				]
					.filter(Boolean)
					.join("\n");
				return {
					content: [{ type: "text", text }],
					details: makeDetails(hasTasks ? "parallel" : "single")([]),
					isError: started.length === 0,
				};
			}

			// Foreground runs get a mailbox so ask_main_agent questions reach
			// the user via an input dialog while this tool call blocks.
			const foregroundMail: ForegroundMailbox | undefined = hub.ensureServer()
				? { hub, cfg, ctx }
				: undefined;

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				const getAgentName = (agent: string | InlineAgentConfig): string | undefined => {
					if (typeof agent === "string") return agent;
					return undefined; // inline agents don't need project approval
				};
				if (params.chain) for (const step of params.chain) { const n = getAgentName(step.agent); if (n) requestedAgentNames.add(n); }
				if (params.tasks) for (const t of params.tasks) { const n = getAgentName(t.agent); if (n) requestedAgentNames.add(n); }
				if (effectiveAgent) { const n = getAgentName(effectiveAgent); if (n) requestedAgentNames.add(n); }

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
						step.piArgs,
						ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
						undefined, // returnPrompt (chain steps keep default contract)
						params.saveConversation,
						params.allowNesting,
						foregroundMail
					);
					results.push(result);

					const isError =
						result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
					if (isError) {
						const errorMsg =
							result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${getAgentDisplayName(step.agent)}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: getAgentDisplayName(params.tasks[i].agent),
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const concurrency = params.concurrency ?? DEFAULT_MAX_CONCURRENCY;
				const results = await mapWithConcurrencyLimit(params.tasks, concurrency, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						t.agent,
						t.task,
						t.cwd,
						undefined,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
						t.piArgs,
						ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
						undefined, // returnPrompt
						params.saveConversation,
						params.allowNesting,
						foregroundMail
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => r.exitCode === 0).length;
				const summaries = results.map((r) => {
					const output = getFinalOutput(r.messages);
					const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
					return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}: ${preview || "(no output)"}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (effectiveAgent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					effectiveAgent,
					params.task,
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
					params.piArgs,
					ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
					params.returnPrompt,
					params.saveConversation,
					params.allowNesting,
					foregroundMail
				);
			const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
				const output = getFinalOutput(result.messages) || "(no output)";
				if (isError) {
					const errorMsg = result.errorMessage || result.stderr || output;
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([{ ...result, messages: [], output }]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: output }],
					details: makeDetails("single")([{ ...result, messages: [], output }]),
				};
			}

			return {
				content: [{ type: "text", text: modeError("no valid mode found — pass agent+task, or tasks[], or chain[].", available) }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", getAgentDisplayName(step.agent)) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", getAgentDisplayName(t.agent))}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = getAgentDisplayName(args.agent ?? "inline");
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const failCount = details.results.filter((r) => r.exitCode > 0).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: r.exitCode === 0
								? theme.fg("success", "✓")
								: theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});





	// ── Background subagent control tool ────────────────────────────

	pi.registerTool({
		name: "subagent_control",
		label: "Subagent Control",
		description: [
			"Manage background subagents (launched via subagent { background: true }).",
			"Actions: list (overview incl. pending questions) · peek (last few turns of one run) ·",
			"send (steer/follow-up guidance into a run) · reply (ANSWER a run's ask_main_agent question — required when a question notice is pending) ·",
			"abort (interrupt current turn, keep process) · kill (terminate) · wait (block until settled/exited) ·",
			"remind (re-arm the peek reminder, after=\"5m\").",
			"Background subagents also appear in bg_jobs (pi-bg-jobs) when that extension is loaded.",
		].join(" "),
		promptSnippet: "Inspect, steer, and answer background subagents",
		promptGuidelines: [
			"list: overview of running + recent background subagents; ⚠ QUESTION PENDING means reply is required for progress.",
			"peek: read the last few turns before deciding to steer — cheap and non-blocking.",
			"send: deliver guidance (deliverAs steer = between tool calls, follow_up = after it stops; when idle any send starts a new round).",
			"reply: always answer a subagent's question with this — it is blocked until you do.",
			"wait: block for the next settle (bounded by timeout); you'll also be notified automatically, so prefer doing other work.",
		],
		parameters: Type.Object({
			action: StringEnum(["list", "peek", "send", "reply", "abort", "kill", "wait", "remind"] as const, {
				description: "Control action to perform.",
			}),
			id: Type.Optional(
				Type.String({
					description: 'Run id ("sa-…"), numeric suffix ("3"), or the name you gave it. Omit only when exactly one run exists.',
				})
			),
			text: Type.Optional(
				Type.String({ description: "send: the guidance/message. reply: the answer to the pending question." })
			),
			deliverAs: Type.Optional(
				StringEnum(["steer", "follow_up"] as const, {
					description: "send while the run is active: steer = before its next LLM call, follow_up = after it stops. Default follow_up.",
				})
			),
			last: Type.Optional(Type.Integer({ description: "peek: how many recent turns to show (default 8)" })),
			after: Type.Optional(
				Type.Union([Type.String(), Type.Number()], {
					description: 'remind: delay before the peek reminder fires ("5m", 300 = 300s; 0 = cancel)',
				})
			),
			timeout: Type.Optional(
				Type.Union([Type.String(), Type.Number()], {
					description: "wait: maximum duration to block (default 10m)",
				})
			),
		}),

		async execute(_toolCallId, p: { action: string; id?: string; text?: string; deliverAs?: "steer" | "follow_up"; last?: number; after?: string | number; timeout?: string | number }, signal) {
			switch (p.action) {
				case "list": {
					const fmt = (r: BgRun) => {
						const pending = r.questions.filter((q) => !q.answered).length;
						return `  ${runLabel(r)} — ${r.status}${pending ? ` ⚠ ${pending} QUESTION(S) PENDING` : ""} · ${formatAge((r.endAt ?? Date.now()) - r.startedAt)} · ${r.rpc.usage.turns} turns${r.adoptedJobId ? ` · bg-jobs ${r.adoptedJobId}` : ""}\n    task: ${clip(r.task, 90)}`;
					};
					const lines: string[] = [`Background subagents — ${runs.size} running:`];
					for (const r of runs.values()) lines.push(fmt(r));
					if (terminalRuns.length > 0) {
						lines.push("", `Recent (${terminalRuns.length}):`);
						for (const r of terminalRuns.slice(0, 10)) lines.push(fmt(r));
					}
					if (runs.size === 0 && terminalRuns.length === 0) {
						lines.push("  (none — start one: subagent { agent: \"worker\", task: \"…\", background: true })");
					}
					return textResult(lines.join("\n"));
				}
				case "peek": {
					const r = requireRun(p.id);
					const pending = r.questions.filter((q) => !q.answered);
					const head =
						`${runLabel(r)} — ${r.status} · ${formatAge((r.endAt ?? Date.now()) - r.startedAt)} · ` +
						`${r.rpc.usage.turns} turns · ↑${r.rpc.usage.input} ↓${r.rpc.usage.output} · $${r.rpc.usage.cost.toFixed(4)}` +
						(pending.length ? ` · ⚠ pending question: ${clip(pending[0].text, 200)}` : "") +
						`\nlog: ${r.rpc.logPath}`;
					return textResult(`${head}\n\n${r.rpc.peek(p.last ?? 8)}`);
				}
				case "send": {
					const r = requireRun(p.id);
					if (!p.text || !p.text.trim()) throw new Error("send requires text");
					if (!r.rpc.alive()) {
						throw new Error(`${r.id} has exited (${r.status}) — launch a new background subagent instead`);
					}
					const mode = p.deliverAs ?? "follow_up";
					if (!r.rpc.continue_(p.text, mode)) throw new Error(`failed to deliver to ${r.id} (stdin closed)`);
					if (r.idleKillTimer) {
						clearTimeout(r.idleKillTimer);
						r.idleKillTimer = undefined;
					}
					r.status = "running";
					openAdoption(r); // new work round → count as a running bg-job again
					return textResult(`Delivered "${clip(p.text, 60)}" to ${r.id} as ${mode === "steer" ? "steer (before its next LLM call)" : "follow-up (after it stops)"}.`);
				}
				case "reply": {
					const r = requireRun(p.id);
					const q = r.questions.find((x) => !x.answered);
					if (!q) throw new Error(`${r.id} has no pending question (asked so far: ${r.questions.length})`);
					if (!p.text || !p.text.trim()) throw new Error("reply requires text — the answer for the subagent");
					const responder = r.responders.get(q.qid);
					q.answered = p.text;
					r.responders.delete(q.qid);
					const delivered = responder ? responder(p.text) : false;
					return textResult(
						delivered
							? `Answered ${r.id} (question ${q.qid}) — it will unblock now.`
							: `Answer recorded for ${r.id}, but the subagent is no longer listening (it may have timed out or exited).`
					);
				}
				case "abort": {
					const r = requireRun(p.id);
					if (!r.rpc.alive()) throw new Error(`${r.id} has exited (${r.status})`);
					const ok = r.rpc.abort();
					return textResult(ok ? `Abort sent to ${r.id} — it interrupts the current turn but keeps the process alive for follow-ups.` : `Failed to deliver abort to ${r.id}.`);
				}
				case "kill": {
					const r = requireRun(p.id);
					if (r.status === "exited" || r.status === "failed" || r.status === "killed") {
						return textResult(`${r.id} already ${r.status}.`);
					}
					r.wasKilled = true;
					r.rpc.kill();
					return textResult(`Sent SIGTERM to ${r.id} (process group). Completion notice follows when it exits.`);
				}
				case "wait": {
					const r = requireRun(p.id);
					const timeoutMs = p.timeout !== undefined ? parseDuration(p.timeout) : 600_000;
					const outcome = await r.rpc.waitSettled(timeoutMs, signal);
					const u = r.rpc.usage;
					return textResult(
						`${r.id}: ${outcome} · ${r.status} · ${u.turns} turns · $${u.cost.toFixed(4)}\n\nLatest output:\n${clip(r.rpc.finalOutput(), 3000) || "(none)"}`
					);
				}
				case "remind": {
					const r = requireRun(p.id);
					if (p.after === undefined) throw new Error('remind requires after (e.g. "5m", 300) — or after=0 to cancel');
					const delay = parseDuration(p.after);
					schedulePeek(r, delay);
					return textResult(delay > 0 ? `Reminder armed: peek at ${r.id} in ${fmtDur(delay)}.` : `Reminder cancelled for ${r.id}.`);
				}
				default:
					throw new Error(`unknown action "${p.action}" — use list | peek | send | reply | abort | kill | wait | remind`);
			}
		},
	});

	// ── /subagents command ───────────────────────────────────────────

	pi.registerCommand("subagents", {
		description: "List background subagents (running + recent), with pending-question flags",
		handler: async (_args, ctx) => {
			const fmt = (r: BgRun) =>
				`${runLabel(r)} — ${r.status}${r.questions.some((q) => !q.answered) ? " ⚠ Q PENDING" : ""} · ${formatAge((r.endAt ?? Date.now()) - r.startedAt)} · ${r.rpc.usage.turns} turns\n    ${clip(r.task, 100)}`;
			const lines: string[] = [];
			if (runs.size > 0) {
				lines.push(`Running (${runs.size}):`);
				for (const r of runs.values()) lines.push(fmt(r));
			} else lines.push("Running: none");
			if (terminalRuns.length > 0) {
				lines.push("", `Recent (${terminalRuns.length}):`);
				for (const r of terminalRuns.slice(0, 8)) lines.push(fmt(r));
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// ── Search Subagent Conversations ──────────────────────

	pi.registerTool({
		name: "search_subagent",
		label: "Search Subagent History",
		description: "Search past subagent conversations saved to ~/.pi/subagent-runs/",
		parameters: Type.Object({
			query: Type.String({ description: "Search query (matches against agent name, task, and output text)" }),
			limit: Type.Optional(Type.Integer({ description: "Max results to return", default: 10 })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { query, limit = 10 } = params as { query: string; limit?: number };
			const runsDir = path.join(os.homedir(), ".pi", "subagent-runs");
			
			if (!fs.existsSync(runsDir)) {
				return {
					content: [{ type: "text", text: "No subagent runs found. Enable saveConversation on subagents to save conversations." }],
					details: {},
				};
			}

			const results: Array<{ agent: string; task: string; timestamp: string; preview: string; path: string }> = [];
			const queryLower = query.toLowerCase();

			try {
				const entries = fs.readdirSync(runsDir, { withFileTypes: true });
				for (const entry of entries) {
					if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
					
					const filePath = path.join(runsDir, entry.name);
					try {
						const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
						const searchText = `${data.agent} ${data.task} ${data.output}`.toLowerCase();
						if (searchText.includes(queryLower)) {
							results.push({
								agent: data.agent,
								task: data.task || "(no task)",
								timestamp: data.timestamp || entry.name,
								preview: data.output || "(no output)",
								path: filePath,
							});
						}
					} catch {
						continue;
					}

					if (results.length >= limit) break;
				}
			} catch (err) {
				return {
					content: [{ type: "text", text: `Error searching subagent runs: ${err instanceof Error ? err.message : String(err)}` }],
					details: {},
					isError: true,
				};
			}

			if (results.length === 0) {
				return {
					content: [{ type: "text", text: `No matches found for "${query}"` }],
					details: {},
				};
			}

			const lines = results.map((r, i) => 
				`${i + 1}. **${r.agent}** (${r.timestamp.slice(0, 19).replace("T", " ")})\n   Task: ${r.task}\n   Preview: ${r.preview.slice(0, 100)}...`
			);

			return {
				content: [{ type: "text", text: `Found ${results.length} match(es):\n\n${lines.join("\n\n")}` }],
				details: { results },
			};
		},
	});

}
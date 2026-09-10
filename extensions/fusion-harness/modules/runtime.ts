/**
 * runtime.ts — the harness's shared vocabulary.
 *
 * Everything here is a data type, a constant, or a pure function: roles and their
 * glyphs/colors, the AgentRun lifecycle (live child state → serializable AgentStat),
 * the FhDetails panel contract, tool allowlists, and the small formatting helpers
 * every other module leans on. No pi APIs, no processes, no filesystem.
 */

import type { HexColor, ModelSlot, ModelStack, Thinking } from "./model-stack.ts";

// ═══ Tool allowlists ═════════════════════════════════════════════════════════

export const READONLY_TOOLS = "read,grep,find,ls"; // parallel agents share a cwd — concurrent writers would collide
export const FULL_TOOLS = "read,grep,find,ls,bash,edit,write"; // sequential agents (builder, fuser) act freely
// The VALIDATOR reads the project read-only but must WRITE its gate straight to disk:
// piping a gate through a fenced code block truncates it at the first embedded ``` (a
// gate that greps for markdown fences contains one), so the script is written, not pasted.
// `write` is scoped to the run's gate path by the VALIDATOR's system prompt — it still
// never touches the project, and it gets no `edit`/`bash` to mutate one with. The TRIAGE
// turn holds the same toolset while the run's single gate repair is unused (a GATE DEFECT
// diagnosis may rewrite the gate at that one path), then drops to READONLY_TOOLS.
export const VALIDATOR_TOOLS = "read,grep,find,ls,write";
// Critics are hostile AUDITORS, never authors: they read the real artifact and nothing
// else. Enforced by tools, not by instruction — a critic that cannot write cannot
// "helpfully" fix what it was asked to judge.
export const CRITIC_TOOLS = "read,grep,find,ls";

// ═══ Shared limits ═══════════════════════════════════════════════════════════

export const ANSWER_MAX_BYTES = 100_000; // cap any rendered agent answer
export const DETAIL_SNIPPET_MAX = 4_000; // chars of script/output kept in message details
export const GATE_TIMEOUT_MS = 120_000; // `uv run` of the validation gate

export const CUSTOM_TYPE = "fusion-harness"; // customType tag on every panel/widget/status this extension emits
export const BOOT_TYPE = "fusion-harness-boot"; // the boot banner's own tag — a session ENTRY, never an LLM-context message

// ═══ Roles ═══════════════════════════════════════════════════════════════════

/**
 * Display roles. These are NOT config entities — the YAML stack defines SLOTS
 * (model + thinking + color), and a command dresses a slot in whichever role it is
 * playing for that turn. VALIDATOR is the architect slot holding the gate contract;
 * CRITIC/ADJUDICATOR/INTEGRATOR are the three /fh-gauntlet hats.
 */
export type Role = "ARCHITECT" | "BUILDER" | "FUSION" | "VALIDATOR" | "CRITIC" | "ADJUDICATOR" | "INTEGRATOR";

/** Roles whose NAME is fixed by the slot they wear (architect vs builder), not by the hat. */
export const SLOT_NAMED_ROLES: ReadonlySet<Role> = new Set<Role>(["ARCHITECT", "BUILDER"]);

/** One consistent color per role, everywhere (columns, footer, panels, errors). */
export const ROLE_COLOR: Record<Role, "accent" | "warning" | "success" | "mdLink" | "error"> = {
	ARCHITECT: "accent",
	BUILDER: "warning",
	FUSION: "success",
	VALIDATOR: "mdLink",
	// The gauntlet hats. CRITIC is deliberately the error hue — a hostile auditor's
	// column should not read as friendly progress.
	CRITIC: "error",
	ADJUDICATOR: "accent",
	INTEGRATOR: "success",
};

/** One consistent glyph per role, paired with the color above. */
export const ROLE_GLYPH: Record<Role, string> = {
	ARCHITECT: "◆",
	BUILDER: "▲",
	FUSION: "⧉",
	VALIDATOR: "✓",
	CRITIC: "⚔",
	ADJUDICATOR: "⚖",
	INTEGRATOR: "⊕",
};

/** Render an actual configured #RRGGBB slot color without consuming a pi theme token. */
export function fgHex(color: HexColor, text: string): string {
	const value = color.slice(1);
	const r = Number.parseInt(value.slice(0, 2), 16);
	const g = Number.parseInt(value.slice(2, 4), 16);
	const b = Number.parseInt(value.slice(4, 6), 16);
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

// ═══ Run lifecycle types ═════════════════════════════════════════════════════

/** Lifecycle of one spawned child agent, from queued to settled. */
export type ChildStatus = "pending" | "working" | "done" | "failed" | "timeout" | "aborted";

/** One entry in an agent's transcript flow: a tool call, a finished text block, or a reasoning block. */
export type FlowItem = { type: "tool"; label: string } | { type: "text"; text: string } | { type: "thinking"; text: string };

/** Live + final view of one child agent. Mutated in place as JSON events stream in. */
export interface AgentRun {
	role: Role;
	model: string;
	slot?: ModelSlot;
	status: ChildStatus;
	startedAt?: number;
	endedAt?: number;
	ms: number;
	tokensIn: number;
	tokensOut: number;
	costUsd: number;
	toolCalls: number;
	toolNames: string[];
	toolEvents: Array<{ name: string; argument: string }>;
	ctxTokens: number; // context used by the last request (for the footer bar)
	// TPS accounting (see the tps extension's semantics): output tokens over observed
	// provider-response seconds. For a child, a "response" segment runs from spawn (or
	// the last tool_execution_end) to an assistant message_end that carried output
	// tokens — network/retries/thinking included, tool execution excluded.
	tpsSeconds: number; // accumulated provider-response seconds across this run's turns
	tpsSegmentStart?: number; // performance.now() at the current segment's start (transient)
	thinking?: string;
	flow: FlowItem[]; // the agent's transcript flow: tool lines + finished text blocks
	flowMark: number; // flow index at the current spawn — the widget only shows flow from HERE (no stale rounds)
	sessionRef?: string; // the child's own session id (from its "session" event) — lets later rounds resume it
	streamText: string; // text of the in-flight assistant message
	streamThinking: string; // reasoning of the in-flight assistant message (rendered live — proof of life)
	text: string;
	exitCode: number;
	stopReason?: string;
	errorMessage?: string;
	stderr: string;
}

/** Serializable per-agent stats for message details / artifacts. */
export interface AgentStat {
	role: Role;
	model: string;
	slotId?: string;
	slotName?: string;
	color?: HexColor;
	primary?: boolean;
	architect?: boolean;
	status: ChildStatus;
	ms: number;
	tokensIn: number;
	tokensOut: number;
	costUsd: number;
	toolCalls: number;
	toolNames: string[];
	toolEvents: Array<{ name: string; argument: string }>;
	tps?: number; // observed output tokens/second for this run (throughput-weighted)
	chars: number;
	error?: string;
}

/** The renderer's discriminated payload — one shape per panel `kind`, carried on every custom message. */
export interface FhDetails {
	kind:
		| "prompt"
		| "banner"
		| "duo"
		| "multi"
		| "sync"
		| "stopped"
		| "fused"
		| "opinion"
		| "gate"
		| "validation"
		| "triage"
		| "error"
		| "system-prompt"
		| "solo" // /fh-only — one selected agent, one full-width answer
		| "closing" // /fh-debate — the final round: two closing statements, side by side
		| "collab" // /fh-collaborate — the shared deliverable after the last turn
		| "rubric" // /fh-gauntlet — the acceptance bar, written before any build
		| "verdicts" // /fh-gauntlet — one round of blind critic verdicts, side by side
		| "gauntlet"; // /fh-gauntlet — the adjudicated round result / final deliverable
	command?: string; // the slash command that produced this panel ("fh-fusion", …)
	title?: string; // duo panels: what THIS pair of columns is (e.g. "round 2 — rebuttals")
	ok: boolean;
	round?: number; // auto-validate: which build→validate round this panel reports
	maxRounds?: number; // auto-validate: the --max-validations cap
	escalateAt?: number; // auto-validate: the --escalate-to-validator-count threshold
	prompt?: string;
	fusionPrompt?: string;
	roles?: Array<{ role: Role; model: string; slotId?: string; slotName?: string; color?: HexColor; primary?: boolean; architect?: boolean }>;
	agent?: AgentStat; // fused: the fuser · validation: the validator
	sources?: AgentStat[]; // the two columns' stats (left, right)
	answers?: Array<{ role: Role; model: string; text: string; slotId?: string; slotName?: string; color?: HexColor; primary?: boolean }>; // agent bodies in display order
	script?: string; // validation gate (truncated for details)
	gateOutput?: string;
	gateExitCode?: number;
	scriptPath?: string;
	artifactsDir?: string;
	criteriaTotal?: number; // /fh-gauntlet — size of the rubric
	criteriaPassed?: number; // /fh-gauntlet — criteria cleared by consensus this round
	stopReason?: string; // /fh-gauntlet — why the loop ended (passed | plateau | exhausted)
	totalMs?: number;
	totalCostUsd?: number;
	error?: string;
}

// ═══ Formatting helpers ══════════════════════════════════════════════════════

/** Truncate by character count, with an explicit elision marker (prompt handoffs). */
export function truncateChars(s: string, max: number): string {
	if (s.length <= max) return s;
	return `${s.slice(0, max)}\n… [truncated — ${s.length - max} chars elided]`;
}

/** Truncate by UTF-8 byte count (panel bodies — pi caps message size in bytes). */
export function truncateBytes(s: string, max: number): string {
	const buf = Buffer.from(s, "utf-8");
	if (buf.length <= max) return s;
	return `${buf.subarray(0, max).toString("utf-8")}\n\n… [truncated — ${buf.length - max} bytes elided]`;
}

export function splitUtf8(text: string, maxBytes: number): string[] {
	const chunks: string[] = [];
	let current = "";
	let bytes = 0;
	for (const char of text) {
		const size = Buffer.byteLength(char, "utf8");
		if (current && bytes + size > maxBytes) {
			chunks.push(current);
			current = "";
			bytes = 0;
		}
		current += char;
		bytes += size;
	}
	if (current || !chunks.length) chunks.push(current);
	return chunks;
}

/** 12345 → "12.3s" */
export function fmtSecs(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

/** 12345 → "12.3k" (token counts) */
export function fmtK(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

/** Display-width model name: provider stripped, ellipsized past 24 chars (labels only — never paths). */
export function shortModel(m: string): string {
	const seg = m.split("/").pop() ?? m;
	return seg.length > 24 ? `${seg.slice(0, 23)}…` : seg;
}

/**
 * Filename-safe model tag: provider stripped, anything but [A-Za-z0-9._-] collapsed to `-`.
 * NOT shortModel(): that truncates long ids with a `…`, and these tags land in real paths.
 */
export function modelTag(m: string): string {
	return (m.split("/").pop() ?? m).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "model";
}

/**
 * A tool call's argument, condensed for one flow line.
 *
 * The cap here is a MEMORY bound, not a layout one — it must stay far wider than any
 * column so a wide terminal shows a wide line. Fitting is the renderer's job: TwoCol
 * (`truncateToWidth` per column) and `FullWidth` (`fitLines`) clamp to the real width at
 * render, which is what actually keeps pi from throwing on an over-wide line. Capping at
 * capture instead trimmed every view to the narrowest one it might ever be drawn in.
 */
const TOOL_ARG_MAX = 200;
export function briefArg(args: any): string {
	if (!args || typeof args !== "object") return "";
	const v =
		args.path ?? args.file_path ?? args.filePath ?? args.pattern ?? args.command ?? Object.values(args).find((x) => typeof x === "string");
	if (typeof v !== "string" || !v) return "";
	const s = v.includes("/") && !v.includes(" ") ? v.split("/").slice(-2).join("/") : v;
	return s.replace(/\s+/g, " ").slice(0, TOOL_ARG_MAX);
}

/** One glyph per child status, used in state lines and stat rows. */
export const STATUS_GLYPH: Record<ChildStatus, string> = {
	pending: "○",
	working: "◐",
	done: "✓",
	failed: "✗",
	timeout: "✗",
	aborted: "⊘",
};

/** Footer-width abbreviations for pi's thinking levels (pi: ModelThinkingLevel). */
export const THINKING_SHORT: Record<string, string> = {
	off: "none",
	minimal: "min",
	low: "low",
	medium: "med",
	high: "hi",
	xhigh: "xhi",
	max: "max",
};
/** ` (med)` — the parenthesized short thinking level appended to a model label. */
export const thinkingTag = (level?: string): string => (level ? ` (${THINKING_SHORT[level] ?? level})` : "");

// ═══ Run lifecycle helpers ═══════════════════════════════════════════════════

/** A fresh AgentRun in its zero state — mutated in place by runChild as events stream. */
export function newRun(role: Role, model: string, slot?: ModelSlot): AgentRun {
	return {
		role,
		model,
		slot,
		status: "pending",
		ms: 0,
		tokensIn: 0,
		tokensOut: 0,
		costUsd: 0,
		toolCalls: 0,
		toolNames: [],
		toolEvents: [],
		ctxTokens: 0,
		tpsSeconds: 0,
		streamThinking: "",
		flow: [],
		flowMark: 0,
		streamText: "",
		text: "",
		exitCode: 0,
		stderr: "",
	};
}

/** Success = clean exit ∧ clean stop reason ∧ nonempty answer. */
export function runOk(r: AgentRun): boolean {
	return r.exitCode === 0 && r.stopReason !== "error" && r.stopReason !== "aborted" && r.text.trim().length > 0;
}

/** The most specific failure description available, in priority order. */
export function runError(r: AgentRun): string {
	return (
		(r.status === "aborted" ? "stopped by user (escape)" : "") ||
		r.errorMessage ||
		(r.status === "timeout" || r.exitCode === 124 ? "timed out" : "") ||
		r.stderr.trim().slice(-300) ||
		(r.text.trim() ? "" : "no output") ||
		`exit ${r.exitCode}`
	);
}

/**
 * Observed output tokens/second for a run: Σ output tokens ÷ Σ provider-response
 * seconds (throughput-weighted, never a mean of per-turn readings). Undefined until
 * both are nonzero — no division-by-zero readouts.
 */
export function runTps(r: AgentRun): number | undefined {
	return r.tokensOut > 0 && r.tpsSeconds > 0 ? r.tokensOut / r.tpsSeconds : undefined;
}

/** Freeze a live AgentRun into the serializable stat used by panels and summary.json. */
export function toStat(r: AgentRun): AgentStat {
	return {
		role: r.role,
		model: r.model,
		slotId: r.slot?.id,
		slotName: r.slot?.name,
		color: r.slot?.color,
		primary: r.slot?.primary,
		architect: r.slot?.architect,
		status: r.status,
		ms: r.ms,
		tokensIn: r.tokensIn,
		tokensOut: r.tokensOut,
		costUsd: r.costUsd,
		toolCalls: r.toolCalls,
		toolNames: [...r.toolNames],
		toolEvents: r.toolEvents.map((event) => ({ ...event })),
		tps: runTps(r),
		chars: r.text.length,
		error: runOk(r) ? undefined : runError(r),
	};
}

/** Compact one-line stats: `12.3s · in 1.2k out 0.4k · 87 tps · 3 tools · $0.0123` — full-width headers only. */
export function statLine(s: AgentStat): string {
	const parts = [fmtSecs(s.ms)];
	if (s.tokensIn || s.tokensOut) parts.push(`in ${fmtK(s.tokensIn)} out ${fmtK(s.tokensOut)}`);
	if (s.tps) parts.push(`${Math.round(s.tps)} tps`);
	if (s.toolCalls) parts.push(`${s.toolCalls} tools`);
	if (s.costUsd) parts.push(`$${s.costUsd.toFixed(4)}`);
	return parts.join(" · ");
}

/**
 * Labeled one-stat-per-line block for NARROW side-by-side columns, where the compact
 * line truncates: `TIME: 12.3s` / `TOKENS IN: 1.2k` / … Only present values render.
 */
export function statLines(s: AgentStat): string[] {
	const lines = [`TIME: ${fmtSecs(s.ms)}`];
	if (s.tokensIn) lines.push(`TOKENS IN: ${fmtK(s.tokensIn)}`);
	if (s.tokensOut) lines.push(`TOKENS OUT: ${fmtK(s.tokensOut)}`);
	if (s.tps) lines.push(`TPS: ${Math.round(s.tps)}`);
	if (s.toolCalls) lines.push(`TOOLS: ${s.toolCalls}`);
	if (s.costUsd) lines.push(`COST: $${s.costUsd.toFixed(4)}`);
	return lines;
}

/** Clamp a user-supplied count to [1, 20], falling back when unparsable. */
export const clampCount = (n: number, fallback: number): number => (Number.isFinite(n) && n >= 1 ? Math.min(20, Math.floor(n)) : fallback);

// ═══ The command modules' contract with the extension factory ════════════════

/** How a child lands in a session: fork the host, resume an earlier child, or pin a persistent id. */
export type SpawnIdentity = { fork?: string; sessionDir: string; sessionId?: string; resume?: string };

/**
 * Everything a command module needs from the extension factory. The factory owns pi
 * wiring, flags/config, persistent sessions, widgets, and panel plumbing; command
 * modules own orchestration logic. Keep this surface explicit — it IS the seam.
 */
export interface HarnessDeps {
	// panels + live widgets
	panel(details: FhDetails, content: string): void;
	stoppedPanel(command: string, runs: AgentRun[], artifactsDir: string, startedAt: number, what: string): void;
	/**
	 * Fold extra runs into the model bar's per-slot memory (context %, tps, cost). The
	 * live widgets absorb the runs they were STARTED with at stop — a command that spawns
	 * additional runs afterward (the fusion ACK turns) must hand them in itself, AFTER its
	 * widget stops, so the remembered per-slot reading ends on the latest session state.
	 */
	absorbRuns(runs: AgentRun[]): void;
	startStoppable(ctx: any, command: string): { signal: AbortSignal; stopped: () => boolean; release: () => void };
	startWidget(ctx: any, command: string, cols: [AgentRun, AgentRun], span: AgentRun | undefined, startedAt: number): () => void;
	startGridWidget(ctx: any, command: string, runs: AgentRun[], span: AgentRun | undefined, startedAt: number): () => void;
	// stack + host
	noteHost(ctx: any): void;
	modelStack(): ModelStack;
	architectModel(): string;
	builderModel(): string;
	// spawn identities + persistent sessions
	newSlotRun(slot: ModelSlot): AgentRun;
	slotInitialSpawn(slot: ModelSlot, ctx: any, artifactsDir: string): SpawnIdentity;
	slotNextSpawn(slot: ModelSlot, run: AgentRun, initial: SpawnIdentity, ctx: any): SpawnIdentity;
	builderSpawn(ctx: any, artifactsDir: string): SpawnIdentity;
	roleSession(side: "architect" | "builder", cwd: string): { id: string; dir: string };
	roleThinking(side: "architect" | "builder"): Thinking;
	roleSystemPrompt(side: "architect" | "builder"): string | undefined;
	cachedRoleId(side: "architect" | "builder"): string | undefined;
	cachedSlotId(slot: ModelSlot): string | undefined;
	// timeouts + flags
	childTimeoutMs(): number;
	buildTimeoutMs(): number;
	flagStr(name: string): string;
	// artifacts
	mkArtifacts(): Promise<string>;
	save(dir: string, name: string, body: string): Promise<void>;
	ensureSummary(dir: string, payload: Record<string, unknown>): Promise<void>;
	totals(runs: AgentRun[], startedAt: number): { totalMs: number; totalCostUsd: number };
}

/**
 * tui.ts — everything the harness draws.
 *
 * Layout primitives (TwoCol, responsive AgentGrid, FullWidth), the role/slot label
 * builders, the live streaming column each running agent renders into, and the
 * transcript panel renderer for every FhDetails kind. All functions take the theme
 * (and width) as parameters — no pi session state lives here.
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { computeAgentGridLayout } from "./agent-layout.ts";
import type { HexColor, ModelSlot } from "./model-stack.ts";
import {
	fgHex,
	fmtK,
	fmtSecs,
	ROLE_COLOR,
	ROLE_GLYPH,
	SLOT_NAMED_ROLES,
	runError,
	runTps,
	shortModel,
	STATUS_GLYPH,
	statLine,
	statLines,
	thinkingTag,
	toStat,
	type AgentRun,
	type AgentStat,
	type FhDetails,
	type Role,
} from "./runtime.ts";

export const WIDGET_FLOW_LINES = 8; // live streaming lines shown per column
export const MIN_TWO_COL_WIDTH = 100; // below this, columns stack
export const MIN_AGENT_COLUMN_WIDTH = 34;

// ═══ Layout primitives ═══════════════════════════════════════════════════════

/** Hard clamp: pi throws on any rendered line wider than the terminal, so every line we emit must fit. */
export function fitLines(lines: string[], width: number): string[] {
	const w = Math.max(1, width);
	return lines.map((l) => (visibleWidth(l) > w ? truncateToWidth(l, w) : l));
}

/**
 * The core layout primitive: two columns we completely control, rendered at
 * whatever width the TUI gives us. Below MIN_TWO_COL_WIDTH the columns stack
 * (left block, then right block) so narrow terminals stay readable.
 */
export class TwoCol {
	constructor(
		private build: (colW: number, stacked: boolean) => { left: string[]; right: string[] },
		private gutter: string = "  ",
	) {}
	render(width: number): string[] {
		// Narrow terminal: stack left block over right block instead of squeezing columns.
		if (width < MIN_TWO_COL_WIDTH) {
			const { left, right } = this.build(Math.max(20, width), true);
			return fitLines([...left, "", ...right], width);
		}
		const gw = visibleWidth(this.gutter);
		const colW = Math.floor((width - gw) / 2); // equal halves of what's left after the gutter
		const { left, right } = this.build(colW, false);
		const out: string[] = [];
		const n = Math.max(left.length, right.length);
		// Zip the two columns row by row: clamp left, pad it to the column edge, gutter, clamp right.
		for (let i = 0; i < n; i++) {
			const l = truncateToWidth(left[i] ?? "", colW);
			const pad = " ".repeat(Math.max(0, colW - visibleWidth(l)));
			out.push(l + pad + this.gutter + truncateToWidth(right[i] ?? "", colW));
		}
		return fitLines(out, width);
	}
	invalidate() {} // pi-tui Component contract — nothing cached to invalidate
}

/** Responsive 1-5 agent grid. If any column would be narrower than 34 cells, stack vertically. */
export class AgentGrid {
	constructor(
		private count: number,
		private build: (index: number, colW: number, stacked: boolean) => string[],
		private gutter: string = " │ ",
	) {}
	render(width: number): string[] {
		const layout = computeAgentGridLayout(width, this.count, visibleWidth(this.gutter), MIN_AGENT_COLUMN_WIDTH);
		const count = layout.count;
		const colW = layout.columnWidth;
		if (layout.stacked) {
			const blocks = Array.from({ length: count }, (_, index) => fitLines(this.build(index, Math.max(20, width), true), width));
			return blocks.flatMap((block, index) => (index === blocks.length - 1 ? block : [...block, ""]));
		}
		const columns = Array.from({ length: count }, (_, index) => this.build(index, colW, false));
		const rows = Math.max(...columns.map((column) => column.length), 0);
		const out: string[] = [];
		for (let row = 0; row < rows; row++) {
			let line = "";
			for (let column = 0; column < count; column++) {
				const value = truncateToWidth(columns[column][row] ?? "", colW);
				line += value;
				if (column < count - 1) line += " ".repeat(Math.max(0, colW - visibleWidth(value))) + this.gutter;
			}
			out.push(line);
		}
		return fitLines(out, width);
	}
	invalidate() {}
}

/**
 * A full-width row (the FUSION merge stage), rendered at the width the TUI actually gives
 * us — the same clamp discipline as TwoCol, one column instead of two. It exists so the
 * span row can't be pinned to a guessed width: hardcoding one trims a 200-col terminal to
 * the guess, and guessing high would emit lines wider than a narrow terminal (which pi
 * throws on). Ask for the width, then fit to it.
 */
export class FullWidth {
	constructor(private build: (w: number) => string[]) {}
	render(width: number): string[] {
		const inner = Math.max(20, width - 2); // leave room for the 1-col pad on each side
		return fitLines(
			this.build(inner).map((l) => ` ${l}`),
			width,
		);
	}
	invalidate() {} // pi-tui Component contract — nothing cached to invalidate
}

/** Wrap possibly-styled text to a column width, defensively. */
export function wrapCol(text: string, colW: number): string[] {
	try {
		return wrapTextWithAnsi(text, Math.max(10, colW));
	} catch {
		return text.split("\n");
	}
}

/** Render markdown to styled lines at a column width (the "same output as pi" body). */
export function mdLines(text: string, colW: number): string[] {
	try {
		return new Markdown(text || "(no output)", 0, 0, getMarkdownTheme()).render(Math.max(10, colW));
	} catch {
		return wrapCol(text, colW);
	}
}

// ═══ Labels ══════════════════════════════════════════════════════════════════

/** `◆ ARCHITECT | name | model` — the role-colored label that opens every column and cell. */
export const roleLabelStr = (theme: any, role: Role, model: string, bold = true, sep = " | ", slot?: ModelSlot) => {
	// A slot only DICTATES the label for the two slot-named roles. Any other hat the slot
	// is wearing (CRITIC, ADJUDICATOR, INTEGRATOR, VALIDATOR, FUSION) keeps its own name —
	// otherwise every gauntlet column would read "BUILDER" and the flow would be unreadable.
	const roleName = slot && SLOT_NAMED_ROLES.has(role) ? (slot.architect ? "ARCHITECT" : "BUILDER") : role;
	const label = `${ROLE_GLYPH[role]} ${roleName}${slot ? ` | ${slot.name}` : ""}`;
	if (slot) return fgHex(slot.color, bold ? theme.bold(label) : label) + theme.fg("dim", sep) + fgHex(slot.color, shortModel(model));
	return theme.fg(ROLE_COLOR[role], bold ? theme.bold(label) : label) + theme.fg("dim", sep) + theme.fg(ROLE_COLOR[role], shortModel(model));
};

export const statLabelStr = (theme: any, stat: AgentStat): string => {
	if (!stat.color || !stat.slotName) return roleLabelStr(theme, stat.role, stat.model);
	const roleName = SLOT_NAMED_ROLES.has(stat.role) ? (stat.architect ? "ARCHITECT" : "BUILDER") : stat.role;
	return fgHex(stat.color, theme.bold(`${ROLE_GLYPH[stat.role]} ${roleName} | ${stat.slotName}`)) + theme.fg("dim", " | ") + fgHex(stat.color, shortModel(stat.model));
};

/**
 * One model-bar cell: `◆ ARCHITECT | model (med) | [██--------] 12% | 87 tps | $0.0123`.
 * EVERY content segment carries the role's own color — glyph, role, model, thinking
 * level, context bar, and perf readout alike — so a cell reads as one ARCHITECT-blue /
 * BUILDER-orange line and the role stays identifiable from any part of it. Only the `|`
 * separators are theme-colored (`dim`), which some themes render as a bright hue rather
 * than a muted one — so keep separators the ONLY non-role segment, or the cell loses
 * its identity. `perfStr` is the optional speed/cost tail (session tps + spend per slot).
 */
export const cellStr = (theme: any, role: Role, model: string, thinking: string | undefined, barStr: string, slot?: ModelSlot, perfStr?: string): string => {
	const sep = theme.fg("dim", " | ");
	if (slot) return roleLabelStr(theme, role, model, false, " | ", slot) + fgHex(slot.color, thinkingTag(thinking)) + sep + fgHex(slot.color, barStr) + (perfStr ? sep + fgHex(slot.color, perfStr) : "");
	return roleLabelStr(theme, role, model, false, " | ") + theme.fg(ROLE_COLOR[role], thinkingTag(thinking)) + sep + theme.fg(ROLE_COLOR[role], barStr) + (perfStr ? sep + theme.fg(ROLE_COLOR[role], perfStr) : "");
};

/** One agent's live column: label, state line, then its flow tail (tools + streaming text). */
export const liveColumn = (theme: any, r: AgentRun | undefined, colW: number): string[] => {
	if (!r) return [];
	const now = Date.now();
	const elapsed = r.startedAt ? (r.endedAt ?? now) - r.startedAt : 0;
	const state =
		r.status === "pending" ? "waiting" : r.status === "working" ? `working ${Math.floor(elapsed / 1000)}s` : `${r.status} ${fmtSecs(elapsed)}`;
	const stateColor = r.status === "done" ? "success" : r.status === "working" ? ROLE_COLOR[r.role] : r.status === "pending" ? "dim" : "error";
	const bits = [`${STATUS_GLYPH[r.status]} ${state}`];
	if (r.tokensIn || r.tokensOut) bits.push(`in ${fmtK(r.tokensIn)} out ${fmtK(r.tokensOut)}`);
	const tps = runTps(r);
	if (tps) bits.push(`${Math.round(tps)} tps`);
	if (r.costUsd) bits.push(`$${r.costUsd.toFixed(4)}`);
	const lines: string[] = [roleLabelStr(theme, r.role, r.model, true, " | ", r.slot), theme.fg(stateColor, bits.join(" · "))];

	// DONE agents collapse to a labeled stat block (one value per line — narrow columns
	// truncate the compact form) — the full output lives in the transcript panel;
	// re-streaming it here would duplicate what's already shown.
	if (r.status === "done") {
		const stats = statLines(toStat(r)).map((line, index) => theme.fg("success", index === 0 ? `${STATUS_GLYPH.done} ${line}` : `  ${line}`));
		return [lines[0], ...stats];
	}
	if (r.status === "failed" || r.status === "timeout") {
		lines.push(theme.fg("error", `✗ ${runError(r)}`));
		return lines;
	}

	// WORKING agents stream only the CURRENT spawn's flow (from flowMark) — never
	// stale text from earlier rounds — plus the in-flight message text.
	// Three visually distinct flows, same right-facing-triangle family:
	//   ▸ solid + toolTitle    → tool calls (what it DID)
	//   ▹ hollow + thinkingText italic → reasoning (what it's THINKING) — pi's own thinking
	//     color/italic, so it tracks the theme instead of a hardcoded purple
	//   plain muted/text       → its answer
	const thinkLines = (text: string): string[] =>
		wrapCol(text, colW).map((l, i) => theme.italic(theme.fg("thinkingText", i === 0 ? `▹ ${l}` : `  ${l}`)));
	const flowLines: string[] = [];
	for (const item of r.flow.slice(r.flowMark).slice(-6)) {
		if (item.type === "tool") flowLines.push(theme.fg("toolTitle", `▸ ${item.label}`));
		else if (item.type === "thinking") flowLines.push(...thinkLines(item.text));
		else for (const l of wrapCol(item.text, colW)) flowLines.push(theme.fg("muted", l));
	}
	// Reasoning stays on screen for the WHOLE turn, above the answer it produced — the same
	// order the model emits them. (Hiding it as soon as text starts made it near-invisible:
	// a turn can stream its whole reasoning between two 1s widget ticks.)
	if (r.streamThinking) flowLines.push(...thinkLines(r.streamThinking));
	if (r.streamText) for (const l of wrapCol(r.streamText, colW)) flowLines.push(theme.fg("text", l));
	lines.push(...flowLines.slice(-WIDGET_FLOW_LINES));
	return lines;
};

// ═══ The transcript panel renderer ═══════════════════════════════════════════
// Results render FULL-HEIGHT (like normal pi assistant messages) so they land in the
// terminal scrollback and scroll naturally — no hidden lines behind an expand toggle.

/** Render one fusion-harness custom message into a pi-tui component tree. */
export function renderFhPanel(message: any, theme: any): any {
	const d = (message.details ?? {}) as FhDetails;
	const content =
		typeof message.content === "string" ? message.content : message.content.map((c: any) => (c.type === "text" ? c.text : "")).join("");

	// Sessions recorded before the banner became an entry still carry a boot
	// custom message; hand those back to pi's default rendering rather than an empty panel.
	if ((d.kind as string) === "boot") return undefined;

	// The echoed prompt: styled exactly like a normal pi user message.
	if (d.kind === "prompt") {
		const box = new Box(1, 1, (t: string) => theme.bg("userMessageBg", t));
		box.addChild(new Text(theme.fg("userMessageText", content), 1, 0));
		return box;
	}

	const inner = new Container();
	const add = (c: any) => inner.addChild(c);
	const blank = () => add(new Text("", 0, 0));

	/** One finished agent as a column: label + labeled stat block + full markdown body. */
	const finalColumn = (s: AgentStat | undefined, body: string, colW: number): string[] => {
		if (!s) return [];
		// One stat per line (TIME/TOKENS/TPS/COST): side-by-side columns are narrow, and
		// the compact one-line form truncated exactly the numbers worth comparing.
		const stats = statLines(s).map((line, index) => theme.fg(s.error ? "error" : "dim", index === 0 ? `${STATUS_GLYPH[s.status]} ${line}` : `  ${line}`));
		const lines: string[] = [statLabelStr(theme, s), ...stats, ""];
		if (s.error) lines.push(theme.fg("error", theme.bold(`✗ FAILED — ${s.error}`)));
		lines.push(...mdLines(body, colW));
		return lines;
	};

	const duoBody = () => {
		const [ls, rs] = [d.sources?.[0], d.sources?.[1]];
		const [la, ra] = [d.answers?.[0], d.answers?.[1]];
		add(new TwoCol((colW) => ({ left: finalColumn(ls, la?.text ?? "", colW), right: finalColumn(rs, ra?.text ?? "", colW) }), theme.fg("dim", " │ ")));
	};

	const multiBody = () => {
		const sources = d.sources ?? [];
		const answers = d.answers ?? [];
		add(new AgentGrid(Math.max(sources.length, answers.length), (index, colW) => {
			const source = sources[index];
			const answer = source?.slotId ? answers.find((candidate) => candidate.slotId === source.slotId) : answers[index];
			return finalColumn(source, answer?.text ?? "", colW);
		}, theme.fg("dim", " │ ")));
	};

	const md = (body: string) => {
		add(new Markdown(body || "(no output)", 1, 0, getMarkdownTheme()));
	};

	switch (d.kind) {
		case "banner": {
			add(new Text(theme.fg("customMessageLabel", theme.bold(`FUSION HARNESS · /${d.command}`)), 1, 0));
			for (const r of d.roles ?? []) {
				const stat: AgentStat = { ...r, status: "done", ms: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, toolCalls: 0, toolNames: [], toolEvents: [], chars: 0 };
				add(new Text(`  ${statLabelStr(theme, stat)}`, 1, 0));
			}
			if (d.prompt) add(new Text(theme.fg("muted", `  prompt: ${d.prompt.replace(/\s+/g, " ").slice(0, 100)}`), 1, 0));
			if (d.fusionPrompt) add(new Text(theme.fg("muted", `  fusion: ${d.fusionPrompt.replace(/\s+/g, " ").slice(0, 100)}`), 1, 0));
			if (d.maxRounds)
				add(
					new Text(
						theme.fg("muted", `  max validations: ${d.maxRounds}${d.escalateAt ? ` · validator triage from failure ${d.escalateAt}` : ""}`),
						1,
						0,
					),
				);
			break;
		}
		case "duo":
		case "opinion": {
			const title =
				d.title !== undefined
					? `FUSION HARNESS · /${d.command} — ${d.title}`
					: d.kind === "opinion"
						? "◆ OPINION — side by side"
						: `FUSION HARNESS · /${d.command} — both agents`;
			add(new Text(theme.fg("customMessageLabel", theme.bold(title)), 1, 0));
			blank();
			duoBody();
			break;
		}
		case "multi": {
			add(new Text(theme.fg("customMessageLabel", theme.bold(d.title ?? `FUSION HARNESS · /${d.command} — all agents`)), 1, 0));
			blank();
			multiBody();
			break;
		}
		case "sync": {
			add(new Text(theme.fg(d.ok ? "success" : "warning", theme.bold(d.ok ? "✓ CONTEXT SYNC — all agents acknowledged" : "⚠ CONTEXT SYNC INCOMPLETE")), 1, 0));
			blank();
			md(content);
			break;
		}
		case "system-prompt": {
			// One responsive column per configured slot. No stats row: nothing ran.
			add(new Text(theme.fg("customMessageLabel", theme.bold("FUSION HARNESS · /fh-system-prompt — what each role runs with")), 1, 0));
			blank();
			const answers = d.answers ?? [];
			const spCol = (a: (typeof answers)[number] | undefined, colW: number): string[] => {
				if (!a) return [];
				const stat: AgentStat = { role: a.role, model: a.model, slotId: a.slotId, slotName: a.slotName, color: a.color, primary: a.primary, architect: a.role === "ARCHITECT", status: "done", ms: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, toolCalls: 0, toolNames: [], toolEvents: [], chars: a.text.length };
				return [statLabelStr(theme, stat), "", ...mdLines(a.text, colW)];
			};
			add(new AgentGrid(answers.length, (index, colW) => spCol(answers[index], colW), theme.fg("dim", " │ ")));
			break;
		}
		case "fused": {
			const src = d.sources ?? [];
			const srcLabel = src.map((s) => (s.color && s.slotName ? fgHex(s.color, `${s.slotName}(${shortModel(s.model)})`) : theme.fg(ROLE_COLOR[s.role], `${s.role}(${shortModel(s.model)})`))).join(theme.fg("dim", " ⊕ "));
			add(
				new Text(
					theme.fg("success", theme.bold(`⧉ FUSED`)) +
						theme.fg("dim", " ← ") +
						srcLabel +
						(d.agent ? theme.fg("dim", `   ${STATUS_GLYPH[d.agent.status]} ${statLine(d.agent)}`) : ""),
					1,
					0,
				),
			);
			if (d.agent) add(new Text(theme.fg("dim", `  fused by ${d.agent.role} model ${d.agent.model} (fresh session)`), 1, 0));
			blank();
			md(content);
			break;
		}
		case "solo": {
			// One agent, so there is no second column to align against: label + stats, then
			// the answer full width. The role color still says whose brain you are reading.
			const s = d.agent;
			add(
				new Text(
					(s ? statLabelStr(theme, s) : theme.fg("customMessageLabel", theme.bold("◆ ARCHITECT"))) +
						(s ? theme.fg("dim", `   ${STATUS_GLYPH[s.status]} ${statLine(s)}`) : ""),
					1,
					0,
				),
			);
			blank();
			md(content);
			break;
		}
		case "closing": {
			// The debate's terminal panel: BOTH closing statements, side by side. No winner
			// is declared here on purpose — the value was the cross-examination, and the two
			// hardened answers are the deliverable. You are the judge.
			const src = d.sources ?? [];
			const srcLabel = src.map((s) => (s.color && s.slotName ? fgHex(s.color, `${s.slotName}(${shortModel(s.model)})`) : theme.fg(ROLE_COLOR[s.role], `${s.role}(${shortModel(s.model)})`))).join(theme.fg("dim", " ⚔ "));
			add(
				new Text(
					theme.fg("customMessageLabel", theme.bold(`⚔ CLOSING STATEMENTS`)) +
						theme.fg("dim", " · ") +
						srcLabel +
						theme.fg("dim", `   after ${d.round ?? "?"} round${(d.round ?? 0) === 1 ? "" : "s"} of cross-examination`),
					1,
					0,
				),
			);
			add(new Text(theme.fg("dim", "  no judge — every closing opinion survived the debate; compare coalitions, concessions, and remaining disagreements"), 1, 0));
			blank();
			multiBody();
			break;
		}
		case "collab": {
			// No "← sources" line here: a collaboration has no winner and no merger. The
			// agents co-own one artifact, so the header names them as a team.
			const src = d.sources ?? [];
			const srcLabel = src.map((s) => theme.fg(ROLE_COLOR[s.role], `${s.role}(${shortModel(s.model)})`)).join(theme.fg("dim", " ⇄ "));
			add(
				new Text(
					theme.fg("customMessageLabel", theme.bold(`⇄ COLLABORATION RESULT`)) +
						theme.fg("dim", " · ") +
						srcLabel +
						theme.fg("dim", `   ${d.round ?? "?"} task${(d.round ?? 0) === 1 ? "" : "s"}, last word: `) +
						(d.agent ? theme.fg(ROLE_COLOR[d.agent.role], d.agent.role) : theme.fg("dim", "?")),
					1,
					0,
				),
			);
			blank();
			md(content);
			break;
		}
		case "gate": {
			add(
				new Text(
					theme.fg("customMessageLabel", theme.bold(`FUSION HARNESS · /${d.command ?? "fh-auto-validate"} — `)) +
						theme.fg("mdLink", theme.bold(d.round ? `GATE REPAIRED ⚒ (after round ${d.round})` : "GATE DESIGNED ⛨")) +
						(d.agent ? theme.fg("dim", `   ${roleLabelStr(theme, d.agent.role, d.agent.model, false)}${theme.fg("dim", ` · ${statLine(d.agent)}`)}`) : ""),
					1,
					0,
				),
			);
			if (d.scriptPath) add(new Text(theme.fg("dim", `  gate: ${d.scriptPath} · runs after every build round · max ${d.maxRounds ?? "?"} validations`), 1, 0));
			blank();
			md(content);
			break;
		}
		case "triage": {
			add(
				new Text(
					theme.fg("customMessageLabel", theme.bold(`FUSION HARNESS · /fh-auto-validate — `)) +
						theme.fg("warning", theme.bold(`⚡ VALIDATOR TRIAGE`)) +
						theme.fg("dim", ` · escalated after ${d.round ?? "?"} failed validation${(d.round ?? 0) === 1 ? "" : "s"} (threshold ${d.escalateAt ?? "?"})`) +
						(d.agent ? theme.fg("dim", `   ${statLine(d.agent)}`) : ""),
					1,
					0,
				),
			);
			if (d.agent) add(new Text(`  ${roleLabelStr(theme, d.agent.role, d.agent.model)}` + theme.fg("dim", " · read-only diagnosis — brief travels with the next correction"), 1, 0));
			blank();
			md(content);
			break;
		}
		case "stopped": {
			add(new Text(theme.fg("warning", theme.bold(`⊘ FUSION HARNESS · /${d.command ?? "?"} STOPPED`)), 1, 0));
			if (content.trim()) {
				blank();
				md(content);
			}
			break;
		}
		case "validation": {
			const verdict = d.ok
				? theme.fg("success", theme.bold("GATE PASS ✓"))
				: theme.fg("error", theme.bold(`GATE FAIL ✗ (exit ${d.gateExitCode ?? "?"})`));
			const roundTag = d.round ? theme.fg("dim", ` · validation ${d.round}/${d.maxRounds ?? "?"}`) : "";
			add(
				new Text(theme.fg("customMessageLabel", theme.bold(`FUSION HARNESS · /fh-auto-validate — `)) + verdict + roundTag, 1, 0),
			);
			if (d.scriptPath) add(new Text(theme.fg("dim", `  gate: ${d.scriptPath}`), 1, 0));
			blank();
			duoBody();
			break;
		}
		case "rubric": {
			// The acceptance bar, rendered before anything is built. It is a deliverable in
			// its own right: if the bar is wrong, every round after it is wasted.
			add(
				new Text(
					theme.fg("customMessageLabel", theme.bold(`FUSION HARNESS · /${d.command ?? "fh-gauntlet"} — `)) +
						theme.fg("mdLink", theme.bold(`⛨ ACCEPTANCE BAR (${d.criteriaTotal ?? "?"} criteria)`)) +
						(d.agent ? theme.fg("dim", `   ${roleLabelStr(theme, d.agent.role, d.agent.model, false)} · ${statLine(d.agent)}`) : ""),
					1,
					0,
				),
			);
			add(new Text(theme.fg("dim", `  written before the build · judged by blind critics each round · max ${d.maxRounds ?? "?"} rounds`), 1, 0));
			blank();
			md(content);
			break;
		}
		case "verdicts": {
			// One round of the panel. Critics get columns like any other agent grid, because
			// WHO dissented matters as much as what they found.
			const cleared = d.criteriaPassed ?? 0;
			const total = d.criteriaTotal ?? 0;
			add(
				new Text(
					theme.fg("customMessageLabel", theme.bold(`⚔ BLIND CRITIC PANEL`)) +
						theme.fg("dim", ` · round ${d.round ?? "?"}/${d.maxRounds ?? "?"} · `) +
						theme.fg(d.ok ? "success" : "error", theme.bold(`${cleared}/${total} cleared`)) +
						theme.fg("dim", ` · gate exit ${d.gateExitCode ?? "?"}`),
					1,
					0,
				),
			);
			add(new Text(theme.fg("dim", "  fresh sessions, no builder reports, no prior verdicts — one dissent keeps a criterion open"), 1, 0));
			blank();
			md(content);
			blank();
			multiBody();
			break;
		}
		case "gauntlet": {
			const verdict =
				d.stopReason === "passed"
					? theme.fg("success", theme.bold("CLEARED ✓"))
					: d.stopReason === "plateau"
						? theme.fg("warning", theme.bold("PLATEAUED ⚠"))
						: d.stopReason === "exhausted"
							? theme.fg("warning", theme.bold("EXHAUSTED ⚠"))
							: theme.fg("mdLink", theme.bold("ADJUDICATION ⚖"));
			add(
				new Text(
					theme.fg("customMessageLabel", theme.bold(`⚔ GAUNTLET`)) +
						theme.fg("dim", " · ") +
						verdict +
						theme.fg("dim", ` · round ${d.round ?? "?"}/${d.maxRounds ?? "?"}`) +
						(d.criteriaTotal ? theme.fg("dim", ` · ${d.criteriaPassed ?? 0}/${d.criteriaTotal} criteria`) : "") +
						(d.agent ? theme.fg("dim", `   last word: `) + theme.fg(ROLE_COLOR[d.agent.role], d.agent.role) : ""),
					1,
					0,
				),
			);
			blank();
			md(content);
			break;
		}
		default: {
			// "error" and anything else: attributed failure, loud and specific.
			add(new Text(theme.fg("error", theme.bold(`✗ FUSION HARNESS · /${d.command ?? "?"} FAILED`)), 1, 0));
			if (d.agent?.error) add(new Text(theme.fg("error", `  ${d.agent.role} · ${d.agent.model} — ${d.agent.error}`), 1, 0));
			for (const s of d.sources ?? []) {
				if (s.error) add(new Text(theme.fg("error", `  ${s.role} · ${s.model} — ${s.error}`), 1, 0));
			}
			if (content.trim()) {
				blank();
				md(content);
			}
			break;
		}
	}

	if (d.kind !== "banner" && (d.totalMs || d.artifactsDir)) {
		blank();
		const bits = [
			d.totalMs ? `run ${fmtSecs(d.totalMs)}` : "",
			d.totalCostUsd ? `~$${d.totalCostUsd.toFixed(4)}` : "",
			d.artifactsDir ? `artifacts: ${d.artifactsDir}` : "",
		].filter(Boolean);
		add(new Text(theme.fg("dim", `  ${bits.join(" · ")}`), 1, 0));
	}

	// Every panel gets the custom-message background block. (The boot banner, which floats
	// bare on the terminal background, is not a message at all — it is a session entry.)
	const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));
	box.addChild(inner);
	return box;
}

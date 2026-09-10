/**
 * prompt-library.ts — every model contract in one place.
 *
 * Loads the SYSTEM_PROMPT_*.md / USER_PROMPT_*.md templates (edit those files to tune
 * the harness without touching code) and builds every prompt the commands send:
 * opinion, fusion worker/merge/ACK, debate rounds, collaboration phases, and the
 * gate-first auto-validate loop. Also owns the strict-output parsers that hold the
 * models to those contracts (raw JSON objects, gate scripts).
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CollaborationTask } from "./collaboration-graph.ts";
import { rankOpenGaps, type CriterionOutcome, type Rubric } from "./gauntlet-rubric.ts";
import { orderedSlots, type ModelSlot, type ModelStack } from "./model-stack.ts";
import { runOk, runError, shortModel, truncateChars, type AgentRun } from "./runtime.ts";

export const HANDOFF_MAX = 60_000; // chars of one agent's answer injected into another's prompt

// This module lives in modules/; the prompt files live in the extension's prompts/
// sibling directory — __dirname under CJS transpilation, import.meta.url under ESM.
const MODULE_DIR: string =
	typeof __dirname !== "undefined" && __dirname
		? __dirname
		: path.dirname(new URL(import.meta.url).pathname);
const PROMPT_DIR = [path.join(MODULE_DIR, "..", "prompts"), path.join(MODULE_DIR, "prompts")].find((candidate) => fs.existsSync(candidate)) ?? path.join(MODULE_DIR, "..", "prompts");

const promptCache = new Map<string, string>(); // each template file is read once per process
/** Load a prompt template from disk (cached). A missing file is a loud load-time error. */
export function promptTemplate(file: string): string {
	let tpl = promptCache.get(file);
	if (tpl === undefined) {
		try {
			tpl = fs.readFileSync(path.join(PROMPT_DIR, file), "utf-8").trim();
		} catch (err) {
			throw new Error(`fusion-harness: missing prompt file prompts/${file}: ${String(err)}`);
		}
		promptCache.set(file, tpl);
	}
	return tpl;
}

/** Interpolate a template: every {{KEY}} is replaced from vars (missing keys → empty). */
export function fill(file: string, vars: Record<string, string>): string {
	return promptTemplate(file).replace(/\{\{(\w+)\}\}/g, (_m, k) => vars[k] ?? "");
}

export function contractSystemPrompt(base: string | undefined, contractFile: string): string {
	return [base?.trim(), promptTemplate(contractFile)].filter(Boolean).join("\n\n");
}

/** A stable, explicit roster injected into every N-agent protocol. */
export function rosterText(stack: ModelStack): string {
	return orderedSlots(stack)
		.map((slot) => `- [${slot.name.toUpperCase()}] ${slot.architect ? "ARCHITECT" : slot.primary ? "BUILDER (Main)" : "BUILDER"} · ${slot.model} · thinking=${slot.thinking}`)
		.join("\n");
}

// ═══ Fusion ══════════════════════════════════════════════════════════════════

/** /fh-fusion parallel workers are strictly read-only researchers; the fuser is the sole writer. */
export function workerPrompt(slot: ModelSlot, stack: ModelStack, prompt: string): string {
	return fill("USER_PROMPT_FUSION_WORKER.md", { SLOT_NAME: slot.name, MODEL: slot.model, ROSTER: rosterText(stack), PROMPT: prompt });
}

/** The built-in critical-merge instruction, used when /fh-fusion gets no explicit fusion prompt. */
export const defaultFusionPrompt = (): string => promptTemplate("USER_PROMPT_FUSION_DEFAULT_INSTRUCTION.md");

/**
 * /fh-fusion argument parsing — two forms:
 *   Quoted:    /fh-fusion "prompt to all agents" "fusion instruction"
 *   Separator: /fh-fusion prompt to all agents :: fusion instruction
 */
export function parseFusionArgs(input: string): { prompt: string; fusion?: string } {
	const quoted = input.match(/^\s*(["'])([\s\S]*?)\1\s*([\s\S]*)$/);
	if (quoted?.[2]?.trim()) {
		let rest = quoted[3].trim();
		const restQuoted = rest.match(/^(["'])([\s\S]*?)\1\s*$/);
		if (restQuoted) rest = restQuoted[2].trim();
		return { prompt: quoted[2].trim(), fusion: rest || undefined };
	}
	const sep = input.indexOf(" :: ");
	if (sep !== -1) return { prompt: input.slice(0, sep).trim(), fusion: input.slice(sep + 4).trim() || undefined };
	return { prompt: input.trim() };
}

/** N-source FUSION envelope. Complete files are authoritative; inline excerpts share one total budget. */
export function fuserPrompt(
	fusionInstruction: string,
	prompt: string,
	sources: AgentRun[],
	fuserModel: string,
	fuserThinking: string,
	artifactsDir: string,
): string {
	const successful = sources.filter(runOk);
	const perSource = Math.max(2_000, Math.floor(HANDOFF_MAX / Math.max(1, successful.length)));
	const manifest = sources
		.map((run) => {
			const slot = run.slot!;
			const artifactPath = path.join(artifactsDir, "agents", slot.id, "answer.md");
			return [
				`## [${slot.name.toUpperCase()}] ${slot.model}`,
				`status: ${run.status}${runOk(run) ? "" : ` (${runError(run)})`}`,
				`artifact: ${artifactPath}`,
				runOk(run) ? `excerpt:\n${truncateChars(run.text, perSource)}` : "excerpt: unavailable",
			].join("\n");
		})
		.join("\n\n");
	return fill("USER_PROMPT_FUSION_MERGE.md", {
		FUSION_INSTRUCTION: fusionInstruction,
		MODEL: shortModel(fuserModel),
		THINKING: fuserThinking,
		PROMPT: prompt,
		SOURCE_COUNT: String(sources.length),
		ARTIFACTS_DIR: artifactsDir,
		MANIFEST_PATH: path.join(artifactsDir, "source-manifest.json"),
		SOURCE_MANIFEST: manifest,
	});
}

export function fusionContextAckPrompt(runId: string, fusedResult: string): { prompt: string; hash: string } {
	const hash = createHash("sha256").update(fusedResult).digest("hex");
	return { prompt: fill("USER_PROMPT_FUSION_CONTEXT_ACK.md", { RUN_ID: runId, FUSED_HASH: hash, FUSED_RESULT: fusedResult }), hash };
}

// ═══ Auto-validate (gate-first) ══════════════════════════════════════════════

/** Round 1 of /fh-auto-validate: the user's request plus the full (immutable) gate script. */
export function builderPrompt(prompt: string, gateScript: string): string {
	return fill("USER_PROMPT_BUILDER.md", { PROMPT: prompt, GATE_SCRIPT: gateScript });
}

/** Rounds 2+: the verbatim gate failure, plus optional triage brief and repaired-gate update. */
export function correctionPrompt(
	round: number,
	maxRounds: number,
	gateExitCode: number,
	gateOutput: string,
	triageBrief?: string,
	repairedGate?: string,
): string {
	const remaining = maxRounds - round;
	return fill("USER_PROMPT_CORRECTION.md", {
		ROUND: String(round),
		MAX_ROUNDS: String(maxRounds),
		REMAINING: `${remaining} attempt${remaining === 1 ? "" : "s"} remain`,
		GATE_EXIT_CODE: String(gateExitCode),
		GATE_OUTPUT: truncateChars(gateOutput.trim() || "(no output)", 8_000),
		TRIAGE_BLOCK: triageBrief
			? `\n# VALIDATOR'S TRIAGE (advisory diagnosis from the agent that designed the gate — follow it, but the gate output above remains the source of truth)\n${truncateChars(triageBrief.trim(), 8_000)}\n`
			: "",
		// A repaired gate makes the builder's round-1 copy STALE — hand it the script that
		// now actually judges its work, or it reasons against checks that no longer exist.
		GATE_UPDATE_BLOCK: repairedGate
			? `\n# GATE REPAIRED — the VALIDATOR fixed a defect in the acceptance gate. The copy from your first prompt is STALE; THIS is the gate that now judges your work (still immutable to you):\n\`\`\`python\n${truncateChars(repairedGate.trim(), 20_000)}\n\`\`\`\n`
			: "",
	});
}

// Escalation triage: after N failures the VALIDATOR stops being a silent gate and
// diagnoses WHY the builder is stuck — with read-only eyes on the actual state, plus a
// one-shot mandate to rewrite the gate at GATE_PATH if the gate itself is the defect.
export const triageSystem = (gatePath: string): string => fill("SYSTEM_PROMPT_TRIAGE.md", { GATE_PATH: gatePath });

/** The triage request: what was asked, how many failures, the recent gate history. */
export function triagePrompt(
	request: string,
	failures: number,
	maxRounds: number,
	builderReport: string,
	gateOutputs: Array<{ round: number; code: number; output: string }>,
	artifactsDir: string,
): string {
	const history = gateOutputs
		.slice(-2)
		.map((g) => `## Gate run — round ${g.round} (exit ${g.code})\n\`\`\`\n${truncateChars(g.output.trim() || "(no output)", 6_000)}\n\`\`\``)
		.join("\n\n");
	return fill("USER_PROMPT_TRIAGE.md", {
		FAILURES: String(failures),
		FAILURES_PLURAL: failures === 1 ? "" : "s",
		MAX_ROUNDS: String(maxRounds),
		REQUEST: request,
		HISTORY_SUFFIX: gateOutputs.length > 1 ? "S (note what changed — or didn't — between rounds)" : "",
		GATE_HISTORY: history,
		BUILDER_REPORT: truncateChars(builderReport, 12_000),
		// TRIAGE is read-only but sighted: the run dir holds every full builder report and
		// gate output, so it can read past the truncated excerpts above.
		ARTIFACTS_DIR: artifactsDir,
	});
}

// The VALIDATOR designs the gate BEFORE the builder does any work (red → green):
// its script is the definition of done, and its FAIL lines become the builder's
// correction instructions — so clarity and integrity are hard requirements.
// GATE_PATH is the harness-dictated absolute path the validator must WRITE its gate to —
// the transport is a file, never a code fence (see extractGateScript).
export const validatorSystem = (gatePath: string): string => fill("SYSTEM_PROMPT_VALIDATOR.md", { GATE_PATH: gatePath });

/** The gate-design request: the user's prompt, the project cwd, and the dictated gate path. */
export function validatorPrompt(prompt: string, cwd: string, gatePath: string): string {
	// The gate always lives at <artifacts>/gate.py, so the run dir is its dirname.
	return fill("USER_PROMPT_VALIDATOR.md", { PROMPT: prompt, CWD: cwd, GATE_PATH: gatePath, ARTIFACTS_DIR: path.dirname(gatePath) });
}

// ═══ Opinion + debate ════════════════════════════════════════════════════════

/** /fh-opinion: every slot gives one independent, strictly read-only opinion. */
export function opinionPrompt(slot: ModelSlot, stack: ModelStack, prompt: string): string {
	return fill("USER_PROMPT_OPINION.md", { SLOT_NAME: slot.name, MODEL: slot.model, ROSTER: rosterText(stack), PROMPT: prompt });
}

/** Clearly labeled concrete opinions from every other surviving agent's previous round. */
export function debateOpinionsBlock(slot: ModelSlot, previousRuns: AgentRun[]): string {
	const others = previousRuns.filter((run) => run.slot?.id !== slot.id);
	const successfulChars = others.filter(runOk).reduce((sum, run) => sum + run.text.length, 0);
	if (successfulChars > HANDOFF_MAX) {
		throw new Error(`complete prior-round opinion packet for ${slot.name} is ${successfulChars} chars, above the ${HANDOFF_MAX}-char debate budget; refusing to silently truncate any agent`);
	}
	return others
		.map((run) => {
			const name = run.slot?.name ?? run.role;
			if (!runOk(run)) return [`----- PARTICIPANT UNAVAILABLE -----`, `SLOT: ${name}`, `MODEL: ${run.model}`, `STATUS: FAILED — no opinion is available`, `----- END PARTICIPANT STATUS -----`].join("\n");
			return [`----- BEGIN CONCRETE OPINION -----`, `SLOT: ${name}`, `MODEL: ${run.model}`, `STATUS: SUCCESS`, run.text, `----- END CONCRETE OPINION -----`].join("\n");
		})
		.join("\n\n");
}

export function debateOpeningPrompt(slot: ModelSlot, stack: ModelStack, prompt: string, rounds: number): string {
	return fill("USER_PROMPT_DEBATE_OPENING.md", {
		SLOT_NAME: slot.name,
		MODEL: slot.model,
		ROSTER: rosterText(stack),
		ROUNDS: String(rounds),
		PROMPT: prompt,
	});
}

export function debateRebuttalPrompt(slot: ModelSlot, prompt: string, round: number, rounds: number, previousRuns: AgentRun[]): string {
	return fill("USER_PROMPT_DEBATE_REBUTTAL.md", {
		SLOT_NAME: slot.name,
		MODEL: slot.model,
		PROMPT: prompt,
		ROUND: String(round),
		PREV_ROUND: String(round - 1),
		ROUNDS: String(rounds),
		OTHER_OPINIONS: debateOpinionsBlock(slot, previousRuns),
		ROUNDS_LEFT: `${rounds - round} round${rounds - round === 1 ? "" : "s"} remain after this one, then every surviving agent gives a closing opinion.`,
	});
}

export function debateClosingPrompt(slot: ModelSlot, prompt: string, round: number, rounds: number, previousRuns: AgentRun[]): string {
	return fill("USER_PROMPT_DEBATE_CLOSING.md", {
		SLOT_NAME: slot.name,
		MODEL: slot.model,
		PROMPT: prompt,
		ROUND: String(round),
		PREV_ROUND: String(round - 1),
		ROUNDS: String(rounds),
		OTHER_OPINIONS: debateOpinionsBlock(slot, previousRuns),
	});
}

// ═══ Collaboration ═══════════════════════════════════════════════════════════

export function collabProposePrompt(slot: ModelSlot, stack: ModelStack, prompt: string): string {
	return fill("USER_PROMPT_COLLAB_PROPOSE.md", { SLOT_NAME: slot.name, MODEL: slot.model, ROSTER: rosterText(stack), PROMPT: prompt });
}

export function collabDelegatePrompt(stack: ModelStack, prompt: string, collabDir: string, planPath: string): string {
	const assigneeIds = orderedSlots(stack).map((slot) => slot.id).join(", ");
	return fill("USER_PROMPT_COLLAB_DELEGATE.md", { COLLAB_DIR: collabDir, PLAN_PATH: planPath, ASSIGNEE_IDS: assigneeIds, ROSTER: rosterText(stack), PROMPT: prompt });
}

export function collabExecutePrompt(slot: ModelSlot, prompt: string, task: CollaborationTask, handoff: string): string {
	return fill("USER_PROMPT_COLLAB_EXECUTE.md", {
		SLOT_NAME: slot.name,
		MODEL: slot.model,
		TASK_ID: task.id,
		TASK_DESCRIPTION: task.description,
		TASK_OUTPUTS: task.outputs.length ? task.outputs.map((output) => `- ${output}`).join("\n") : "- concrete task report",
		HANDOFF: truncateChars(handoff || "No upstream reports; inspect the current project state.", HANDOFF_MAX),
		MODE_CONTRACT: task.mode === "read" ? "READ-ONLY TASK: use read/grep/find/ls only; do not mutate the project." : "WRITE TASK: you hold the harness's sole writer token. Full tools are enabled, and no other writer is active.",
		PROMPT: prompt,
	});
}

export function collabCoordinatePrompt(prompt: string, reportsDir: string, planPath: string): string {
	return fill("USER_PROMPT_COLLAB_COORDINATE.md", { REPORTS_DIR: reportsDir, PLAN_PATH: planPath, PROMPT: prompt });
}

// ═══ Gauntlet ════════════════════════════════════════════════════════════════

/** A compact, readable view of the delegation plan for the rubric author. */
export function planSummary(tasks: CollaborationTask[]): string {
	return tasks.map((task) => `- **${task.id}** (${task.assignee}, ${task.mode}) — ${task.description}${task.outputs.length ? `\n  outputs: ${task.outputs.join(", ")}` : ""}`).join("\n");
}

/**
 * The ARCHITECT writes the acceptance BAR before any build, to a harness-dictated path.
 * Same transport as the auto-validate gate: a FILE, never a fence — a rubric pasted into
 * a code block is truncated at the first ``` inside it.
 */
export function gauntletRubricPrompt(prompt: string, tasks: CollaborationTask[], rubricPath: string): string {
	return fill("USER_PROMPT_GAUNTLET_RUBRIC.md", {
		RUBRIC_PATH: rubricPath,
		PROMPT: prompt,
		TASK_IDS: tasks.map((task) => task.id).join(", "),
		PLAN_SUMMARY: planSummary(tasks),
	});
}

export const gauntletCriticSystem = (): string => promptTemplate("SYSTEM_PROMPT_GAUNTLET_CRITIC.md");

/** The rubric as the critic reads it — one block per criterion, evidence made prominent. */
export function rubricText(rubric: Rubric): string {
	return rubric.criteria
		.map((criterion) => [`## ${criterion.id} · ${criterion.severity.toUpperCase()}`, `requirement: ${criterion.requirement}`, `evidence: ${criterion.evidence}`, criterion.tasks.length ? `judges tasks: ${criterion.tasks.join(", ")}` : "judges: the artifact as a whole"].join("\n"))
		.join("\n\n");
}

/**
 * What a blind critic sees: the request, the rubric, and the real project. Deliberately
 * NOT included — builder reports, prior verdicts, the round ledger, or any other critic's
 * name. The isolation is the mechanism; widening this prompt breaks the flow.
 */
export function gauntletCriticPrompt(prompt: string, rubric: Rubric, cwd: string, round: number, maxRounds: number): string {
	return fill("USER_PROMPT_GAUNTLET_CRITIC.md", {
		CWD: cwd,
		PROMPT: prompt,
		ROUND: String(round),
		MAX_ROUNDS: String(maxRounds),
		CRITERIA_COUNT: String(rubric.criteria.length),
		RUBRIC: rubricText(rubric),
	});
}

/** Tallied outcomes for the adjudicator: open criteria only, every dissent attributed. */
export function outcomesText(outcomes: CriterionOutcome[]): string {
	const open = rankOpenGaps(outcomes);
	if (!open.length) return "Every criterion cleared unanimously.";
	return open
		.map((outcome) =>
			[
				`## ${outcome.criterion.id} · ${outcome.criterion.severity.toUpperCase()} · OPEN (${outcome.fails} fail / ${outcome.passes} pass)`,
				`requirement: ${outcome.criterion.requirement}`,
				`evidence: ${outcome.criterion.evidence}`,
				...outcome.gaps.map((gap) => `----- BEGIN CRITIC FINDING -----\nCRITIC: ${gap.slot}\nobserved: ${gap.evidence}\ngap: ${gap.gap}\n----- END CRITIC FINDING -----`),
			].join("\n"),
		)
		.join("\n\n");
}

export function gauntletAdjudicatePrompt(
	prompt: string,
	outcomes: CriterionOutcome[],
	panelSize: number,
	round: number,
	maxRounds: number,
	gate: { code: number; output: string },
	workbench: string,
	assigneeIds: string[],
	repairPath: string,
): string {
	return fill("USER_PROMPT_GAUNTLET_ADJUDICATE.md", {
		PROMPT: prompt,
		ROUND: String(round),
		MAX_ROUNDS: String(maxRounds),
		PANEL_SIZE: String(panelSize),
		REPAIR_PATH: repairPath,
		ASSIGNEE_IDS: assigneeIds.join(", "),
		OUTCOMES: truncateChars(outcomesText(outcomes), HANDOFF_MAX),
		GATE_EXIT_CODE: String(gate.code),
		GATE_OUTPUT: truncateChars(gate.output.trim() || "(no output)", 8_000),
		WORKBENCH: truncateChars(workbench.trim() || "(first round — no history yet)", 12_000),
	});
}

export function gauntletRepairPrompt(
	slot: ModelSlot,
	prompt: string,
	task: CollaborationTask,
	openCriteria: CriterionOutcome[],
	handoff: string,
	round: number,
	maxRounds: number,
): string {
	return fill("USER_PROMPT_GAUNTLET_REPAIR.md", {
		SLOT_NAME: slot.name,
		MODEL: slot.model,
		TASK_ID: task.id,
		ROUND: String(round),
		MAX_ROUNDS: String(maxRounds),
		TASK_DESCRIPTION: task.description,
		TASK_OUTPUTS: task.outputs.length ? task.outputs.map((output) => `- ${output}`).join("\n") : "- concrete repair report",
		OPEN_CRITERIA: openCriteria.length ? truncateChars(outcomesText(openCriteria), Math.floor(HANDOFF_MAX / 2)) : "(none listed — follow the task description)",
		HANDOFF: truncateChars(handoff || "No upstream reports; inspect the current project state.", Math.floor(HANDOFF_MAX / 2)),
		MODE_CONTRACT: task.mode === "read" ? "READ-ONLY TASK: use read/grep/find/ls only; do not mutate the project." : "WRITE TASK: you hold the harness's sole writer token. Full tools are enabled, and no other writer is active.",
		PROMPT: prompt,
	});
}

export const gauntletIntegratorSystem = (): string => promptTemplate("SYSTEM_PROMPT_GAUNTLET_INTEGRATOR.md");

export function gauntletIntegratePrompt(prompt: string, rubric: Rubric, cwd: string): string {
	return fill("USER_PROMPT_GAUNTLET_INTEGRATE.md", { CWD: cwd, PROMPT: prompt, RUBRIC: rubricText(rubric) });
}

// ═══ Strict-output parsing ═══════════════════════════════════════════════════

export function parseStrictJsonObject(text: string, label: string): Record<string, unknown> {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) throw new Error(`${label} must be one raw JSON object with no prose or code fences`);
	const parsed = JSON.parse(trimmed);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object`);
	return parsed as Record<string, unknown>;
}

/** A gate is a PEP 723 uv script; inject the metadata block when the author omitted it. */
export function ensureGateMetadata(script: string): string | undefined {
	const s = script.trim();
	if (!s) return undefined;
	const withMeta = s.includes("# /// script") ? s : `# /// script\n# requires-python = ">=3.11"\n# dependencies = []\n# ///\n${s}`;
	return `${withMeta}\n`;
}

/**
 * LEGACY FALLBACK ONLY — the validator now writes gate.py to disk itself.
 *
 * Pulling the gate out of a fenced block is lossy by construction: the closing fence is
 * whatever ``` comes first, so any gate whose own source contains a literal triple-backtick
 * (e.g. asserting raw markdown fences are absent from rendered HTML) is silently truncated
 * mid-token. That produced a real 43.6KB gate cut to 33.3KB at `and "```" not in text`,
 * failing every round with a SyntaxError while the build under test was fine. Kept only for
 * validators that ignore the write instruction and paste the script anyway.
 */
export function extractGateScript(text: string): string | undefined {
	const fence = text.match(/```(?:python|py|uv)?\s*\n([\s\S]*?)```/);
	const script = fence ? fence[1] : text.trim().startsWith("# /// script") ? text.trim() : undefined;
	if (!script?.trim()) return undefined;
	return ensureGateMetadata(script);
}

/**
 * gauntlet-rubric.ts — the acceptance bar for /fh-gauntlet, and the blind verdicts
 * critics return against it.
 *
 * The rubric is written BEFORE any build (same red-first discipline as the auto-validate
 * gate) and is the ONLY thing critics are allowed to judge against. Verdicts are strict
 * JSON so a critic cannot pass a criterion with prose; consensus is deliberately hostile
 * — one dissenting critic keeps a criterion open.
 */

export type Severity = "blocker" | "major" | "minor";
export const SEVERITIES: readonly Severity[] = ["blocker", "major", "minor"];

export interface Criterion {
	id: string;
	requirement: string;
	/** How a critic PROVES it — the file, command, or observable that settles the question. */
	evidence: string;
	severity: Severity;
	/** Plan task ids this criterion judges; empty means it judges the artifact as a whole. */
	tasks: string[];
}

export interface Rubric {
	criteria: Criterion[];
}

export interface Verdict {
	id: string;
	pass: boolean;
	/** What the critic actually observed — required whether it passed or failed. */
	evidence: string;
	/** The gap to close. Required on a fail, ignored on a pass. */
	gap: string;
}

export interface CriterionOutcome {
	criterion: Criterion;
	/** Cleared only when EVERY successful critic passed it — one dissent keeps it open. */
	cleared: boolean;
	passes: number;
	fails: number;
	/** Every dissenting critic's gap, attributed by slot. */
	gaps: Array<{ slot: string; gap: string; evidence: string }>;
}

const ID_RE = /^[A-Za-z0-9_.-]{1,24}$/;

export function validateRubric(input: unknown, knownTaskIds: Iterable<string>): Rubric {
	const errors: string[] = [];
	const knownTasks = new Set(knownTaskIds);
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("rubric must be a JSON object");
	const raw = (input as Record<string, unknown>).criteria;
	if (!Array.isArray(raw) || raw.length === 0) throw new Error("rubric.criteria must be a non-empty array");

	const criteria: Criterion[] = [];
	const ids = new Set<string>();
	for (let i = 0; i < raw.length; i++) {
		const label = `criteria[${i}]`;
		const value = raw[i];
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			errors.push(`${label} must be an object`);
			continue;
		}
		const item = value as Record<string, unknown>;
		const id = typeof item.id === "string" ? item.id.trim() : "";
		if (!ID_RE.test(id)) errors.push(`${label}.id must match [A-Za-z0-9_.-]{1,24}; found ${JSON.stringify(item.id)}`);
		if (ids.has(id)) errors.push(`${label}.id duplicates ${id}`);
		ids.add(id);
		const requirement = typeof item.requirement === "string" ? item.requirement.trim() : "";
		if (!requirement) errors.push(`${label}.requirement must be a non-empty string`);
		// Evidence is what separates a rubric from a wish: without it a critic is grading vibes.
		const evidence = typeof item.evidence === "string" ? item.evidence.trim() : "";
		if (!evidence) errors.push(`${label}.evidence must say how a critic verifies this — the file, command, or observable that settles it`);
		const severity = typeof item.severity === "string" ? (item.severity.trim().toLowerCase() as Severity) : ("" as Severity);
		if (!SEVERITIES.includes(severity)) errors.push(`${label}.severity must be one of ${SEVERITIES.join(", ")}; found ${JSON.stringify(item.severity)}`);
		const tasks = Array.isArray(item.tasks) ? item.tasks.filter((entry): entry is string => typeof entry === "string") : [];
		if (item.tasks !== undefined && !Array.isArray(item.tasks)) errors.push(`${label}.tasks must be an array when present`);
		for (const task of tasks) if (!knownTasks.has(task)) errors.push(`${label}.tasks references unknown plan task ${task}`);
		criteria.push({ id, requirement, evidence, severity, tasks });
	}
	if (errors.length) throw new Error(errors.join("\n"));
	return { criteria };
}

export function validateVerdicts(input: unknown, rubric: Rubric): Verdict[] {
	const errors: string[] = [];
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("verdict payload must be a JSON object");
	const raw = (input as Record<string, unknown>).verdicts;
	if (!Array.isArray(raw)) throw new Error("payload.verdicts must be an array");

	const byId = new Map<string, Verdict>();
	for (let i = 0; i < raw.length; i++) {
		const label = `verdicts[${i}]`;
		const value = raw[i];
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			errors.push(`${label} must be an object`);
			continue;
		}
		const item = value as Record<string, unknown>;
		const id = typeof item.id === "string" ? item.id.trim() : "";
		if (!rubric.criteria.some((criterion) => criterion.id === id)) {
			errors.push(`${label}.id is not a rubric criterion: ${JSON.stringify(item.id)}`);
			continue;
		}
		if (byId.has(id)) errors.push(`${label}.id duplicates a verdict for ${id}`);
		if (typeof item.pass !== "boolean") errors.push(`${label}.pass must be boolean`);
		const evidence = typeof item.evidence === "string" ? item.evidence.trim() : "";
		if (!evidence) errors.push(`${label}.evidence must state what you actually observed`);
		const gap = typeof item.gap === "string" ? item.gap.trim() : "";
		if (item.pass === false && !gap) errors.push(`${label}.gap is required on a fail — say exactly what is missing`);
		byId.set(id, { id, pass: item.pass === true, evidence, gap });
	}
	// Silence is not a pass: a critic that skips a criterion has not judged the artifact.
	for (const criterion of rubric.criteria) if (!byId.has(criterion.id)) errors.push(`no verdict returned for criterion ${criterion.id}`);
	if (errors.length) throw new Error(errors.join("\n"));
	return rubric.criteria.map((criterion) => byId.get(criterion.id)!);
}

/**
 * Fold every surviving critic's verdicts into one outcome per criterion.
 *
 * Consensus is UNANIMOUS-TO-CLEAR by design: the point of a hostile panel is that a
 * single critic finding a real gap is enough to keep working. Majority voting would let
 * two lenient critics overrule the one that actually read the file.
 */
export function tallyVerdicts(rubric: Rubric, panel: Array<{ slot: string; verdicts: Verdict[] }>): CriterionOutcome[] {
	return rubric.criteria.map((criterion) => {
		const gaps: CriterionOutcome["gaps"] = [];
		let passes = 0;
		let fails = 0;
		for (const critic of panel) {
			const verdict = critic.verdicts.find((entry) => entry.id === criterion.id);
			if (!verdict) continue;
			if (verdict.pass) passes++;
			else {
				fails++;
				gaps.push({ slot: critic.slot, gap: verdict.gap, evidence: verdict.evidence });
			}
		}
		return { criterion, cleared: passes > 0 && fails === 0, passes, fails, gaps };
	});
}

/** Blockers first, then majors, then minors; within a severity, the most-dissented first. */
export function rankOpenGaps(outcomes: CriterionOutcome[]): CriterionOutcome[] {
	const weight: Record<Severity, number> = { blocker: 0, major: 1, minor: 2 };
	return outcomes
		.filter((outcome) => !outcome.cleared)
		.sort((a, b) => weight[a.criterion.severity] - weight[b.criterion.severity] || b.fails - a.fails || a.criterion.id.localeCompare(b.criterion.id));
}

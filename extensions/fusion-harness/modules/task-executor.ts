/**
 * task-executor.ts — the single-writer, dependency-driven task scheduler.
 *
 * Shared by /fh-collaborate and /fh-gauntlet. Both run a validated delegation DAG over
 * ONE shared working directory, and both depend on the same invariant: reads may overlap
 * freely, but at most one write-enabled child is ever alive. That invariant lives here,
 * once. Two copies of it would be two places for a concurrent writer to slip through.
 *
 * A task launches the moment its dependencies are done AND its owning slot is free.
 * Plan order is the FIFO tiebreak. A slot that owns several ready tasks runs them one at
 * a time — its session is serial by construction.
 */

import { runChild } from "./child-runner.ts";
import type { CollaborationTask } from "./collaboration-graph.ts";
import type { ModelSlot } from "./model-stack.ts";
import { FULL_TOOLS, READONLY_TOOLS, runError, runOk, type AgentRun, type SpawnIdentity } from "./runtime.ts";

export type TaskState = "blocked" | "queued" | "reading" | "writing" | "done" | "failed";

export const TASK_GLYPH: Record<TaskState, string> = { blocked: "○", queued: "◌", reading: "◐", writing: "●", done: "✓", failed: "✗" };

export interface TaskExecution {
	taskId: string;
	slot: string;
	mode: "read" | "write";
	startedAt: number;
	endedAt: number;
	ok: boolean;
}

/**
 * The write-concurrency accounting, owned by the COMMAND rather than by one graph run.
 * A command that executes several graphs (the gauntlet's build plus every repair round)
 * plus its own final turn must observe one running maximum across all of them — that
 * number is the evidence the invariant held, and it lands in summary.json.
 */
export interface WriterCounter {
	active: number;
	max: number;
}

export const newWriterCounter = (): WriterCounter => ({ active: 0, max: 0 });

/** Enter a write-enabled turn. Call SYNCHRONOUSLY before any await, or the scheduler's check races. */
export function enterWriter(counter: WriterCounter): void {
	counter.active++;
	counter.max = Math.max(counter.max, counter.active);
}

export const exitWriter = (counter: WriterCounter): void => {
	counter.active--;
};

export interface TaskGraphOptions {
	tasks: CollaborationTask[];
	/** Resolve a task's assignee to its configured slot and its persistent run. */
	slotFor(assignee: string): ModelSlot;
	runFor(assignee: string): AgentRun;
	/** The child prompt for this task, given the assembled dependency handoff. */
	promptFor(task: CollaborationTask, handoff: string): string;
	/** Context lines placed above the dependency reports in every handoff. */
	handoffHeader(task: CollaborationTask): string[];
	spawnFor(slot: ModelSlot, run: AgentRun): SpawnIdentity;
	counter: WriterCounter;
	cwd: string;
	timeoutMs: number;
	signal: AbortSignal;
	stopped(): boolean;
	/** Called on every state transition so the caller can redraw its task board. */
	onBoard(states: ReadonlyMap<string, TaskState>): void;
	/** Called once per finished task, before the scheduler moves on. */
	onTaskFinished(task: CollaborationTask, run: AgentRun, report: string, ok: boolean): Promise<void>;
	/** Seed reports from an earlier graph run so later tasks can depend on them. */
	seedReports?: ReadonlyMap<string, string>;
}

export interface TaskGraphResult {
	executions: TaskExecution[];
	reports: Map<string, string>;
	states: Map<string, TaskState>;
	/** The first task failure, if any. Downstream tasks are never started after one. */
	failure?: string;
}

export async function executeTaskGraph(options: TaskGraphOptions): Promise<TaskGraphResult> {
	const { tasks, counter } = options;
	const states = new Map<string, TaskState>(tasks.map((task) => [task.id, "blocked" as TaskState]));
	const reports = new Map<string, string>(options.seedReports ?? []);
	const executions: TaskExecution[] = [];
	const busySlots = new Set<string>();
	const inFlight = new Map<string, Promise<void>>();
	let failure: string | undefined;

	const depsDone = (task: CollaborationTask): boolean => task.depends_on.every((dep) => states.get(dep) === "done" || (!states.has(dep) && reports.has(dep)));

	const handoffFor = (task: CollaborationTask): string => {
		const parts = [...options.handoffHeader(task)];
		for (const dep of task.depends_on) parts.push(`\n## COMPLETED DEPENDENCY ${dep}\n${reports.get(dep) ?? "(report on disk)"}`);
		return parts.join("\n");
	};

	const executeTask = async (task: CollaborationTask): Promise<void> => {
		const slot = options.slotFor(task.assignee);
		const run = options.runFor(task.assignee);
		const startedAt = Date.now();
		const write = task.mode === "write";
		// Synchronous before the first await — the scheduler's writer check relies on it.
		if (write) enterWriter(counter);
		try {
			await runChild({
				run,
				prompt: options.promptFor(task, handoffFor(task)),
				systemPrompt: slot.systemPrompt,
				appendSystemPrompts: slot.appendSystemPrompts,
				tools: write ? FULL_TOOLS : READONLY_TOOLS,
				thinking: slot.thinking,
				...options.spawnFor(slot, run),
				cwd: options.cwd,
				timeoutMs: options.timeoutMs,
				signal: options.signal,
			});
		} finally {
			if (write) exitWriter(counter);
		}
		const ok = runOk(run) && !options.stopped();
		executions.push({ taskId: task.id, slot: slot.id, mode: task.mode, startedAt, endedAt: Date.now(), ok });
		const report = runOk(run) ? run.text : `FAILED: ${runError(run)}`;
		reports.set(task.id, report);
		states.set(task.id, ok ? "done" : "failed");
		await options.onTaskFinished(task, run, report, ok);
		if (!ok && !options.stopped()) failure ??= `task ${task.id} (${slot.id}) failed: ${runError(run)}`;
	};

	options.onBoard(states);
	while (!options.stopped()) {
		if (!failure) {
			for (const task of tasks) {
				const current = states.get(task.id)!;
				if (current !== "blocked" && current !== "queued") continue;
				if (!depsDone(task)) continue;
				if (busySlots.has(task.assignee) || (task.mode === "write" && counter.active > 0)) {
					states.set(task.id, "queued");
					continue;
				}
				busySlots.add(task.assignee);
				states.set(task.id, task.mode === "read" ? "reading" : "writing");
				const running = executeTask(task).finally(() => {
					busySlots.delete(task.assignee);
					inFlight.delete(task.id);
				});
				inFlight.set(task.id, running);
			}
		}
		options.onBoard(states);
		if (!inFlight.size) break;
		await Promise.race(inFlight.values());
	}
	await Promise.allSettled([...inFlight.values()]);
	options.onBoard(states);
	return { executions, reports, states, failure };
}

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rankOpenGaps, tallyVerdicts, validateRubric, validateVerdicts, type Rubric } from "../modules/gauntlet-rubric.ts";
import { gauntletAdjudicatePrompt, gauntletCriticPrompt, gauntletCriticSystem, gauntletIntegratePrompt, gauntletIntegratorSystem, gauntletRepairPrompt, gauntletRubricPrompt, outcomesText, rubricText } from "../modules/prompt-library.ts";
import { ROLE_COLOR, ROLE_GLYPH, SLOT_NAMED_ROLES } from "../modules/runtime.ts";

const root = join(import.meta.dir, "..");
const module = (name: string) => readFileSync(join(root, "modules", name), "utf8");
const prompt = (name: string) => readFileSync(join(root, "prompts", name), "utf8");

const criterion = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  requirement: "the CLI exits 0 on --help",
  evidence: "run `./bin/tool --help`; exit code is 0 and usage is printed",
  severity: "blocker",
  tasks: ["1.a"],
  ...over,
});

const RUBRIC: Rubric = validateRubric({ criteria: [criterion(), criterion({ id: "c2", severity: "minor", tasks: [] })] }, ["1.a"]);

describe("gauntlet rubric", () => {
  test("accepts a concrete rubric and normalizes optional fields", () => {
    const rubric = validateRubric({ criteria: [criterion({ tasks: undefined })] }, ["1.a"]);
    expect(rubric.criteria).toHaveLength(1);
    expect(rubric.criteria[0]!.tasks).toEqual([]);
    expect(rubric.criteria[0]!.severity).toBe("blocker");
  });

  test("rejects a criterion with no way to verify it — evidence is what makes it a bar", () => {
    expect(() => validateRubric({ criteria: [criterion({ evidence: "" })] }, ["1.a"])).toThrow(/how a critic verifies this/);
    expect(() => validateRubric({ criteria: [criterion({ evidence: undefined })] }, ["1.a"])).toThrow(/evidence/);
  });

  test("rejects bad severities, duplicate ids, empty rubrics, and unknown task refs", () => {
    expect(() => validateRubric({ criteria: [criterion({ severity: "critical" })] }, ["1.a"])).toThrow(/severity must be one of/);
    expect(() => validateRubric({ criteria: [criterion(), criterion()] }, ["1.a"])).toThrow(/duplicates c1/);
    expect(() => validateRubric({ criteria: [] }, ["1.a"])).toThrow(/non-empty array/);
    expect(() => validateRubric({ criteria: [criterion({ tasks: ["9.z"] })] }, ["1.a"])).toThrow(/unknown plan task 9\.z/);
  });
});

describe("gauntlet verdicts", () => {
  const pass = (id: string) => ({ id, pass: true, evidence: "ran it; exit 0", gap: "" });
  const fail = (id: string, gap = "usage text is missing") => ({ id, pass: false, evidence: "ran it; exit 2", gap });

  test("a critic must return a verdict for every criterion — silence is not a pass", () => {
    expect(() => validateVerdicts({ verdicts: [pass("c1")] }, RUBRIC)).toThrow(/no verdict returned for criterion c2/);
  });

  test("a fail without a gap is rejected — the gap IS the builder's instruction", () => {
    expect(() => validateVerdicts({ verdicts: [fail("c1", ""), pass("c2")] }, RUBRIC)).toThrow(/gap is required on a fail/);
  });

  test("evidence is required even on a pass, and unknown ids are rejected", () => {
    expect(() => validateVerdicts({ verdicts: [{ id: "c1", pass: true, evidence: "", gap: "" }, pass("c2")] }, RUBRIC)).toThrow(/evidence must state/);
    expect(() => validateVerdicts({ verdicts: [pass("c1"), pass("c2"), pass("c9")] }, RUBRIC)).toThrow(/not a rubric criterion/);
  });

  test("verdicts come back in rubric order regardless of the order the critic emitted them", () => {
    const verdicts = validateVerdicts({ verdicts: [pass("c2"), fail("c1")] }, RUBRIC);
    expect(verdicts.map((verdict) => verdict.id)).toEqual(["c1", "c2"]);
  });
});

describe("gauntlet consensus", () => {
  const pass = (id: string) => ({ id, pass: true, evidence: "verified", gap: "" });
  const fail = (id: string, gap: string) => ({ id, pass: false, evidence: "checked", gap });

  test("one dissent keeps a criterion open — a lenient majority cannot overrule the critic who read the file", () => {
    const outcomes = tallyVerdicts(RUBRIC, [
      { slot: "alpha", verdicts: [pass("c1"), pass("c2")] },
      { slot: "beta", verdicts: [pass("c1"), pass("c2")] },
      { slot: "gamma", verdicts: [fail("c1", "no usage output"), pass("c2")] },
    ]);
    expect(outcomes.find((outcome) => outcome.criterion.id === "c1")!.cleared).toBe(false);
    expect(outcomes.find((outcome) => outcome.criterion.id === "c2")!.cleared).toBe(true);
    expect(outcomes.find((outcome) => outcome.criterion.id === "c1")!.gaps).toEqual([{ slot: "gamma", gap: "no usage output", evidence: "checked" }]);
  });

  test("an empty panel clears nothing — a dropped critic never counts as a pass", () => {
    for (const outcome of tallyVerdicts(RUBRIC, [])) expect(outcome.cleared).toBe(false);
    for (const outcome of tallyVerdicts(RUBRIC, [{ slot: "alpha", verdicts: [] }])) expect(outcome.cleared).toBe(false);
  });

  test("open gaps rank blockers first, then by how many critics dissented", () => {
    const rubric = validateRubric({ criteria: [criterion({ id: "minor1", severity: "minor" }), criterion({ id: "block1", severity: "blocker" }), criterion({ id: "major1", severity: "major" })] }, ["1.a"]);
    const ranked = rankOpenGaps(tallyVerdicts(rubric, [{ slot: "alpha", verdicts: [fail("minor1", "g"), fail("block1", "g"), fail("major1", "g")] }]));
    expect(ranked.map((outcome) => outcome.criterion.id)).toEqual(["block1", "major1", "minor1"]);
  });
});

describe("gauntlet blindness contract", () => {
  const source = module("cmd-gauntlet.ts");

  test("critics run on a fresh throwaway session per round — never resumed, never pinned", () => {
    // The isolation IS the pattern: a critic that resumed the build session, or that
    // reused last round's session, would be grading with the memory the flow exists to
    // deny it. sessionDir is per round AND per slot; sessionId/fork are never passed.
    expect(source).toContain('const roundDir = path.join(criticsDir, `round-${round}`);');
    expect(source).toContain("const criticSessionDir = path.join(roundDir, slot.id);");
    expect(source).toContain("sessionDir: criticSessionDir");
    // The ONLY resume a critic ever gets is its own format retry, inside that same session.
    const criticSpawn = source.slice(source.indexOf("sessionDir: criticSessionDir"), source.indexOf("sessionDir: criticSessionDir") + 200);
    expect(criticSpawn).toContain("attempt > 1 && run.sessionRef");
    expect(criticSpawn).not.toContain("fork:");
    expect(criticSpawn).not.toContain("sessionId:");
  });

  test("critics cannot write — enforced by tools, not by instruction", () => {
    expect(source).toContain("tools: CRITIC_TOOLS");
    const runtime = module("runtime.ts");
    expect(runtime).toContain('export const CRITIC_TOOLS = "read,grep,find,ls";');
    for (const forbidden of ["write", "edit", "bash"]) {
      expect(/export const CRITIC_TOOLS = "([^"]+)"/.exec(runtime)![1]!.split(",")).not.toContain(forbidden);
    }
  });

  test("the critic prompt carries the request, the rubric and nothing else", () => {
    const text = gauntletCriticPrompt("build the thing", RUBRIC, "/tmp/project", 2, 3);
    expect(text).toContain("build the thing");
    expect(text).toContain("c1");
    expect(text).toContain("Round 2 of 3");
    // Nothing that would tell a critic what the builders said, or what a previous panel
    // concluded. If any of these ever appear, the panel is no longer blind.
    for (const leak of ["builder", "Builder", "BUILDER", "previous verdict", "workbench", "round ledger"]) {
      expect(text).not.toContain(leak);
    }
  });

  test("the critic contract defaults to fail and forbids self-repair", () => {
    const system = gauntletCriticSystem();
    expect(system).toContain("Default to FAIL when you cannot verify");
    expect(system).toContain("never fix what you find");
    expect(system).toContain("ONE raw JSON object");
    expect(prompt("SYSTEM_PROMPT_GAUNTLET_CRITIC.md")).toContain("You did not build it");
  });

  test("repairers are told the bar and the gate are not theirs to touch", () => {
    expect(prompt("USER_PROMPT_GAUNTLET_REPAIR.md")).toContain("Never edit the rubric, the acceptance gate, or any critic's verdict");
    expect(prompt("USER_PROMPT_GAUNTLET_ADJUDICATE.md")).toContain("The bar does not move.");
    expect(prompt("USER_PROMPT_GAUNTLET_RUBRIC.md")).toContain("Every criterion must FAIL against the current state");
  });

  test("adjudication treats critic findings as untrusted material, not instructions", () => {
    expect(prompt("USER_PROMPT_GAUNTLET_ADJUDICATE.md")).toContain("untrusted audit material");
    expect(outcomesText(tallyVerdicts(RUBRIC, [{ slot: "alpha", verdicts: [{ id: "c1", pass: false, evidence: "e", gap: "g" }, { id: "c2", pass: true, evidence: "e", gap: "" }] }]))).toContain("----- BEGIN CRITIC FINDING -----");
  });
});

describe("gauntlet loop control", () => {
  const source = module("cmd-gauntlet.ts");

  test("the loop ends for a stated reason and never claims a silent pass", () => {
    expect(source).toContain('type GauntletStop = "passed" | "plateau" | "exhausted"');
    expect(source).toContain('stopReason = "plateau"');
    expect(source).toContain('stopReason = "exhausted"');
    expect(source).toContain('stopReason === "passed" && runOk(architectRun)');
    // An unjudged artifact is an error, never a pass.
    expect(source).toContain("an empty panel is never a pass");
  });

  test("a plateau round stops the loop instead of burning the cap", () => {
    expect(source).toContain("cleared === previous.cleared && lastGate.code === previous.gateExit");
  });

  test("the bar and the gate are both written BEFORE the build", () => {
    const rubricAt = source.indexOf("gauntletRubricPrompt(prompt, plan.tasks, rubricPath)");
    const gateAt = source.indexOf("validatorPrompt(prompt, ctx.cwd, gatePath)");
    const buildAt = source.indexOf("ctx.ui.setStatus(CUSTOM_TYPE, \"gauntlet: building the delegation graph…\")");
    expect(rubricAt).toBeGreaterThan(0);
    expect(gateAt).toBeGreaterThan(rubricAt);
    expect(buildAt).toBeGreaterThan(gateAt);
  });

  test("the round ledger carries compact state between rounds instead of a growing transcript", () => {
    expect(source).toContain("workbenchPath");
    expect(source).toContain("noteWorkbench(");
  });

  test("critics, adjudicators and the integrator are folded into the model bar by hand", () => {
    expect(source).toContain("h.absorbRuns(extraRuns)");
    expect(source.indexOf("stopWidget();\n\t\t\t\t// AFTER stopWidget")).toBeGreaterThan(0);
  });
});

describe("gauntlet roles", () => {
  test("the three hats are real display roles with their own color and glyph", () => {
    for (const role of ["CRITIC", "ADJUDICATOR", "INTEGRATOR"] as const) {
      expect(ROLE_COLOR[role]).toBeTruthy();
      expect(ROLE_GLYPH[role]).toBeTruthy();
    }
    expect(ROLE_COLOR.CRITIC).toBe("error");
  });

  test("only ARCHITECT and BUILDER take their label from the slot", () => {
    // Without this, every gauntlet column would render as "BUILDER" and the flow would be
    // unreadable — the slot would overwrite the hat the run is actually wearing.
    expect([...SLOT_NAMED_ROLES]).toEqual(["ARCHITECT", "BUILDER"]);
    const tui = module("tui.ts");
    expect(tui).toContain("slot && SLOT_NAMED_ROLES.has(role)");
    expect(tui).toContain("SLOT_NAMED_ROLES.has(stat.role)");
  });

  test("the rubric renders for critics with evidence made prominent", () => {
    const text = rubricText(RUBRIC);
    expect(text).toContain("## c1 · BLOCKER");
    expect(text).toContain("evidence: run `./bin/tool --help`");
    expect(text).toContain("judges: the artifact as a whole");
  });
});

describe("gauntlet prompt templates", () => {
  const TASK = { id: "1.a", assignee: "main", description: "write the CLI", depends_on: [], outputs: ["bin/tool"], mode: "write" as const };
  const SLOT = { id: "main", name: "main", model: "anthropic/claude-opus-5", thinking: "high" as const, color: "#F59E0B" as const, architect: false, primary: true, appendSystemPrompts: [] };
  const OUTCOMES = tallyVerdicts(RUBRIC, [{ slot: "alpha", verdicts: [{ id: "c1", pass: false, evidence: "e", gap: "g" }, { id: "c2", pass: true, evidence: "e", gap: "" }] }]);

  // Every {{PLACEHOLDER}} must have a matching fill() key. A typo on either side leaves a
  // literal {{VAR}} in a model's prompt, which reads as a broken instruction rather than
  // failing loudly — so assert the rendered prompts are fully substituted.
  const rendered: Array<[string, string]> = [
    ["rubric", gauntletRubricPrompt("build it", [TASK], "/run/rubric.json")],
    ["critic", gauntletCriticPrompt("build it", RUBRIC, "/project", 1, 3)],
    ["adjudicate", gauntletAdjudicatePrompt("build it", OUTCOMES, 3, 1, 3, { code: 1, output: "FAIL: nope" }, "## Bar\n2 criteria", ["main", "architect"], "/run/repair.json")],
    ["repair", gauntletRepairPrompt(SLOT, "build it", TASK, OUTCOMES, "upstream", 1, 3)],
    ["integrate", gauntletIntegratePrompt("build it", RUBRIC, "/project")],
  ];

  for (const [name, text] of rendered) {
    test(`${name} prompt substitutes every placeholder`, () => {
      expect(text).not.toMatch(/\{\{\w+\}\}/);
      expect(text.trim().length).toBeGreaterThan(200);
    });
  }

  test("both gauntlet system contracts load from disk", () => {
    expect(gauntletCriticSystem().length).toBeGreaterThan(200);
    expect(gauntletIntegratorSystem()).toContain("INTEGRATOR");
  });

  test("the adjudicator is given the concrete gate output and the round ledger", () => {
    const [, text] = rendered.find(([name]) => name === "adjudicate")!;
    expect(text).toContain("FAIL: nope");
    expect(text).toContain("2 criteria");
    expect(text).toContain("main, architect");
  });
});

describe("gauntlet panels", () => {
  const tui = module("tui.ts");
  const runtime = module("runtime.ts");

  test("every gauntlet panel kind has a renderer case", () => {
    // The renderer's default branch prints "✗ FUSION HARNESS · /<cmd> FAILED", so a kind
    // with no case of its own renders a successful round as a failure. Declaring a kind in
    // FhDetails and forgetting the case is silent and wrong, hence this check.
    for (const kind of ["rubric", "verdicts", "gauntlet"]) {
      expect(runtime).toContain(`| "${kind}"`);
      expect(tui).toContain(`case "${kind}": {`);
    }
  });

  test("the shared gate panel names the command that produced it", () => {
    // /fh-gauntlet reuses the "gate" kind, so a hard-coded /fh-auto-validate label lies.
    expect(tui).toContain('`FUSION HARNESS · /${d.command ?? "fh-auto-validate"} — `');
  });

  test("the result panel reports the stop reason rather than a bare ok/fail", () => {
    expect(tui).toContain('d.stopReason === "passed"');
    expect(tui).toContain('d.stopReason === "plateau"');
    expect(tui).toContain('d.stopReason === "exhausted"');
  });
});

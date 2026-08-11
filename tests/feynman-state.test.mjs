import assert from "node:assert/strict";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpHome = await mkdtemp(join(tmpdir(), "feynman-state-test-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

async function loadJiti() {
	try {
		return await import("jiti");
	} catch {
		// Local development often runs without devDependencies installed, while Pi
		// itself vendors jiti. Derive that location from PATH instead of baking in
		// a machine-specific global npm prefix.
		for (const binDir of (process.env.PATH || "").split(":").filter(Boolean)) {
			const candidate = join(
				binDir,
				"..",
				"lib",
				"node_modules",
				"@earendil-works",
				"pi-coding-agent",
				"node_modules",
				"jiti",
				"lib",
				"jiti.mjs",
			);
			try {
				await access(candidate);
				return await import(candidate);
			} catch {
				// Try the next PATH entry.
			}
		}
		throw new Error("Install devDependencies or run tests with Pi's vendored jiti available on PATH.");
	}
}

const { createJiti } = await loadJiti();
const jiti = createJiti(import.meta.url, { moduleCache: false });
const feynmanState = await jiti.import("../.pi/extensions/feynman-state.ts", { default: true });

function createHarness() {
	const tools = new Map();
	const entries = [];
	const pi = {
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		appendEntry(customType, data) {
			entries.push({ customType, data });
		},
	};
	feynmanState(pi);
	return { tools, entries };
}

function ctx(ids, sessionFile = "session-a.jsonl") {
	return {
		sessionManager: {
			getBranch() {
				return ids.map((id) => ({ id }));
			},
			getSessionFile() {
				return sessionFile;
			},
		},
	};
}

async function progress(project) {
	const file = join(tmpHome, ".pi", "feynman-projects", project, "progress.json");
	return JSON.parse(await readFile(file, "utf8"));
}

async function note(project, node, concept) {
	const file = join(tmpHome, ".pi", "feynman-projects", project, "concept-notes", node, `${concept}.md`);
	return readFile(file, "utf8");
}

async function coachMemory() {
	return readFile(coachMemoryFile(), "utf8");
}

function coachMemoryFile() {
	return join(tmpHome, ".pi", "feynman-projects", "_learner", "SOUL.md");
}

async function call(tool, params, context) {
	return tool.execute("test-call", params, undefined, undefined, context);
}

const { tools } = createHarness();
const writeNote = tools.get("feynman_write_concept_note");
const updateProgress = tools.get("feynman_update_progress");
const validateTransition = tools.get("feynman_validate_transition");
const recordScore = tools.get("feynman_record_score");
const listConcepts = tools.get("feynman_list_concepts");
const updateCoachMemory = tools.get("feynman_update_coach_memory");
const readCoachMemory = tools.get("feynman_read_coach_memory");
const retractCoachMemory = tools.get("feynman_retract_coach_memory");

assert.ok(writeNote, "write note tool registered");
assert.ok(updateProgress, "update progress tool registered");
assert.ok(validateTransition, "validate transition tool registered");
assert.ok(recordScore, "record score tool registered");
assert.ok(updateCoachMemory, "update coach memory tool registered");
assert.ok(readCoachMemory, "read coach memory tool registered");
assert.ok(retractCoachMemory, "retract coach memory tool registered");

{
	const reservedProject = await call(
		writeNote,
		{
			project: "_learner",
			outlineNode: "Reserved",
			concept: "Should Not Write",
		},
		ctx(["root", "reserved-1"]),
	);
	assert.equal(reservedProject.details.ok, false);
	assert.equal(reservedProject.details.reason, "reserved_project_slug");

	const result = await call(
		writeNote,
		{
			project: "Branch Demo",
			outlineNode: "Basics",
			concept: "Meaning",
			intuitiveExplanation: "Meaning is what the learner can say simply.",
		},
		ctx(["root", "main-1"]),
	);
	assert.equal(result.details.ok, true);
	const saved = await progress("branch-demo");
	assert.equal(saved.current_state, "WAITING_RESTATEMENT");
	assert.equal(saved.pi_branch.branch_entry_id, "main-1");

	const forked = await call(
		updateProgress,
		{ project: "Branch Demo", progress: { current_state: "CORRECTING" } },
		ctx(["root", "fork-1"]),
	);
	assert.equal(forked.details.ok, false);
	assert.equal(forked.details.reason, "branch_owner_not_in_current_branch");

	const adopted = await call(
		updateProgress,
		{ project: "Branch Demo", progress: { current_state: "CORRECTING" }, branchMode: "adopt" },
		ctx(["root", "fork-1"]),
	);
	assert.equal(adopted.details.ok, true);
	assert.equal(adopted.details.progress.pi_branch.branch_entry_id, "fork-1");

	const invalid = await call(
		updateProgress,
		{ project: "Branch Demo", progress: { current_state: "LEARNING_CONCEPT" } },
		ctx(["root", "fork-1", "fork-2"]),
	);
	assert.equal(invalid.details.ok, false);
	assert.equal(invalid.details.reason, "remediation_not_passed");

	const crossNodeConcept = await call(
		writeNote,
		{
			project: "Branch Demo",
			outlineNode: "Advanced",
			concept: "Transfer",
			intuitiveExplanation: "Transfer means using the idea in a new situation.",
		},
		ctx(["root", "fork-1", "fork-2"]),
	);
	assert.equal(crossNodeConcept.details.ok, false);
	assert.equal(crossNodeConcept.details.reason, "current_concept_not_passed");
}

{
	const initial = await call(
		writeNote,
		{
			project: "Score Demo",
			outlineNode: "Basics",
			concept: "Simple Words",
			intuitiveExplanation: "Use ordinary words to expose unclear thinking.",
		},
		ctx(["root", "score-1"]),
	);
	assert.equal(initial.details.ok, true);

	const invalidScoring = await call(
		validateTransition,
		{ project: "Score Demo", nextProgress: { current_state: "SCORING" } },
		ctx(["root", "score-1", "score-2"]),
	);
	assert.equal(invalidScoring.details.ok, false);
	assert.equal(invalidScoring.details.reason, "missing_or_short_restatement");

	const shortSummary = await call(
		recordScore,
		{
			project: "Score Demo",
			outlineNode: "Basics",
			concept: "Simple Words",
			learnerSummary: "too short",
			scores: { accuracy: 8, simplicity: 8, completeness: 8, exampleAbility: 8, transferAbility: 8 },
		},
		ctx(["root", "score-1", "score-2"]),
	);
	assert.equal(shortSummary.details.ok, false);
	assert.equal(shortSummary.details.reason, "missing_or_short_restatement");

	const noCorrectionRound = await call(
		recordScore,
		{
			project: "Score Demo",
			outlineNode: "Basics",
			concept: "Simple Words",
			learnerSummary: "I can explain this concept in simple words with my own example.",
			scores: { accuracy: 8, simplicity: 8, completeness: 8, exampleAbility: 8, transferAbility: 8 },
		},
		ctx(["root", "score-1", "score-2"]),
	);
	assert.equal(noCorrectionRound.details.ok, false);
	assert.equal(noCorrectionRound.details.reason, "no_correction_round");

	const failing = await call(
		recordScore,
		{
			project: "Score Demo",
			outlineNode: "Basics",
			concept: "Simple Words",
			learnerSummary: "I can explain this concept in simple words but my example is still vague.",
			misconceptions: ["Example is not learner-owned"],
			scores: { accuracy: 6, simplicity: 6, completeness: 5, exampleAbility: 5, transferAbility: 5 },
		},
		ctx(["root", "score-1", "score-2"]),
	);
	assert.equal(failing.details.ok, true);
	assert.equal(failing.details.passed, false);
	assert.equal(failing.details.progress.current_state, "CORRECTING");
	assert.deepEqual(failing.details.concept_entry.active_misconceptions, ["Example is not learner-owned"]);

	const corrected = await call(
		writeNote,
		{
			project: "Score Demo",
			outlineNode: "Basics",
			concept: "Simple Words",
			learnerOutputAndCorrections:
				"Learner replaced the copied definition with a plain explanation and a personal example.",
		},
		ctx(["root", "score-1", "score-2", "score-3"]),
	);
	assert.equal(corrected.details.ok, true);
	assert.match(await note("score-demo", "basics", "simple-words"), /^### Update /m);

	const passing = await call(
		recordScore,
		{
			project: "Score Demo",
			outlineNode: "Basics",
			concept: "Simple Words",
			learnerSummary:
				"I use simple words so weak parts become visible, then I repair the unclear part with my own example.",
			nextState: "LEARNING_CONCEPT",
			nextAction: "Proceed to the next small concept.",
			scores: { accuracy: 8, simplicity: 8, completeness: 7, exampleAbility: 7, transferAbility: 7 },
		},
		ctx(["root", "score-1", "score-2", "score-3", "score-4"]),
	);
	assert.equal(passing.details.ok, true);
	assert.equal(passing.details.passed, true);
	assert.equal(passing.details.progress.current_state, "LEARNING_CONCEPT");

	const nextConcept = await call(
		writeNote,
		{
			project: "Score Demo",
			outlineNode: "Basics",
			concept: "Fuzzy Point",
			intuitiveExplanation: "A fuzzy point is where the explanation stops being concrete.",
		},
		ctx(["root", "score-1", "score-2", "score-3", "score-4", "score-5"]),
	);
	assert.equal(nextConcept.details.ok, true);

	const listed = await call(listConcepts, { project: "Score Demo", last_outcome: "passed" });
	assert.equal(listed.details.total, 1);
	assert.equal(listed.details.concepts[0].concept, "Simple Words");
}

{
	const unsupported = await call(updateCoachMemory, {
		category: "Recurring Weaknesses",
		observation: "Learner may be vague when examples are required.",
		evidence: ["One short example attempt lacked a concrete learner-owned scenario."],
		occurrenceCount: 1,
	});
	assert.equal(unsupported.details.ok, false);
	assert.equal(unsupported.details.reason, "coach_memory_insufficient_confirmation");

	const confirmed = await call(updateCoachMemory, {
		category: "Effective Remediation Patterns",
		observation:
			"Concrete counterexamples help the learner repair vague explanations faster than repeating the definition.",
		evidence: [
			"In Score Demo, the learner replaced a copied definition with a concrete personal example after correction.",
		],
		project: "Score Demo",
		outlineNode: "Basics",
		concept: "Simple Words",
		learnerConfirmed: true,
	});
	assert.equal(confirmed.details.ok, true);
	assert.equal(confirmed.details.path.endsWith("_learner/SOUL.md"), true);

	const stable = await call(updateCoachMemory, {
		category: "Recurring Weaknesses",
		observation:
			"The learner tends to treat a familiar definition as understanding until asked for a learner-owned example.",
		evidence: [
			"First observation: copied or generic explanation before remediation in Score Demo.",
			"Second observation: example ability score stayed below the pass gate before correction.",
		],
		project: "Score Demo",
		occurrenceCount: 2,
	});
	assert.equal(stable.details.ok, true);

	const memory = await coachMemory();
	assert.match(memory, /# Feynman Coach Long-Term Memory/);
	assert.match(memory, /## Effective Remediation Patterns/);
	assert.match(memory, /Concrete counterexamples help the learner/);
	assert.match(memory, /## Recurring Weaknesses/);
	assert.match(memory, /treat a familiar definition as understanding/);

	const readEffective = await call(readCoachMemory, {
		category: "Effective Remediation Patterns",
		maxChars: 4000,
	});
	assert.equal(readEffective.details.ok, true);
	assert.match(readEffective.content[0].text, /## Effective Remediation Patterns/);
	assert.doesNotMatch(readEffective.content[0].text, /## Recurring Weaknesses/);

	await writeFile(
		coachMemoryFile(),
		[
			"# Feynman Coach Long-Term Memory",
			"",
			"## Recurring Weaknesses",
			"",
			"Manual note that should survive cleanup.",
			"- No entries yet.",
			"",
			"## Last Updated",
			"",
			"",
			"Never",
			"",
			"## Last Updated",
			"",
			"Old duplicate",
			"",
		].join("\n"),
		"utf8",
	);

	const dirtyAppend = await call(updateCoachMemory, {
		category: "Recurring Weaknesses",
		observation:
			"Manual editing should not leave placeholder text beside real coach memory entries.",
		evidence: [
			"SOUL.md had a manually edited section with both a note and a stale No entries placeholder.",
			"SOUL.md also had duplicate Last Updated sections before the next memory write.",
		],
		occurrenceCount: 2,
	});
	assert.equal(dirtyAppend.details.ok, true);

	const cleaned = await coachMemory();
	const recurring = cleaned.match(/## Recurring Weaknesses[\s\S]*?(?=\n## |\n*$)/)?.[0] || "";
	assert.doesNotMatch(recurring, /No entries yet/);
	assert.equal((cleaned.match(/^## Last Updated$/gm) || []).length, 1);

	const retracted = await call(retractCoachMemory, {
		entryIdOrMatch: "Manual editing should not leave placeholder",
		reason:
			"Later evidence showed this was a Markdown cleanup test entry, not a real learner pattern.",
	});
	assert.equal(retracted.details.ok, true);

	const activeMemory = await call(readCoachMemory, { maxChars: 8000 });
	assert.doesNotMatch(activeMemory.content[0].text, /Manual editing should not leave placeholder/);

	const auditMemory = await call(readCoachMemory, { includeRetracted: true, maxChars: 8000 });
	assert.match(auditMemory.content[0].text, /## Retracted/);
	assert.match(auditMemory.content[0].text, /Manual editing should not leave placeholder/);
}

// ----------------------------------------------------------------
// Spaced repetition: review schedule lifecycle
// ----------------------------------------------------------------
{
	const reviewDue = tools.get("feynman_review_due");
	const recordReview = tools.get("feynman_record_review");
	const buildSiteTool = tools.get("feynman_build_site");
	assert.ok(reviewDue, "review_due tool registered");
	assert.ok(recordReview, "record_review tool registered");
	assert.ok(buildSiteTool, "build_site tool registered");

	// Create the concept note, then append a correction round so a passing score is allowed.
	await call(
		writeNote,
		{ project: "review-demo", outlineNode: "Basics", concept: "Spaced Concept" },
		ctx(["root", "review-main"]),
	);
	await call(
		writeNote,
		{
			project: "review-demo",
			outlineNode: "Basics",
			concept: "Spaced Concept",
			learnerOutputAndCorrections:
				"Learner first copied the definition, then replaced it with a plain explanation.",
		},
		ctx(["root", "review-main"]),
	);

	// Score a concept as passed; it should get a review schedule with stage 0.
	const scored = await call(
		recordScore,
		{
			project: "review-demo",
			outlineNode: "Basics",
			concept: "Spaced Concept",
			currentConceptNote: join(tmpHome, ".pi", "feynman-projects", "review-demo", "concept-notes", "basics", "spaced-concept.md"),
			learnerSummary:
				"This is a restatement long enough to pass the minimum length requirement for scoring.",
			scores: { accuracy: 8, simplicity: 8, completeness: 8, exampleAbility: 8, transferAbility: 8 },
			nextState: "LEARNING_CONCEPT",
		},
		ctx(["root", "review-main"]),
	);
	assert.equal(scored.details.ok, true);
	assert.equal(scored.details.passed, true);

	const idxFile = join(tmpHome, ".pi", "feynman-projects", "review-demo", "concept-notes", "index.json");
	let idx = JSON.parse(await readFile(idxFile, "utf8"));
	let concept = idx.concepts.find((c) => c.concept === "Spaced Concept");
	assert.ok(concept.review_schedule, "passed concept gets a review schedule");
	assert.ok(concept.review_schedule.stability !== undefined, "passed concept gets an FSRS schedule with stability");
	assert.ok(
		!Number.isNaN(new Date(concept.review_schedule.next_review_at).getTime()),
		"next_review_at is an ISO stamp",
	);

	// Not due today (next review is 1 day out).
	const notDue = await call(reviewDue, { project: "review-demo" }, ctx(["root", "review-main"]));
	assert.equal(notDue.details.ok, true);
	assert.equal(notDue.details.total_due, 0);

	// Force the schedule to be due by rewriting next_review_at into the past.
	idx.concepts.find((c) => c.concept === "Spaced Concept").review_schedule.next_review_at = "2000-01-01T00:00:00.000Z";
	await writeFile(idxFile, JSON.stringify(idx, null, 2), "utf8");

	const due = await call(reviewDue, { project: "review-demo" }, ctx(["root", "review-main"]));
	assert.equal(due.details.ok, true);
	assert.equal(due.details.total_due, 1);
	assert.equal(due.details.due[0].concept, "Spaced Concept");
	assert.ok(due.details.due[0].review_schedule.stability !== undefined, "due concept has FSRS schedule");

	// list_concepts with due filter should also see it.
	const listDue = await call(
		listConcepts,
		{ project: "review-demo", due: true },
		ctx(["root", "review-main"]),
	);
	assert.equal(listDue.details.ok, true);
	assert.equal(listDue.details.total, 1);

	// Record a review: stage advances 0 -> 1, next review moves to +3 days.
	const reviewed = await call(
		recordReview,
		{ project: "review-demo", outline_node: "Basics", concept: "Spaced Concept" },
		ctx(["root", "review-main"]),
	);
	assert.equal(reviewed.details.ok, true);
	assert.ok(reviewed.details.review_schedule.stability !== undefined, "reviewed concept has FSRS schedule with stability");
	assert.ok(reviewed.details.review_schedule.last_reviewed_at, "review records last_reviewed_at");
	assert.equal(reviewed.details.graduated, false);

	idx = JSON.parse(await readFile(idxFile, "utf8"));
	concept = idx.concepts.find((c) => c.concept === "Spaced Concept");
	assert.ok(concept.review_schedule.stability !== undefined, "persisted FSRS schedule has stability");
	assert.ok(concept.review_schedule.last_reviewed_at, "records when reviewed");

	// Build the site; it should exist and contain key sections.
	const site = await call(buildSiteTool, { project: "review-demo" }, ctx(["root", "review-main"]));
	assert.equal(site.details.ok, true);
	assert.ok(site.details.site_path.endsWith("site/index.html"));
	const siteHtml = await readFile(site.details.site_path, "utf8");
	assert.match(siteHtml, /学习仪表盘/);
	assert.match(siteHtml, /复习队列/);
	assert.match(siteHtml, /Spaced Concept/);
	assert.match(siteHtml, /概念清单/);
}

console.log("feynman-state tests passed");

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	slugify,
	projectDir,
	conceptIndexPath,
	reviewsPath,
	nowStamp,
	withQueuedFileMutation,
	readJson,
	writeJson,
	readText,
	reservedProjectValidation,
	validationFailureResult,
	normalizeBranchMode,
} from "./util.js";
import type { JsonObject, ToolContext, BranchMode, ValidationResult } from "./util.js";
import { isReviewDue, daysOverdue, newReviewSchedule, backfillLegacySchedule } from "./review-scheduler.js";
import type { ReviewSchedule } from "./review-scheduler.js";
import {
	conceptNoteParameters,
	walkConceptNoteFiles,
	parseConceptHeader,
	deriveSlugsFromPath,
	renderConceptNote,
	appendCorrection,
} from "./concept-note.js";
import type { ConceptNoteParams } from "./concept-note.js";

type ConceptOutcome = "new" | "learning" | "remediating" | "passed";

type ConceptScoreSummary = {
	average: number;
	min_dimension: number;
	passed: boolean;
	recorded_at: string;
};

type ConceptIndexEntry = {
	outline_node: string;
	concept: string;
	outline_node_slug: string;
	concept_slug: string;
	path: string;
	last_outcome: ConceptOutcome;
	first_written_at?: string;
	last_updated_at?: string;
	last_touched_at?: string;
	last_score?: ConceptScoreSummary;
	active_misconceptions: string[];
	review_schedule?: ReviewSchedule;
	needs_reinforcement?: boolean;
	mastery?: MasterySummary;
};

type ConceptIndexUpdate = {
	outline_node: string;
	concept: string;
	path: string;
	last_outcome?: ConceptOutcome;
	last_score?: ConceptScoreSummary;
	active_misconceptions?: string[];
	review_schedule?: ReviewSchedule;
	needs_reinforcement?: boolean;
};

type ReviewEvent = {
	recorded_at: string;
	outline_node?: string;
	concept?: string;
	rating?: number;
	scores?: Record<string, number>;
	average?: number;
	passed?: boolean | "conditional";
	misconceptions?: string[];
	stability_after?: number;
	next_review_at?: string;
};

type MasteryTrend = "improving" | "flat" | "declining";

type MasterySummary = {
	review_count: number;
	trend: MasteryTrend;
	stability?: number;
	retrievability?: number;
	recurring_misconceptions: string[];
};

function avgOf(xs: number[]): number {
	return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

// Derive a mastery summary from a concept's review-event history and current
// FSRS schedule. review_count + trend come from the events; stability +
// retrievability come from the schedule; recurring_misconceptions are those
// recorded in >=2 separate events.
function computeMastery(events: ReviewEvent[], schedule?: ReviewSchedule): MasterySummary {
	const review_count = events.length;
	const avgs = events
		.map((e) => e.average)
		.filter((v): v is number => typeof v === "number");
	let trend: MasteryTrend = "flat";
	if (avgs.length >= 2) {
		const mid = Math.max(1, Math.floor(avgs.length / 2));
		const firstHalf = avgOf(avgs.slice(0, mid));
		const lastHalf = avgOf(avgs.slice(mid));
		const delta = lastHalf - firstHalf;
		if (delta > 0.1) trend = "improving";
		else if (delta < -0.1) trend = "declining";
	}
	const counts = new Map<string, number>();
	for (const e of events) {
		for (const m of e.misconceptions || []) {
			counts.set(m, (counts.get(m) || 0) + 1);
		}
	}
	const recurring_misconceptions = [...counts.entries()].filter(([, n]) => n >= 2).map(([m]) => m);
	return {
		review_count,
		trend,
		stability: schedule?.stability,
		retrievability: schedule?.retrievability,
		recurring_misconceptions,
	};
}

// mergeProgress is owned by the progress module; concept-index receives it via
// dependency injection so the import graph stays acyclic (progress -> concept-index
// for upsertConceptIndex/entryReviewSchedule/dueCountForProject, but concept-index
// must not import progress, since write_concept_note calls mergeProgress).
type MergeProgress = (
	project: string,
	updates: JsonObject,
	options: {
		ctx?: ToolContext;
		branchMode?: BranchMode;
		source: string;
		scorePassed?: boolean;
		allowConceptSwitch?: boolean;
	},
) => Promise<{ ok: true; progress: JsonObject } | { ok: false; validation: ValidationResult }>;

function entryNodeSlug(entry: ConceptIndexEntry): string {
	return entry.outline_node_slug || slugify(entry.outline_node || "") || "outline-node";
}

function entryConceptSlug(entry: ConceptIndexEntry): string {
	return entry.concept_slug || slugify(entry.concept || "") || "concept";
}

async function upsertConceptIndex(
	project: string,
	update: ConceptIndexUpdate,
): Promise<{ index: JsonObject; entry: ConceptIndexEntry; total: number }> {
	const file = conceptIndexPath(project);
	const slug = slugify(project);
	const nodeSlug = slugify(update.outline_node) || "outline-node";
	const conceptSlug = slugify(update.concept) || "concept";
	return withQueuedFileMutation(file, async () => {
		const current = await readJson(file, { project: slug, concepts: [] });
		const concepts: ConceptIndexEntry[] = Array.isArray(current.concepts) ? current.concepts : [];
		const now = nowStamp();
		const idx = concepts.findIndex((c) => entryNodeSlug(c) === nodeSlug && entryConceptSlug(c) === conceptSlug);
		let entry: ConceptIndexEntry;
		if (idx === -1) {
			entry = {
				outline_node: update.outline_node,
				concept: update.concept,
				outline_node_slug: nodeSlug,
				concept_slug: conceptSlug,
				path: update.path,
				last_outcome: update.last_outcome || "new",
				first_written_at: now,
				last_updated_at: now,
				last_touched_at: now,
				last_score: update.last_score,
				active_misconceptions: update.active_misconceptions || [],
				review_schedule: update.review_schedule,
				needs_reinforcement: update.needs_reinforcement,
			};
			concepts.push(entry);
		} else {
			const prev = concepts[idx];
			entry = {
				...prev,
				outline_node: update.outline_node,
				concept: update.concept,
				outline_node_slug: nodeSlug,
				concept_slug: conceptSlug,
				path: update.path,
				last_outcome: update.last_outcome || prev.last_outcome || "learning",
				first_written_at: prev.first_written_at || now,
				last_updated_at: now,
				last_touched_at: now,
				last_score: update.last_score !== undefined ? update.last_score : prev.last_score,
				active_misconceptions:
					update.active_misconceptions !== undefined
						? update.active_misconceptions
						: prev.active_misconceptions || [],
				review_schedule:
					prev.review_schedule ??
					(update.review_schedule !== undefined
						? update.review_schedule
						: update.last_outcome === "passed" ? newReviewSchedule(now) : undefined),
				needs_reinforcement:
					update.needs_reinforcement !== undefined
						? update.needs_reinforcement
						: prev.needs_reinforcement,
			};
			concepts[idx] = entry;
		}
		// Recompute the derived mastery summary from the durable review-event
		// history so it stays in sync with the latest score/review.
		const events = await readReviewEvents(project, update.outline_node, update.concept);
		entry.mastery = computeMastery(events, entry.review_schedule);

		const next = { project: slug, updated_at: now, concepts };
		await writeJson(file, next);
		return { index: next, entry, total: concepts.length };
	});
}

async function readConceptIndex(project: string): Promise<{ concepts: ConceptIndexEntry[] }> {
	const file = conceptIndexPath(project);
	const data = await readJson(file, { project: slugify(project), concepts: [] });
	const raw = Array.isArray(data.concepts) ? data.concepts : [];
	const nowIso = nowStamp();
	// Backfill any legacy stage-based schedules into the FSRS shape on read, so
	// older progress data loads without manual repair. Disk is not rewritten.
	const concepts = raw.map((c) =>
		c?.review_schedule ? { ...c, review_schedule: backfillLegacySchedule(c.review_schedule, nowIso) } : c,
	);
	return { concepts };
}

async function entryReviewSchedule(
	project: string,
	outlineNode: string,
	concept: string,
): Promise<ReviewSchedule | undefined> {
	const { concepts } = await readConceptIndex(project);
	const found = concepts.find(
		(c) => entryNodeSlug(c) === slugify(outlineNode) && entryConceptSlug(c) === slugify(concept),
	);
	return found?.review_schedule;
}

async function dueCountForProject(project: string, nowIso: string): Promise<number> {
	const { concepts } = await readConceptIndex(project);
	return concepts.filter((c) => isReviewDue(c.review_schedule, nowIso)).length;
}

async function loadLatestScoresBySlug(project: string): Promise<Map<string, ReviewEvent>> {
	const file = reviewsPath(project);
	const data = await readJson(file, { items: [] });
	const items: ReviewEvent[] = Array.isArray(data.items) ? data.items : [];
	const map = new Map<string, ReviewEvent>();
	for (const item of items) {
		const key = `${slugify(item.outline_node || "")}::${slugify(item.concept || "")}`;
		const prev = map.get(key);
		if (!prev || (item.recorded_at || "") > (prev.recorded_at || "")) {
			map.set(key, item);
		}
	}
	return map;
}

// All review events grouped by concept slug. Used by rebuild_concept_index to
// recompute mastery summaries from the durable review-event history.
async function loadReviewEventsBySlug(project: string): Promise<Map<string, ReviewEvent[]>> {
	const file = reviewsPath(project);
	const data = await readJson(file, { items: [] });
	const items: ReviewEvent[] = Array.isArray(data.items) ? data.items : [];
	const map = new Map<string, ReviewEvent[]>();
	for (const item of items) {
		const key = `${slugify(item.outline_node || "")}::${slugify(item.concept || "")}`;
		const arr = map.get(key) || [];
		arr.push(item);
		map.set(key, arr);
	}
	return map;
}

// Read the timestamped review-event trajectory for a concept (optionally
// filtered by outline node). Returns events sorted oldest-first.
async function readReviewEvents(
	project: string,
	outlineNode?: string,
	concept?: string,
): Promise<ReviewEvent[]> {
	const file = reviewsPath(project);
	const data = await readJson(file, { items: [] });
	const items: ReviewEvent[] = Array.isArray(data.items) ? data.items : [];
	const nodeSlug = outlineNode ? slugify(outlineNode) : undefined;
	const conceptSlug = concept ? slugify(concept) : undefined;
	return items
		.filter(
			(e) =>
				(!nodeSlug || slugify(e.outline_node || "") === nodeSlug) &&
				(!conceptSlug || slugify(e.concept || "") === conceptSlug),
		)
		.sort((a, b) => (a.recorded_at || "").localeCompare(b.recorded_at || ""));
}

// Concept slugs whose entry is tagged needs_reinforcement, optionally excluding
// one concept (the one being scored or advanced to). Gates advancing past a
// CONDITIONAL_PASS concept until a later Good-or-better review clears it.
async function needsReinforcementConcepts(project: string, excludeConceptSlug?: string): Promise<string[]> {
	const { concepts } = await readConceptIndex(project);
	return concepts
		.filter((c) => c.needs_reinforcement && entryConceptSlug(c) !== excludeConceptSlug)
		.map((c) => entryConceptSlug(c));
}

export type {
	ConceptOutcome,
	ConceptScoreSummary,
	ConceptIndexEntry,
	ConceptIndexUpdate,
	ReviewEvent,
	MasteryTrend,
	MasterySummary,
};
export {
	entryNodeSlug,
	entryConceptSlug,
	upsertConceptIndex,
	readConceptIndex,
	entryReviewSchedule,
	dueCountForProject,
	loadLatestScoresBySlug,
	loadReviewEventsBySlug,
	readReviewEvents,
	needsReinforcementConcepts,
	computeMastery,
};

export function registerConceptIndexTools(pi: ExtensionAPI, deps: { mergeProgress: MergeProgress }) {
	const { mergeProgress } = deps;

	pi.registerTool({
		name: "feynman_write_concept_note",
		label: "Write Feynman Concept Note",
		description: "Create or update the canonical Markdown note for one Feynman learning concept before teaching it.",
		promptSnippet:
			"feynman_write_concept_note: write the durable Markdown concept note before teaching or remediating a concept.",
		promptGuidelines: [
			"Call feynman_write_concept_note before explaining a new concept.",
			"Call feynman_write_concept_note again after the learner responds to append corrections, useful examples, and misconceptions.",
		],
		parameters: conceptNoteParameters,
		async execute(_toolCallId, params: ConceptNoteParams, _signal, _onUpdate, ctx?: ToolContext) {
			const reserved = reservedProjectValidation(params.project);
			if (reserved) return validationFailureResult(reserved);
			const project = slugify(params.project);
			const nodeSlug = slugify(params.outlineNode) || "outline-node";
			const conceptSlug = slugify(params.concept) || "concept";
			const notePath = join(projectDir(project), "concept-notes", nodeSlug, `${conceptSlug}.md`);

			if (!params.force) {
				const indexFile = conceptIndexPath(project);
				const data = await readJson(indexFile, { project, concepts: [] });
				const concepts: ConceptIndexEntry[] = Array.isArray(data.concepts) ? data.concepts : [];
				const blocker = concepts.find(
					(c) =>
						entryNodeSlug(c) === nodeSlug &&
						entryConceptSlug(c) !== conceptSlug &&
						c.last_outcome === "remediating",
				);
				if (blocker) {
					return {
						content: [
							{
								type: "text",
								text: `Cannot start "${params.concept}": "${blocker.concept}" in the same node is still remediating (avg ${blocker.last_score?.average ?? "?"}). Pass it first via feynman_record_score, or call feynman_write_concept_note again with force: true if the learner explicitly asked to skip.`,
							},
						],
						details: {
							ok: false,
							reason: "remediating_blocker",
							blocker: {
								concept: blocker.concept,
								outline_node: blocker.outline_node,
								path: blocker.path,
								last_outcome: blocker.last_outcome,
								last_score: blocker.last_score,
								active_misconceptions: blocker.active_misconceptions,
							},
						},
					};
				}
			}

			const progressResult = await mergeProgress(
				project,
				{
					current_state: params.state || "WAITING_RESTATEMENT",
					current_outline_node: params.outlineNode,
					current_concept: params.concept,
					current_concept_note: notePath,
					next_action: "Ask the learner to restate this concept in their own words and provide their own example.",
				},
				{
					ctx,
					branchMode: normalizeBranchMode(params.branchMode),
					source: "feynman_write_concept_note",
					allowConceptSwitch: !!params.force,
				},
			);
			if (!progressResult.ok) {
				return validationFailureResult(progressResult.validation);
			}
			const progress = progressResult.progress;

			await withQueuedFileMutation(notePath, async () => {
				await mkdir(dirname(notePath), { recursive: true });
				const existing = await readText(notePath);
				const markdown = existing ? appendCorrection(existing, params) : renderConceptNote({ ...params, project }, notePath);
				await writeFile(notePath, markdown, "utf8");
			});

			const { entry: conceptEntry, total: conceptCount } = await upsertConceptIndex(project, {
				outline_node: params.outlineNode,
				concept: params.concept,
				path: notePath,
				last_outcome: "learning",
			});

			pi.appendEntry("feynman-progress", {
				event: "concept_note_written",
				project,
				outlineNode: params.outlineNode,
				concept: params.concept,
				notePath,
				updatedAt: progress.updated_at,
			});

			return {
				content: [{ type: "text", text: `Saved concept note to ${notePath}` }],
				details: { ok: true, project, notePath, progress, concept_entry: conceptEntry, concept_count: conceptCount },
			};
		},
	});

	pi.registerTool({
		name: "feynman_rebuild_concept_index",
		label: "Rebuild Feynman Concept Index",
		description:
			"Rebuild concept-notes/index.json from concept note files and reviews.json. Use when notes were edited, renamed, or removed outside of the Feynman tools.",
		promptSnippet:
			"feynman_rebuild_concept_index: rebuild concept-notes/index.json from durable sources (filesystem + reviews.json).",
		promptGuidelines: [
			"Use feynman_rebuild_concept_index when concept notes were edited, renamed, or removed outside the Feynman tools.",
			"Use feynman_rebuild_concept_index if /status, /review, or /continue surface entries that disagree with the actual files.",
		],
		parameters: {
			type: "object",
			properties: { project: { type: "string" } },
			required: ["project"],
			additionalProperties: false,
		} as any,
		async execute(_toolCallId, params: { project: string }) {
			const reserved = reservedProjectValidation(params.project);
			if (reserved) return validationFailureResult(reserved);
			const project = slugify(params.project);
			const baseDir = join(projectDir(project), "concept-notes");
			const indexFile = conceptIndexPath(project);
			const files = await walkConceptNoteFiles(baseDir);
			const latest = await loadLatestScoresBySlug(project);
			const eventsBySlug = await loadReviewEventsBySlug(project);
			// Preserve existing review_schedule + mastery when rebuilding, so a
			// rebuild doesn't wipe FSRS runtime state.
			const prevIndex = await readJson(indexFile, { concepts: [] });
			const prevConcepts: ConceptIndexEntry[] = Array.isArray(prevIndex.concepts) ? prevIndex.concepts : [];

			return withQueuedFileMutation(indexFile, async () => {
				const concepts: ConceptIndexEntry[] = [];
				for (const file of files) {
					const text = await readText(file);
					if (!text) continue;
					const header = parseConceptHeader(text);
					const fromPath = deriveSlugsFromPath(file, baseDir);
					const conceptName = header.concept || fromPath.conceptSlug;
					const outlineNodeName = header.outline_node || fromPath.nodeSlug;
					const conceptSlug = slugify(conceptName) || fromPath.conceptSlug;
					const nodeSlug = slugify(outlineNodeName) || fromPath.nodeSlug;
					const latestScore = latest.get(`${nodeSlug}::${conceptSlug}`);

					let last_outcome: ConceptOutcome = "learning";
					let last_score: ConceptScoreSummary | undefined;
					let active_misconceptions: string[] = [];
					if (latestScore) {
						const dims = latestScore.scores ? Object.values(latestScore.scores).filter((v) => typeof v === "number") : [];
						const minDim = dims.length ? Math.min(...(dims as number[])) : 0;
						last_outcome = latestScore.passed ? "passed" : "remediating";
						last_score = {
							average: typeof latestScore.average === "number" ? latestScore.average : 0,
							min_dimension: minDim,
							passed: !!latestScore.passed,
							recorded_at: latestScore.recorded_at || "",
						};
						if (!latestScore.passed) {
							active_misconceptions = latestScore.misconceptions || [];
						}
					}

					let touchedAt: string;
					let bornAt: string;
					try {
						const fileStat = await stat(file);
						touchedAt = fileStat.mtime.toISOString();
						bornAt = fileStat.birthtime ? fileStat.birthtime.toISOString() : touchedAt;
					} catch {
						touchedAt = nowStamp();
						bornAt = touchedAt;
					}

					const prevEntry = prevConcepts.find(
						(c) => entryNodeSlug(c) === nodeSlug && entryConceptSlug(c) === conceptSlug,
					);
					const review_schedule = prevEntry?.review_schedule;
					const events = eventsBySlug.get(`${nodeSlug}::${conceptSlug}`) || [];
					const mastery = computeMastery(events, review_schedule);
					concepts.push({
						outline_node: outlineNodeName,
						concept: conceptName,
						outline_node_slug: nodeSlug,
						concept_slug: conceptSlug,
						path: file,
						last_outcome,
						first_written_at: bornAt,
						last_updated_at: touchedAt,
						last_touched_at: touchedAt,
						last_score,
						active_misconceptions,
						review_schedule,
						mastery,
					});
				}

				const next = { project, updated_at: nowStamp(), concepts };
				await mkdir(dirname(indexFile), { recursive: true });
				await writeJson(indexFile, next);

				const passedCount = concepts.filter((c) => c.last_outcome === "passed").length;
				const remediatingCount = concepts.filter((c) => c.last_outcome === "remediating").length;
				const unscoredCount = concepts.length - passedCount - remediatingCount;

				pi.appendEntry("feynman-progress", {
					event: "concept_index_rebuilt",
					project,
					concept_count: concepts.length,
					passed: passedCount,
					remediating: remediatingCount,
					unscored: unscoredCount,
					updatedAt: next.updated_at,
				});

				return {
					content: [
						{
							type: "text",
							text: `Rebuilt index for ${project}: ${concepts.length} concepts (${passedCount} passed, ${remediatingCount} remediating, ${unscoredCount} unscored).`,
						},
					],
					details: {
						ok: true,
						project,
						concept_count: concepts.length,
						passed: passedCount,
						remediating: remediatingCount,
						unscored: unscoredCount,
					},
				};
			});
		},
	});

	pi.registerTool({
		name: "feynman_list_concepts",
		label: "List Feynman Concepts",
		description:
			"Query concept-notes/index.json with filters. Prefer this over reading the full index when you only need a subset.",
		promptSnippet:
			"feynman_list_concepts: filter concept-notes/index.json by outline_node and/or last_outcome to keep context small.",
		promptGuidelines: [
			"During /review, /status, and /continue, prefer feynman_list_concepts over reading index.json wholesale.",
			"Filter by last_outcome (remediating, passed, learning, new) and/or outline_node to fetch only what you need.",
		],
		parameters: {
			type: "object",
			properties: {
				project: { type: "string" },
				outline_node: { type: "string", description: "Filter to a single outline node (matched by slug)" },
				last_outcome: {
					type: "string",
					description: "Filter to one of: new | learning | remediating | passed",
				},
				due: {
					type: "boolean",
					description: "Only concepts whose spaced-repetition review is due (next_review_at <= now).",
				},
				includeTrajectory: {
					type: "boolean",
					description:
						"Attach the timestamped review-event history per concept. Default false (token-frugal).",
				},
				limit: { type: "number", description: "Max entries to return (default 50, max 500)" },
			},
			required: ["project"],
			additionalProperties: false,
		} as any,
		async execute(
			_toolCallId,
			params: {
				project: string;
				outline_node?: string;
				last_outcome?: string;
				due?: boolean;
				includeTrajectory?: boolean;
				limit?: number;
			},
		) {
			const reserved = reservedProjectValidation(params.project);
			if (reserved) return validationFailureResult(reserved);
			const project = slugify(params.project);
			const file = conceptIndexPath(project);
			const data = await readJson(file, { project, concepts: [] });
			let concepts: ConceptIndexEntry[] = Array.isArray(data.concepts) ? data.concepts : [];
			const now = nowStamp();

			if (params.outline_node) {
				const want = slugify(params.outline_node);
				concepts = concepts.filter((c) => entryNodeSlug(c) === want);
			}
			if (params.last_outcome) {
				concepts = concepts.filter((c) => c.last_outcome === params.last_outcome);
			}
			if (params.due) {
				concepts = concepts.filter((c) => isReviewDue(c.review_schedule, now));
			}

			const total = concepts.length;
			const limit = Math.max(1, Math.min(Number(params.limit || 50), 500));
			let limited = concepts.slice(0, limit);

			// includeTrajectory attaches the timestamped review-event history per
			// concept. Off by default to preserve today's token-frugal shape.
			if (params.includeTrajectory) {
				const allEvents = await readReviewEvents(project);
				limited = limited.map((c) => ({
					...c,
					trajectory: allEvents.filter(
						(e) =>
							slugify(e.outline_node || "") === entryNodeSlug(c) &&
							slugify(e.concept || "") === entryConceptSlug(c),
					),
				}));
			}

			return {
				content: [
					{
						type: "text",
						text: `Returned ${limited.length} of ${total} concepts for ${project}.`,
					},
				],
				details: { ok: true, project, total, returned: limited.length, concepts: limited },
			};
		},
	});

	pi.registerTool({
		name: "feynman_review_due",
		label: "List Due Reviews",
		description:
			"List concepts whose FSRS spaced-repetition review is due today (next_review_at <= now, not graduated), with stability and overdue days. Use at session start and after scoring to plan the 5-minute active-recall warm-up.",
		promptSnippet:
			"feynman_review_due: list concepts whose FSRS-computed next_review_at has passed, so each session starts with active recall.",
		promptGuidelines: [
			"At session start, call feynman_review_due to plan the active-recall warm-up before teaching new content.",
			"Use feynman_record_review after the learner completes a review to advance the schedule.",
		],
		parameters: {
			type: "object",
			properties: {
				project: { type: "string" },
				limit: { type: "number", description: "Max entries to return (default 50, max 500)" },
			},
			required: ["project"],
			additionalProperties: false,
		} as any,
		async execute(_toolCallId, params: { project: string; limit?: number }) {
			const reserved = reservedProjectValidation(params.project);
			if (reserved) return validationFailureResult(reserved);
			const project = slugify(params.project);
			const file = conceptIndexPath(project);
			const data = await readJson(file, { project, concepts: [] });
			const concepts: ConceptIndexEntry[] = Array.isArray(data.concepts) ? data.concepts : [];
			const now = nowStamp();
			// Front-of-queue: needs_reinforcement concepts first, then by next_review_at.
			const due = concepts
				.filter((c) => isReviewDue(c.review_schedule, now))
				.sort((a, b) => {
					const aReinforce = a.needs_reinforcement ? 1 : 0;
					const bReinforce = b.needs_reinforcement ? 1 : 0;
					if (aReinforce !== bReinforce) return bReinforce - aReinforce;
					return (a.review_schedule?.next_review_at || "").localeCompare(b.review_schedule?.next_review_at || "");
				});

			const limit = Math.max(1, Math.min(Number(params.limit || 50), 500));
			const limited = due.slice(0, limit);

			return {
				content: [
					{
						type: "text",
						text:
							limited.length === 0
								? `No reviews due for ${project} today.`
								: `${limited.length} review(s) due for ${project}: ${limited
										.map(
											(c) =>
												`${c.concept} (stability ${c.review_schedule?.stability?.toFixed(1) ?? "?"}, ${daysOverdue(c.review_schedule, now)}d overdue${c.needs_reinforcement ? ", needs reinforcement" : ""})`,
										)
										.join("; ")}`,
					},
				],
				details: { ok: true, project, total_due: due.length, now, due: limited },
			};
		},
	});
}

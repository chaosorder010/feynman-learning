import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	slugify,
	projectDir,
	progressPath,
	reviewsPath,
	conceptIndexPath,
	nowStamp,
	withQueuedFileMutation,
	readJson,
	writeJson,
	readText,
	getBranchInfo,
	validateBranchOwnership,
	normalizeBranchMode,
	branchStamp,
	validationFailureResult,
	clampScore,
	reservedProjectValidation,
} from "./util.js";
import type { JsonObject, ToolContext, BranchMode, BranchInfo, ValidationResult } from "./util.js";
import {
	advanceReviewSchedule,
	newReviewSchedule,
	scoreToRating,
	isGraduated,
	DEFAULT_GRADUATION_STABILITY_DAYS,
	Rating,
	REVIEW_CADENCE_DAYS,
} from "./review-scheduler.js";
import { MIN_RESTATEMENT_CHARS } from "./concept-note.js";
import { upsertConceptIndex, entryReviewSchedule, dueCountForProject } from "./concept-index.js";
import { buildSite } from "./site.js";

type LearningState =
	| "COLLECTING_GOAL"
	| "INGESTING_SOURCES"
	| "BUILDING_OUTLINE"
	| "DIAGNOSING"
	| "LEARNING_CONCEPT"
	| "WAITING_RESTATEMENT"
	| "CORRECTING"
	| "SCORING"
	| "NODE_SUMMARY"
	| "REVIEWING"
	| "ENDED";

type ScoreParams = {
	project: string;
	outlineNode: string;
	concept: string;
	currentConceptNote?: string;
	learnerSummary?: string;
	misconceptions?: string[];
	nextState?: string;
	nextAction?: string;
	scores: {
		accuracy: number;
		simplicity: number;
		completeness: number;
		exampleAbility: number;
		transferAbility: number;
	};
	branchMode?: BranchMode;
};

type ValidateTransitionParams = {
	project: string;
	nextProgress: JsonObject;
	branchMode?: BranchMode;
};

const learningStates = new Set<string>([
	"COLLECTING_GOAL",
	"INGESTING_SOURCES",
	"BUILDING_OUTLINE",
	"DIAGNOSING",
	"LEARNING_CONCEPT",
	"WAITING_RESTATEMENT",
	"CORRECTING",
	"SCORING",
	"NODE_SUMMARY",
	"REVIEWING",
	"ENDED",
]);

const allowedStateTransitions: Record<string, string[]> = {
	NEW: ["COLLECTING_GOAL", "INGESTING_SOURCES", "BUILDING_OUTLINE", "DIAGNOSING", "LEARNING_CONCEPT", "WAITING_RESTATEMENT", "REVIEWING", "ENDED"],
	COLLECTING_GOAL: ["COLLECTING_GOAL", "INGESTING_SOURCES", "ENDED"],
	INGESTING_SOURCES: ["INGESTING_SOURCES", "BUILDING_OUTLINE", "COLLECTING_GOAL", "ENDED"],
	BUILDING_OUTLINE: ["BUILDING_OUTLINE", "DIAGNOSING", "INGESTING_SOURCES", "ENDED"],
	DIAGNOSING: ["DIAGNOSING", "LEARNING_CONCEPT", "BUILDING_OUTLINE", "ENDED"],
	LEARNING_CONCEPT: ["LEARNING_CONCEPT", "WAITING_RESTATEMENT", "CORRECTING", "ENDED"],
	WAITING_RESTATEMENT: ["WAITING_RESTATEMENT", "CORRECTING", "SCORING", "LEARNING_CONCEPT", "NODE_SUMMARY", "ENDED"],
	CORRECTING: ["CORRECTING", "WAITING_RESTATEMENT", "SCORING", "LEARNING_CONCEPT", "NODE_SUMMARY", "ENDED"],
	SCORING: ["SCORING", "CORRECTING", "LEARNING_CONCEPT", "NODE_SUMMARY", "REVIEWING", "ENDED"],
	NODE_SUMMARY: ["NODE_SUMMARY", "LEARNING_CONCEPT", "DIAGNOSING", "REVIEWING", "ENDED"],
	REVIEWING: ["REVIEWING", "WAITING_RESTATEMENT", "CORRECTING", "SCORING", "ENDED"],
	ENDED: ["ENDED", "COLLECTING_GOAL", "INGESTING_SOURCES", "BUILDING_OUTLINE", "DIAGNOSING", "LEARNING_CONCEPT", "WAITING_RESTATEMENT", "REVIEWING"],
};

const updateProgressParameters = {
	type: "object",
	properties: {
		project: { type: "string" },
		progress: { type: "object", additionalProperties: true },
		branchMode: {
			type: "string",
			description:
				"Branch ownership mode: strict (default) rejects writes from forked session branches; adopt transfers project ownership to the current branch.",
		},
	},
	required: ["project", "progress"],
	additionalProperties: false,
} as any;

const recordScoreParameters = {
	type: "object",
	properties: {
		project: { type: "string" },
		outlineNode: { type: "string" },
		concept: { type: "string" },
		currentConceptNote: { type: "string" },
		learnerSummary: { type: "string" },
		misconceptions: { type: "array", items: { type: "string" } },
		nextState: { type: "string" },
		nextAction: { type: "string" },
		branchMode: {
			type: "string",
			description:
				"Branch ownership mode: strict (default) rejects writes from forked session branches; adopt transfers project ownership to the current branch.",
		},
		scores: {
			type: "object",
			properties: {
				accuracy: { type: "number" },
				simplicity: { type: "number" },
				completeness: { type: "number" },
				exampleAbility: { type: "number" },
				transferAbility: { type: "number" },
			},
			required: ["accuracy", "simplicity", "completeness", "exampleAbility", "transferAbility"],
			additionalProperties: false,
		},
	},
	required: ["project", "outlineNode", "concept", "scores"],
	additionalProperties: false,
} as any;

const validateTransitionParameters = {
	type: "object",
	properties: {
		project: { type: "string" },
		nextProgress: { type: "object", additionalProperties: true },
		branchMode: {
			type: "string",
			description:
				"Branch ownership mode: strict (default) rejects writes from forked session branches; adopt transfers project ownership to the current branch.",
		},
	},
	required: ["project", "nextProgress"],
	additionalProperties: false,
} as any;

function isPassedScoreFor(progress: JsonObject, outlineNode?: string, concept?: string): boolean {
	const scores = Array.isArray(progress.scores) ? progress.scores : [];
	const wantNode = slugify(outlineNode || progress.current_outline_node || "");
	const wantConcept = slugify(concept || progress.current_concept || "");
	for (let i = scores.length - 1; i >= 0; i--) {
		const item = scores[i];
		if (slugify(item?.outline_node || "") !== wantNode) continue;
		if (slugify(item?.concept || "") !== wantConcept) continue;
		return item?.passed === true;
	}
	return false;
}

function validateStateTransition(
	current: JsonObject,
	updates: JsonObject,
	options: { scorePassed?: boolean; allowConceptSwitch?: boolean } = {},
): ValidationResult {
	const currentState = String(current.current_state || "NEW");
	const nextState = String(updates.current_state || current.current_state || "NEW");

	if (nextState !== "NEW" && !learningStates.has(nextState)) {
		return {
			ok: false,
			reason: "unknown_state",
			message: `Unknown Feynman state "${nextState}".`,
			current_state: currentState,
			next_state: nextState,
		};
	}

	const currentConcept = slugify(current.current_concept || "");
	const nextConcept = slugify(updates.current_concept || current.current_concept || "");
	const conceptChanged = currentConcept && nextConcept && currentConcept !== nextConcept;
	if (conceptChanged && !options.allowConceptSwitch && !isPassedScoreFor(current)) {
		return {
			ok: false,
			reason: "current_concept_not_passed",
			message:
				"Cannot switch to another concept before the current concept has a recorded passing score.",
			current_state: currentState,
			next_state: nextState,
		};
	}

	if (currentState === "WAITING_RESTATEMENT" && nextState === "LEARNING_CONCEPT" && !options.scorePassed) {
		return {
			ok: false,
			reason: "restatement_required_before_advancing",
			message:
				"Cannot advance from WAITING_RESTATEMENT to LEARNING_CONCEPT. Score the learner's restatement first.",
			current_state: currentState,
			next_state: nextState,
		};
	}

	if (currentState === "CORRECTING" && ["LEARNING_CONCEPT", "NODE_SUMMARY"].includes(nextState) && !options.scorePassed) {
		return {
			ok: false,
			reason: "remediation_not_passed",
			message:
				"Cannot leave CORRECTING for the next concept or node summary until the current concept passes the scoring gate.",
			current_state: currentState,
			next_state: nextState,
		};
	}

	const allowed = allowedStateTransitions[currentState] || allowedStateTransitions.NEW;
	if (currentState !== nextState && !allowed.includes(nextState)) {
		return {
			ok: false,
			reason: "invalid_transition",
			message: `Invalid Feynman state transition: ${currentState} -> ${nextState}.`,
			current_state: currentState,
			next_state: nextState,
		};
	}

	if (nextState === "SCORING") {
		const summary = String(updates.learner_summary || updates.learnerSummary || current.learner_summary || "").trim();
		if (summary.length < MIN_RESTATEMENT_CHARS) {
			return {
				ok: false,
				reason: "missing_or_short_restatement",
				message:
					"Cannot enter SCORING without a learner restatement of at least 20 characters.",
				current_state: currentState,
				next_state: nextState,
			};
		}
	}

	return { ok: true, current_state: currentState, next_state: nextState };
}

async function validateProjectMutation(
	project: string,
	updates: JsonObject,
	options: {
		ctx?: ToolContext;
		branchMode?: BranchMode;
		source: string;
		scorePassed?: boolean;
		allowConceptSwitch?: boolean;
	}): Promise<{ ok: true; current: JsonObject; next: JsonObject; branch?: BranchInfo } | { ok: false; validation: ValidationResult }> {
	const current = await readJson(progressPath(project), {
		project: slugify(project),
		scores: [],
		completed_nodes: [],
		active_misconceptions: [],
	});
	const branch = getBranchInfo(options.ctx);
	const branchValidation = validateBranchOwnership(current, branch, options.branchMode || "strict");
	if (!branchValidation.ok) return { ok: false, validation: branchValidation };

	const stateValidation = validateStateTransition(current, updates, {
		scorePassed: options.scorePassed,
		allowConceptSwitch: options.allowConceptSwitch,
	});
	if (!stateValidation.ok) return { ok: false, validation: stateValidation };

	const stamp = branchStamp(branch, options.source);
	const next = {
		...current,
		...updates,
		project: slugify(project),
		...(stamp ? { pi_branch: stamp } : {}),
		updated_at: nowStamp(),
	};
	return { ok: true, current, next, branch };
}

async function mergeProgress(
	project: string,
	updates: JsonObject,
	options: {
		ctx?: ToolContext;
		branchMode?: BranchMode;
		source: string;
		scorePassed?: boolean;
		allowConceptSwitch?: boolean;
	} = { source: "feynman_update_progress" },
): Promise<{ ok: true; progress: JsonObject } | { ok: false; validation: ValidationResult }> {
	const file = progressPath(project);
	return withQueuedFileMutation(file, async () => {
		const validation = await validateProjectMutation(project, updates, options);
		if (!validation.ok) return validation;

		await writeJson(file, validation.next);
		return { ok: true, progress: validation.next };
	});
}

export type { LearningState, ScoreParams, ValidateTransitionParams };
export {
	learningStates,
	allowedStateTransitions,
	updateProgressParameters,
	recordScoreParameters,
	validateTransitionParameters,
	isPassedScoreFor,
	validateStateTransition,
	mergeProgress,
};

export function registerProgressTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "feynman_update_progress",
		label: "Update Feynman Progress",
		description: "Merge structured updates into a Feynman project's progress.json with serialized file writes.",
		promptSnippet: "feynman_update_progress: update progress.json instead of editing it ad hoc.",
		promptGuidelines: [
			"Use feynman_update_progress whenever the current learning state, node, concept, note path, or next action changes.",
		],
		parameters: updateProgressParameters,
		async execute(_toolCallId, params: { project: string; progress: JsonObject; branchMode?: BranchMode }, _signal, _onUpdate, ctx?: ToolContext) {
			const reserved = reservedProjectValidation(params.project);
			if (reserved) return validationFailureResult(reserved);
			const project = slugify(params.project);
			const progressResult = await mergeProgress(project, params.progress, {
				ctx,
				branchMode: normalizeBranchMode(params.branchMode),
				source: "feynman_update_progress",
			});
			if (!progressResult.ok) {
				return validationFailureResult(progressResult.validation);
			}
			const progress = progressResult.progress;
			pi.appendEntry("feynman-progress", {
				event: "progress_updated",
				project,
				progress,
				updatedAt: progress.updated_at,
			});

			// Rebuild the project dashboard site so it stays in sync with progress.
			await buildSite(project).catch(() => undefined);

			return {
				content: [{ type: "text", text: `Updated progress for ${project}` }],
				details: { ok: true, project, progress },
			};
		},
	});

	pi.registerTool({
		name: "feynman_validate_transition",
		label: "Validate Feynman Transition",
		description:
			"Validate a proposed Feynman progress.json transition and Pi session branch ownership before writing it.",
		promptSnippet:
			"feynman_validate_transition: check whether a proposed Feynman state transition is legal before updating progress.",
		promptGuidelines: [
			"Use feynman_validate_transition when unsure whether a Feynman project can move to the next state.",
			"Do not bypass a feynman_validate_transition failure unless the learner explicitly chooses to adopt the current Pi branch.",
		],
		parameters: validateTransitionParameters,
		async execute(_toolCallId, params: ValidateTransitionParams, _signal, _onUpdate, ctx?: ToolContext) {
			const reserved = reservedProjectValidation(params.project);
			if (reserved) return validationFailureResult(reserved);
			const project = slugify(params.project);
			const validation = await validateProjectMutation(project, params.nextProgress, {
				ctx,
				branchMode: normalizeBranchMode(params.branchMode),
				source: "feynman_validate_transition",
			});
			if (!validation.ok) {
				return validationFailureResult(validation.validation);
			}

			return {
				content: [{ type: "text", text: `Transition is valid for ${project}.` }],
				details: {
					ok: true,
					project,
					current: validation.current,
					next: validation.next,
					branch: validation.branch,
				},
			};
		},
	});

	pi.registerTool({
		name: "feynman_record_score",
		label: "Record Feynman Score",
		description: "Record a concept score, enforce the pass threshold, and update progress and review metadata.",
		promptSnippet:
			"feynman_record_score: record concept scores and enforce average >= 7 with no dimension below 6 before advancing.",
		promptGuidelines: [
			"Use feynman_record_score after evaluating the learner's restatement and example.",
			"Do not advance to the next concept unless feynman_record_score returns passed: true.",
		],
		parameters: recordScoreParameters,
		async execute(_toolCallId, params: ScoreParams, _signal, _onUpdate, ctx?: ToolContext) {
			const reserved = reservedProjectValidation(params.project);
			if (reserved) return validationFailureResult(reserved);
			const project = slugify(params.project);

			const restatement = (params.learnerSummary || "").trim();
			if (restatement.length < MIN_RESTATEMENT_CHARS) {
				return {
					content: [
						{
							type: "text",
							text: `Cannot record a score: learnerSummary is ${restatement.length} chars (minimum ${MIN_RESTATEMENT_CHARS}). Ask the learner to restate the concept in their own words first, then pass that text as learnerSummary.`,
						},
					],
					details: {
						ok: false,
						reason: "missing_or_short_restatement",
						min_length: MIN_RESTATEMENT_CHARS,
						actual_length: restatement.length,
					},
				};
			}

			const scores = {
				accuracy: clampScore(params.scores.accuracy),
				simplicity: clampScore(params.scores.simplicity),
				completeness: clampScore(params.scores.completeness),
				exampleAbility: clampScore(params.scores.exampleAbility),
				transferAbility: clampScore(params.scores.transferAbility),
			};
			const values = Object.values(scores);
			const average = Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
			const minScore = Math.min(...values);
			const passed = average >= 7 && minScore >= 6;

			if (passed) {
				const guardNotePath =
					params.currentConceptNote ||
					join(
						projectDir(project),
						"concept-notes",
						slugify(params.outlineNode) || "outline-node",
						`${slugify(params.concept) || "concept"}.md`,
					);
				const noteText = (await readText(guardNotePath)) || "";
				const correctionRounds = (noteText.match(/^### Update /gm) || []).length;
				if (correctionRounds === 0) {
					return {
						content: [
							{
								type: "text",
								text: `Cannot mark "${params.concept}" as passed without at least one correction round. Call feynman_write_concept_note again with learnerOutputAndCorrections set so the agent's follow-up and the learner's response are appended to the note, then re-score.`,
							},
						],
						details: {
							ok: false,
							reason: "no_correction_round",
							correction_rounds: correctionRounds,
							concept_note: guardNotePath,
						},
					};
				}
			}
			const entry = {
				outline_node: params.outlineNode,
				concept: params.concept,
				concept_note: params.currentConceptNote,
				scores,
				average,
				passed,
				learner_summary: params.learnerSummary || "",
				misconceptions: params.misconceptions || [],
				recorded_at: nowStamp(),
			};

			const progress = await withQueuedFileMutation(progressPath(project), async () => {
				const file = progressPath(project);
				const current = await readJson(file, { project, scores: [], completed_nodes: [], active_misconceptions: [] });
				const nextScores = Array.isArray(current.scores) ? [...current.scores, entry] : [entry];
				const activeMisconceptions = passed ? current.active_misconceptions || [] : params.misconceptions || [];
				const progressUpdates = {
					current_state: passed ? params.nextState || "LEARNING_CONCEPT" : "CORRECTING",
					current_outline_node: params.outlineNode,
					current_concept: params.concept,
					current_concept_note: params.currentConceptNote || current.current_concept_note || "",
					active_misconceptions: activeMisconceptions,
					scores: nextScores,
					next_action:
						params.nextAction ||
						(passed
							? "Proceed to the next concept or summarize the node if the node is complete."
							: "Remediate the lowest scoring dimension before advancing."),
				};
				const branch = getBranchInfo(ctx);
				const branchValidation = validateBranchOwnership(current, branch, normalizeBranchMode(params.branchMode));
				if (!branchValidation.ok) return branchValidation;
				const stateValidation = validateStateTransition(current, progressUpdates, {
					scorePassed: passed,
					allowConceptSwitch: passed,
				});
				if (!stateValidation.ok) return stateValidation;
				const stamp = branchStamp(branch, "feynman_record_score");
				const next = {
					...current,
					project,
					...progressUpdates,
					...(stamp ? { pi_branch: stamp } : {}),
					updated_at: nowStamp(),
				};
				await writeJson(file, next);
				return next;
			});
			if (progress.ok === false) {
				return validationFailureResult(progress);
			}
			const progressState = progress as JsonObject;

			const reviewFile = reviewsPath(project);
			const reviews = await withQueuedFileMutation(reviewFile, async () => {
				const current = await readJson(reviewFile, { project, items: [] });
				const items = Array.isArray(current.items) ? [...current.items, entry] : [entry];
				const next = { ...current, project, items, updated_at: nowStamp() };
				await writeJson(reviewFile, next);
				return next;
			});

			const conceptNotePathForIndex =
				params.currentConceptNote ||
				join(
					projectDir(project),
					"concept-notes",
					slugify(params.outlineNode) || "outline-node",
					`${slugify(params.concept) || "concept"}.md`,
				);

			const { entry: conceptEntry, total: conceptCount } = await upsertConceptIndex(project, {
				outline_node: params.outlineNode,
				concept: params.concept,
				path: conceptNotePathForIndex,
				last_outcome: passed ? "passed" : "remediating",
				last_score: { average, min_dimension: minScore, passed, recorded_at: entry.recorded_at },
				active_misconceptions: passed ? [] : params.misconceptions || [],
				// Initialize the FSRS schedule on first pass; the rating is derived from the
				// rubric average so a high-scoring first pass schedules a longer first interval.
				review_schedule: passed ? newReviewSchedule(nowStamp(), scoreToRating(average)) : undefined,
			});

			pi.appendEntry("feynman-progress", {
				event: "score_recorded",
				project,
				outlineNode: params.outlineNode,
				concept: params.concept,
				average,
				passed,
				updatedAt: progressState.updated_at,
			});

			// Rebuild the project dashboard site so scores and review schedules stay in sync.
			await buildSite(project).catch(() => undefined);

			return {
				content: [
					{
						type: "text",
						text: passed
							? `Recorded passing score ${average}/10 for ${params.concept}`
							: `Recorded non-passing score ${average}/10 for ${params.concept}; continue remediation before advancing.`,
					},
				],
				details: { ok: true, project, passed, average, minScore, scores, progress: progressState, reviews, concept_entry: conceptEntry, concept_count: conceptCount },
			};
		},
	});

	pi.registerTool({
		name: "feynman_record_review",
		label: "Record Review Completion",
		description:
			"Mark a concept as reviewed, advancing its FSRS spaced-repetition schedule. The rating is derived from the optional 5-dimension rubric score; if omitted it defaults to Good. Graduates the concept once stability crosses the project's graduation threshold. Also rebuilds the project site.",
		promptSnippet:
			"feynman_record_review: advance a concept's FSRS review schedule after the learner completes a spaced-repetition review.",
		promptGuidelines: [
			"Call after the learner finishes the active-recall review for a due concept.",
			"Pass scores from the review so the FSRS rating reflects recall quality (high score -> longer interval).",
			"If the learner struggled, record the struggle via learnerSummary instead of skipping the review.",
		],
		parameters: {
			type: "object",
			properties: {
				project: { type: "string" },
				outline_node: { type: "string", description: "Outline node slug the concept belongs to" },
				concept: { type: "string", description: "Concept name" },
				learnerSummary: {
					type: "string",
					description: "Optional: what the learner recalled during the review (for the coach memory trail).",
				},
				scores: {
					type: "object",
					description:
						"Optional 5-dimension rubric score from the review (0-10 each). Drives the FSRS rating (avg>=9 Easy, 7-9 Good, 6-7 Hard, <6 Again); defaults to Good when omitted.",
					properties: {
						accuracy: { type: "number" },
						simplicity: { type: "number" },
						completeness: { type: "number" },
						exampleAbility: { type: "number" },
						transferAbility: { type: "number" },
					},
				},
			},
			required: ["project", "outline_node", "concept"],
			additionalProperties: false,
		} as any,
		async execute(
			_toolCallId,
			params: {
				project: string;
				outline_node: string;
				concept: string;
				learnerSummary?: string;
				scores?: { accuracy: number; simplicity: number; completeness: number; exampleAbility: number; transferAbility: number };
			},
		) {
			const reserved = reservedProjectValidation(params.project);
			if (reserved) return validationFailureResult(reserved);
			const project = slugify(params.project);
			const now = nowStamp();

			// Derive the FSRS rating from the rubric score (single source of truth).
			let rating: Rating = Rating.Good;
			if (params.scores) {
				const vals = [
					clampScore(params.scores.accuracy),
					clampScore(params.scores.simplicity),
					clampScore(params.scores.completeness),
					clampScore(params.scores.exampleAbility),
					clampScore(params.scores.transferAbility),
				];
				const avg = Number((vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(2));
				rating = scoreToRating(avg);
			}

			// Graduation threshold is configurable per project via project.json.
			const projectConfig = await readJson(
				join(projectDir(project), "project.json"),
				{ graduation_stability_days: DEFAULT_GRADUATION_STABILITY_DAYS },
			);
			const gsd = projectConfig?.graduation_stability_days;
			const graduationDays = typeof gsd === "number" && gsd > 0 ? gsd : DEFAULT_GRADUATION_STABILITY_DAYS;

			const advanced = advanceReviewSchedule(
				await entryReviewSchedule(project, params.outline_node, params.concept),
				now,
				rating,
				graduationDays,
			);

			const { entry, total } = await upsertConceptIndex(project, {
				outline_node: params.outline_node,
				concept: params.concept,
				path: join(
					projectDir(project),
					"concept-notes",
					slugify(params.outline_node) || "outline-node",
					`${slugify(params.concept) || "concept"}.md`,
				),
				review_schedule: advanced,
			});

			const graduated = isGraduated(advanced, graduationDays);
			const dueCount = await dueCountForProject(project, now);

			// Keep the project dashboard in sync with the new schedule.
			await buildSite(project).catch(() => undefined);

			const intervalDays = advanced.next_review_at
				? Math.max(0, Math.floor((new Date(advanced.next_review_at).getTime() - new Date(now).getTime()) / 86_400_000))
				: 0;

			return {
				content: [
					{
						type: "text",
						text: graduated
							? `${params.concept} reviewed and graduated (stability ${advanced.stability?.toFixed(1) ?? "?"} >= ${graduationDays} days; no more scheduled reviews).`
							: `${params.concept} reviewed; next review in ~${intervalDays} day(s) (stability ${advanced.stability?.toFixed(1) ?? "?"}).`,
					},
				],
				details: {
					ok: true,
					project,
					outline_node: params.outline_node,
					concept: params.concept,
					review_schedule: advanced,
					rating,
					graduated,
					remaining_due: dueCount,
					concept_count: total,
				},
			};
		},
	});
}

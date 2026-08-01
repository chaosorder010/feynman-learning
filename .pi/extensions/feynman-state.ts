import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type JsonObject = Record<string, any>;
type MutationQueue = <T>(path: string, mutation: () => Promise<T>) => Promise<T>;
type ToolContext = {
	sessionManager?: {
		getBranch?: () => Array<{ id?: string; type?: string; customType?: string; data?: any }>;
		getSessionFile?: () => string | undefined;
	};
};

const localMutationQueues = new Map<string, Promise<unknown>>();
let piMutationQueue: MutationQueue | undefined | null;

// Spaced-repetition review cadence: 1 day -> 3 days -> 1 week -> 1 month (then graduate).
const REVIEW_CADENCE_DAYS = [1, 3, 7, 30];
const REVIEW_GRADUATED_STAGE = REVIEW_CADENCE_DAYS.length; // stage 4 = graduated, no more reviews
const DEFAULT_REVIEW_STAGE = 0;

type BranchMode = "strict" | "adopt";

type ConceptNoteParams = {
	project: string;
	outlineNode: string;
	concept: string;
	state?: string;
	learningGoal?: string;
	intuitiveExplanation?: string;
	preciseDefinition?: string;
	mechanismSteps?: string[];
	minimalExample?: string;
	misconceptions?: string[];
	relationToNeighborConcepts?: string;
	restatementTask?: string;
	checkQuestions?: string[];
	learnerOutputAndCorrections?: string;
	force?: boolean;
	branchMode?: BranchMode;
};

const MIN_RESTATEMENT_CHARS = 20;

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

type CoachMemoryCategory =
	| "Stable Learning Preferences"
	| "Recurring Weaknesses"
	| "Effective Remediation Patterns"
	| "Ineffective Patterns To Avoid"
	| "Scoring Calibration Notes"
	| "Cross-Project Misconceptions"
	| "Coach Self-Corrections";

type CoachMemoryParams = {
	category: CoachMemoryCategory;
	observation: string;
	evidence: string[];
	project?: string;
	outlineNode?: string;
	concept?: string;
	learnerConfirmed?: boolean;
	occurrenceCount?: number;
};

type ReadCoachMemoryParams = {
	category?: CoachMemoryCategory;
	maxChars?: number;
	includeRetracted?: boolean;
};

type RetractCoachMemoryParams = {
	entryIdOrMatch: string;
	reason: string;
};

const conceptNoteParameters = {
	type: "object",
	properties: {
		project: { type: "string" },
		outlineNode: { type: "string" },
		concept: { type: "string" },
		state: { type: "string" },
		learningGoal: { type: "string" },
		intuitiveExplanation: { type: "string" },
		preciseDefinition: { type: "string" },
		mechanismSteps: { type: "array", items: { type: "string" } },
		minimalExample: { type: "string" },
		misconceptions: { type: "array", items: { type: "string" } },
		relationToNeighborConcepts: { type: "string" },
		restatementTask: { type: "string" },
		checkQuestions: { type: "array", items: { type: "string" } },
		learnerOutputAndCorrections: { type: "string" },
		force: {
			type: "boolean",
			description:
				"Set to true to bypass the same-node remediating-blocker check. Use only when the learner explicitly asks to skip the unfinished concept.",
		},
		branchMode: {
			type: "string",
			description:
				"Branch ownership mode: strict (default) rejects writes from forked session branches; adopt transfers project ownership to the current branch.",
		},
	},
	required: ["project", "outlineNode", "concept"],
	additionalProperties: false,
} as any;

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

const coachMemoryParameters = {
	type: "object",
	properties: {
		category: {
			type: "string",
			description:
				"One of: Stable Learning Preferences | Recurring Weaknesses | Effective Remediation Patterns | Ineffective Patterns To Avoid | Scoring Calibration Notes | Cross-Project Misconceptions | Coach Self-Corrections",
		},
		observation: {
			type: "string",
			description:
				"A concrete learner pattern or coach self-correction. Do not write personality labels or unsupported judgments.",
		},
		evidence: {
			type: "array",
			items: { type: "string" },
			description: "Concrete learner outputs, score patterns, or correction records that justify the memory.",
		},
		project: { type: "string" },
		outlineNode: { type: "string" },
		concept: { type: "string" },
		learnerConfirmed: {
			type: "boolean",
			description: "True only when the learner explicitly confirmed this memory should be kept.",
		},
		occurrenceCount: {
			type: "number",
			description: "Number of separate observations supporting this memory. Must be at least 2 unless learnerConfirmed is true.",
		},
	},
	required: ["category", "observation", "evidence"],
	additionalProperties: false,
} as any;

const readCoachMemoryParameters = {
	type: "object",
	properties: {
		category: {
			type: "string",
			description: "Optional section name to read from SOUL.md.",
		},
		maxChars: {
			type: "number",
			description: "Maximum characters to return. Default 12000, max 30000.",
		},
		includeRetracted: {
			type: "boolean",
			description: "When true, include the audit-only Retracted section. Default false.",
		},
	},
	additionalProperties: false,
} as any;

const retractCoachMemoryParameters = {
	type: "object",
	properties: {
		entryIdOrMatch: {
			type: "string",
			description:
				"Entry ID or unique text fragment from the coach memory entry to retract.",
		},
		reason: {
			type: "string",
			description:
				"Concrete reason the memory was disproven, superseded, or should no longer guide coaching.",
		},
	},
	required: ["entryIdOrMatch", "reason"],
	additionalProperties: false,
} as any;

function slugify(input: string): string {
	return input
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
}

function isReservedProjectInput(input: string): boolean {
	return input.trim().startsWith("_");
}

function reservedProjectValidation(input: string): ValidationResult | undefined {
	if (!isReservedProjectInput(input)) return undefined;
	return {
		ok: false,
		reason: "reserved_project_slug",
		message:
			`Project name "${input}" is reserved. Feynman system directories use leading underscores; choose a learner project name that does not start with "_".`,
	};
}

function projectDir(project: string): string {
	return join(homedir(), ".pi", "feynman-projects", slugify(project));
}

function progressPath(project: string): string {
	return join(projectDir(project), "progress.json");
}

function reviewsPath(project: string): string {
	return join(projectDir(project), "reviews.json");
}

function conceptIndexPath(project: string): string {
	return join(projectDir(project), "concept-notes", "index.json");
}

function coachMemoryPath(): string {
	return join(homedir(), ".pi", "feynman-projects", "_learner", "SOUL.md");
}

type ConceptOutcome = "new" | "learning" | "remediating" | "passed";

// Spaced-repetition schedule for one concept.
// stage 0: learned, next review in 1 day
// stage 1: reviewed, next review in 3 days
// stage 2: reviewed, next review in 1 week
// stage 3: reviewed, next review in 1 month
// stage 4 (REVIEW_GRADUATED_STAGE): graduated, no further scheduled reviews
type ReviewSchedule = {
	stage: number;
	next_review_at: string;
	last_reviewed_at?: string;
};

function addDays(iso: string, days: number): string {
	const d = new Date(iso);
	d.setDate(d.getDate() + days);
	return d.toISOString();
}

function isReviewDue(schedule: ReviewSchedule | undefined, nowIso: string): boolean {
	if (!schedule) return false;
	if (schedule.stage >= REVIEW_GRADUATED_STAGE) return false;
	return schedule.next_review_at <= nowIso;
}

function nextReviewStage(schedule: ReviewSchedule | undefined): number {
	if (!schedule) return DEFAULT_REVIEW_STAGE;
	return Math.min(schedule.stage + 1, REVIEW_GRADUATED_STAGE);
}

function daysOverdue(schedule: ReviewSchedule | undefined, nowIso: string): number {
	if (!schedule || !isReviewDue(schedule, nowIso)) return 0;
	const ms = new Date(nowIso).getTime() - new Date(schedule.next_review_at).getTime();
	return Math.max(0, Math.floor(ms / 86_400_000));
}

function newReviewSchedule(nowIso: string): ReviewSchedule {
	return {
		stage: DEFAULT_REVIEW_STAGE,
		next_review_at: addDays(nowIso, REVIEW_CADENCE_DAYS[DEFAULT_REVIEW_STAGE]),
	};
}

function advanceReviewSchedule(schedule: ReviewSchedule | undefined, nowIso: string): ReviewSchedule {
	const stage = nextReviewStage(schedule);
	return {
		stage,
		next_review_at:
			stage >= REVIEW_GRADUATED_STAGE ? "" : addDays(nowIso, REVIEW_CADENCE_DAYS[stage]),
		last_reviewed_at: nowIso,
	};
}

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
};

type ConceptIndexUpdate = {
	outline_node: string;
	concept: string;
	path: string;
	last_outcome?: ConceptOutcome;
	last_score?: ConceptScoreSummary;
	active_misconceptions?: string[];
	review_schedule?: ReviewSchedule;
};

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

type BranchInfo = {
	session_file?: string;
	branch_entry_id?: string;
	branch_entry_ids: string[];
	branch_depth: number;
};

type ValidationResult = {
	ok: boolean;
	reason?: string;
	message?: string;
	current_state?: string;
	next_state?: string;
	branch?: BranchInfo;
	owner?: JsonObject;
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

const coachMemoryCategories: CoachMemoryCategory[] = [
	"Stable Learning Preferences",
	"Recurring Weaknesses",
	"Effective Remediation Patterns",
	"Ineffective Patterns To Avoid",
	"Scoring Calibration Notes",
	"Cross-Project Misconceptions",
	"Coach Self-Corrections",
];

const coachMemoryCategorySet = new Set<string>(coachMemoryCategories);

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
					update.review_schedule !== undefined
						? update.review_schedule
						: prev.review_schedule ??
							(update.last_outcome === "passed" ? newReviewSchedule(now) : undefined),
			};
			concepts[idx] = entry;
		}
		const next = { project: slug, updated_at: now, concepts };
		await writeJson(file, next);
		return { index: next, entry, total: concepts.length };
	});
}

async function readConceptIndex(project: string): Promise<{ concepts: ConceptIndexEntry[] }> {
	const file = conceptIndexPath(project);
	const data = await readJson(file, { project: slugify(project), concepts: [] });
	return { concepts: Array.isArray(data.concepts) ? data.concepts : [] };
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

async function walkConceptNoteFiles(dir: string): Promise<string[]> {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (error: any) {
		if (error?.code === "ENOENT") return [];
		throw error;
	}
	const out: string[] = [];
	for (const dirent of entries) {
		if (dirent.name === "index.json") continue;
		const full = join(dir, dirent.name);
		if (dirent.isDirectory()) {
			out.push(...(await walkConceptNoteFiles(full)));
		} else if (dirent.isFile() && dirent.name.endsWith(".md")) {
			out.push(full);
		}
	}
	return out;
}

function parseConceptHeader(markdown: string): { concept?: string; outline_node?: string } {
	const lines = markdown.split("\n").slice(0, 30);
	const result: { concept?: string; outline_node?: string } = {};
	for (const line of lines) {
		if (!result.concept && line.startsWith("# ")) {
			result.concept = line.slice(2).trim();
		}
		const m = line.match(/^-\s*Outline node:\s*(.+)$/i);
		if (m && !result.outline_node) {
			result.outline_node = m[1].trim();
		}
		if (result.concept && result.outline_node) break;
	}
	return result;
}

function deriveSlugsFromPath(filePath: string, baseDir: string): { nodeSlug: string; conceptSlug: string } {
	const rel = relative(baseDir, filePath);
	const parts = rel.split(/[\\/]/);
	const last = parts[parts.length - 1] || "concept.md";
	const conceptSlug = basename(last, ".md") || "concept";
	const nodeSlug = parts.length >= 2 ? parts[parts.length - 2] : "outline-node";
	return { nodeSlug, conceptSlug };
}

type ReviewItem = {
	outline_node?: string;
	concept?: string;
	scores?: Record<string, number>;
	average?: number;
	passed?: boolean;
	misconceptions?: string[];
	recorded_at?: string;
};

async function loadLatestScoresBySlug(project: string): Promise<Map<string, ReviewItem>> {
	const file = reviewsPath(project);
	const data = await readJson(file, { items: [] });
	const items: ReviewItem[] = Array.isArray(data.items) ? data.items : [];
	const map = new Map<string, ReviewItem>();
	for (const item of items) {
		const key = `${slugify(item.outline_node || "")}::${slugify(item.concept || "")}`;
		const prev = map.get(key);
		if (!prev || (item.recorded_at || "") > (prev.recorded_at || "")) {
			map.set(key, item);
		}
	}
	return map;
}

function nowStamp(): string {
	return new Date().toISOString();
}

async function getPiMutationQueue(): Promise<MutationQueue | undefined> {
	if (piMutationQueue !== undefined) return piMutationQueue || undefined;

	try {
		const mod = await import("@earendil-works/pi-coding-agent");
		piMutationQueue = typeof mod.withFileMutationQueue === "function" ? mod.withFileMutationQueue : null;
	} catch {
		piMutationQueue = null;
	}

	return piMutationQueue || undefined;
}

async function localWithFileMutationQueue<T>(path: string, mutation: () => Promise<T>): Promise<T> {
	const previous = localMutationQueues.get(path) || Promise.resolve();
	let release: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = previous.then(() => current);
	localMutationQueues.set(path, tail);

	await previous;
	try {
		return await mutation();
	} finally {
		release!();
		if (localMutationQueues.get(path) === tail) {
			localMutationQueues.delete(path);
		}
	}
}

async function withQueuedFileMutation<T>(path: string, mutation: () => Promise<T>): Promise<T> {
	const queue = await getPiMutationQueue();
	if (queue) return queue(path, mutation);
	return localWithFileMutationQueue(path, mutation);
}

function normalizeBranchMode(value: string | undefined): BranchMode {
	return value === "adopt" ? "adopt" : "strict";
}

function getBranchInfo(ctx?: ToolContext): BranchInfo | undefined {
	const manager = ctx?.sessionManager;
	if (!manager?.getBranch) return undefined;

	const branch = manager.getBranch();
	const ids = branch.map((entry) => entry.id).filter((id): id is string => typeof id === "string" && id.length > 0);
	return {
		session_file: manager.getSessionFile?.(),
		branch_entry_id: ids[ids.length - 1],
		branch_entry_ids: ids,
		branch_depth: ids.length,
	};
}

function branchStamp(branch: BranchInfo | undefined, source: string): JsonObject | undefined {
	if (!branch?.branch_entry_id && !branch?.session_file) return undefined;
	return {
		session_file: branch.session_file,
		branch_entry_id: branch.branch_entry_id,
		branch_depth: branch.branch_depth,
		source,
		updated_at: nowStamp(),
	};
}

function validateBranchOwnership(current: JsonObject, branch: BranchInfo | undefined, mode: BranchMode): ValidationResult {
	const owner = current.pi_branch;
	if (!owner || mode === "adopt" || !branch) {
		return { ok: true, branch, owner };
	}

	if (owner.session_file && branch.session_file && owner.session_file !== branch.session_file) {
		return {
			ok: false,
			reason: "branch_owner_mismatch",
			message:
				"This Feynman project is owned by a different Pi session file. Use branchMode: \"adopt\" only if the learner wants this branch to take ownership.",
			branch,
			owner,
		};
	}

	if (
		typeof owner.branch_entry_id === "string" &&
		owner.branch_entry_id.length > 0 &&
		!branch.branch_entry_ids.includes(owner.branch_entry_id)
	) {
		return {
			ok: false,
			reason: "branch_owner_not_in_current_branch",
			message:
				"This Feynman project was advanced on another Pi branch. Continue from that branch or use branchMode: \"adopt\" only after choosing this branch as the canonical learning path.",
			branch,
			owner,
		};
	}

	return { ok: true, branch, owner };
}

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

function validationFailureResult(validation: ValidationResult) {
	return {
		content: [
			{
				type: "text",
				text: validation.message || `Feynman state validation failed: ${validation.reason || "unknown"}.`,
			},
		],
		details: {
			ok: false,
			reason: validation.reason || "validation_failed",
			validation,
		},
	};
}

function renderCoachMemoryTemplate(): string {
	return [
		"# Feynman Coach Long-Term Memory",
		"",
		"Purpose: cross-project learner coaching memory. Keep this file factual, evidence-backed, and useful for adapting future coaching. Do not use it as a personality prompt.",
		"",
		"Write rules:",
		"- Record only stable learning patterns, learner-confirmed preferences, effective remediation strategies, or coach self-corrections.",
		"- Do not record unsupported personality judgments.",
		"- Do not duplicate project progress, scores, or concept notes here.",
		"- Each entry must include evidence and whether the learner confirmed it.",
		"",
		...coachMemoryCategories.flatMap((category) => [`## ${category}`, "", "- No entries yet.", ""]),
		"## Retracted",
		"",
		"- No entries yet.",
		"",
		"## Last Updated",
		"",
		"Never",
		"",
	].join("\n");
}

function cleanEvidence(values: string[]): string[] {
	return values.map((value) => value.trim()).filter(Boolean);
}

function validateCoachMemoryInput(params: CoachMemoryParams): { ok: true; evidence: string[] } | ValidationResult {
	if (!coachMemoryCategorySet.has(params.category)) {
		return {
			ok: false,
			reason: "unknown_coach_memory_category",
			message: `Unknown coach memory category "${params.category}".`,
		};
	}

	const observation = params.observation.trim();
	if (observation.length < 20) {
		return {
			ok: false,
			reason: "coach_memory_observation_too_short",
			message:
				"Cannot update coach memory: observation must be at least 20 characters and describe a concrete learning pattern.",
		};
	}

	const evidence = cleanEvidence(params.evidence);
	if (evidence.length === 0 || evidence.every((item) => item.length < 20)) {
		return {
			ok: false,
			reason: "coach_memory_missing_evidence",
			message:
				"Cannot update coach memory without concrete evidence. Include learner output, score pattern, or correction record.",
		};
	}

	const occurrenceCount = Math.max(0, Number(params.occurrenceCount || 0));
	if (params.learnerConfirmed !== true && occurrenceCount < 2) {
		return {
			ok: false,
			reason: "coach_memory_insufficient_confirmation",
			message:
				"Cannot update coach memory from a single unconfirmed observation. Get learner confirmation or provide occurrenceCount >= 2.",
		};
	}

	return { ok: true, evidence };
}

function coachMemoryEntryId(stamp: string): string {
	return `cm-${stamp.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "")}`;
}

function sectionBounds(markdown: string, header: string): { start: number; end: number } | undefined {
	const start = markdown.indexOf(header);
	if (start === -1) return undefined;
	const nextHeader = markdown.indexOf("\n## ", start + header.length);
	return { start, end: nextHeader === -1 ? markdown.length : nextHeader };
}

function ensureSection(markdown: string, header: string): string {
	if (markdown.includes(header)) return markdown;
	const lastUpdated = sectionBounds(markdown, "## Last Updated");
	if (lastUpdated) {
		return `${markdown.slice(0, lastUpdated.start).trimEnd()}\n\n${header}\n\n- No entries yet.\n\n${markdown.slice(lastUpdated.start).trimStart()}`;
	}
	return `${markdown.trimEnd()}\n\n${header}\n\n- No entries yet.\n`;
}

function updateSection(markdown: string, header: string, update: (section: string) => string): string {
	const ensured = ensureSection(markdown, header);
	const bounds = sectionBounds(ensured, header);
	if (!bounds) return ensured;
	const section = ensured.slice(bounds.start, bounds.end);
	return `${ensured.slice(0, bounds.start)}${update(section).trimEnd()}${ensured.slice(bounds.end)}`;
}

function removeEmptyPlaceholder(section: string): string {
	return section.replace(/^\s*-\s*No entries yet\.\s*$/gm, "").trimEnd();
}

function replaceLastUpdated(markdown: string, stamp: string): string {
	const withoutLastUpdated = markdown
		.replace(/\n*## Last Updated[\s\S]*?(?=\n## |\n*$)/g, "")
		.trimEnd();
	return `${withoutLastUpdated}\n\n## Last Updated\n\n${stamp}\n`;
}

function appendCoachMemoryEntry(markdown: string, params: CoachMemoryParams, evidence: string[]): string {
	let next = markdown.trimEnd();
	const categoryHeader = `## ${params.category}`;

	const stamp = nowStamp();
	const entryId = coachMemoryEntryId(stamp);
	const context = [
		params.project ? `project=${slugify(params.project)}` : undefined,
		params.outlineNode ? `outline_node=${params.outlineNode}` : undefined,
		params.concept ? `concept=${params.concept}` : undefined,
	]
		.filter(Boolean)
		.join("; ");
	const entryLines = [
		`### Update ${stamp}`,
		"",
		`- Entry ID: ${entryId}`,
		`- Observation: ${params.observation.trim()}`,
		`- Evidence: ${evidence.join(" | ")}`,
		`- Confirmation: ${params.learnerConfirmed ? "learner-confirmed" : `observed ${Math.max(0, Number(params.occurrenceCount || 0))} times`}`,
		context ? `- Context: ${context}` : undefined,
		"",
	].filter((line): line is string => line !== undefined);

	next = updateSection(next, categoryHeader, (section) => {
		const clean = removeEmptyPlaceholder(section);
		return `${clean}\n\n${entryLines.join("\n")}`;
	});

	return `${replaceLastUpdated(next, stamp).trimEnd()}\n`;
}

function splitCoachMemoryEntries(section: string): { before: string; entries: string[] } {
	const firstEntry = section.indexOf("\n### Update ");
	if (firstEntry === -1) return { before: section.trimEnd(), entries: [] };
	const before = section.slice(0, firstEntry).trimEnd();
	const body = section.slice(firstEntry + 1).trim();
	const entries = body.split(/\n(?=### Update )/g).map((entry) => entry.trim()).filter(Boolean);
	return { before, entries };
}

function retractCoachMemoryEntry(markdown: string, entryIdOrMatch: string, reason: string): { markdown: string; retracted: boolean; entry?: string } {
	const needle = entryIdOrMatch.trim();
	const stamp = nowStamp();
	let found: string | undefined;
	let next = markdown.trimEnd();

	for (const category of coachMemoryCategories) {
		const header = `## ${category}`;
		const bounds = sectionBounds(next, header);
		if (!bounds) continue;
		const section = next.slice(bounds.start, bounds.end);
		const { before, entries } = splitCoachMemoryEntries(section);
		const index = entries.findIndex((entry) => entry.includes(needle));
		if (index === -1) continue;

		found = entries[index];
		const remaining = entries.filter((_, i) => i !== index);
		const replacement = remaining.length > 0 ? `${before}\n\n${remaining.join("\n\n")}` : `${before}\n\n- No entries yet.`;
		next = `${next.slice(0, bounds.start)}${replacement.trimEnd()}${next.slice(bounds.end)}`;
		break;
	}

	if (!found) {
		return { markdown, retracted: false };
	}

	const retractionLines = [
		`### Retraction ${stamp}`,
		"",
		`- Retracted Match: ${needle}`,
		`- Reason: ${reason.trim()}`,
		"",
		"#### Original Entry",
		"",
		found,
		"",
	];

	next = updateSection(next, "## Retracted", (section) => {
		const clean = removeEmptyPlaceholder(section);
		return `${clean}\n\n${retractionLines.join("\n")}`;
	});

	return { markdown: `${replaceLastUpdated(next, stamp).trimEnd()}\n`, retracted: true, entry: found };
}

function stripCoachMemorySection(markdown: string, header: string): string {
	const bounds = sectionBounds(markdown, header);
	if (!bounds) return markdown;
	return `${markdown.slice(0, bounds.start).trimEnd()}\n\n${markdown.slice(bounds.end).trimStart()}`.trim();
}

function extractCoachMemorySection(markdown: string, category: string): string {
	const header = `## ${category}`;
	const bounds = sectionBounds(markdown, header);
	if (!bounds) return "";
	return markdown.slice(bounds.start, bounds.end).trim();
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

function clampScore(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(10, value));
}

function listLines(values: string[] | undefined): string {
	const clean = (values || []).map((value) => value.trim()).filter(Boolean);
	if (clean.length === 0) return "- TODO";
	return clean.map((value) => `- ${value}`).join("\n");
}

function text(value: string | undefined): string {
	return value?.trim() || "TODO";
}

function renderConceptNote(params: ConceptNoteParams, notePath: string): string {
	const state = params.state || "WAITING_RESTATEMENT";
	return [
		`# ${params.concept}`,
		"",
		`- Project: ${slugify(params.project)}`,
		`- Outline node: ${params.outlineNode}`,
		`- State: ${state}`,
		`- Date: ${nowStamp().slice(0, 10)}`,
		`- Path: ${notePath}`,
		"",
		"## Learning Goal",
		"",
		text(params.learningGoal),
		"",
		"## Intuitive Explanation",
		"",
		text(params.intuitiveExplanation),
		"",
		"## Precise Definition And Boundaries",
		"",
		text(params.preciseDefinition),
		"",
		"## Mechanism Steps",
		"",
		listLines(params.mechanismSteps),
		"",
		"## Minimal Example",
		"",
		text(params.minimalExample),
		"",
		"## Counterexamples And Misconceptions",
		"",
		listLines(params.misconceptions),
		"",
		"## Relation To Neighbor Concepts",
		"",
		text(params.relationToNeighborConcepts),
		"",
		"## Feynman Restatement Task",
		"",
		text(params.restatementTask),
		"",
		"## Check Questions",
		"",
		listLines(params.checkQuestions),
		"",
		"## Learner Output And Corrections",
		"",
		text(params.learnerOutputAndCorrections),
		"",
	].join("\n");
}

async function readText(file: string): Promise<string | undefined> {
	try {
		return await readFile(file, "utf8");
	} catch (error: any) {
		if (error?.code === "ENOENT") return undefined;
		throw error;
	}
}

function appendCorrection(existing: string, params: ConceptNoteParams): string {
	const update = params.learnerOutputAndCorrections?.trim();
	if (!update) return existing;

	return [
		existing.trimEnd(),
		"",
		`### Update ${nowStamp()}`,
		"",
		update,
		"",
	].join("\n");
}

async function readJson(file: string, fallback: JsonObject): Promise<JsonObject> {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch (error: any) {
		if (error?.code === "ENOENT") return fallback;
		throw error;
	}
}

async function writeJson(file: string, value: JsonObject): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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

export default function feynmanState(pi: ExtensionAPI) {
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
		name: "feynman_update_coach_memory",
		label: "Update Feynman Coach Memory",
		description:
			"Append an evidence-backed, cross-project learner coaching memory to ~/.pi/feynman-projects/_learner/SOUL.md.",
		promptSnippet:
			"feynman_update_coach_memory: persist learner-confirmed or repeatedly observed coaching patterns in SOUL.md.",
		promptGuidelines: [
			"Use feynman_update_coach_memory only for stable learner preferences, repeated weaknesses, effective remediation patterns, or coach self-corrections.",
			"Do not write personality labels, unsupported judgments, or ordinary project progress into coach memory.",
			"Either learnerConfirmed must be true or occurrenceCount must be at least 2, and evidence must be concrete.",
		],
		parameters: coachMemoryParameters,
		async execute(_toolCallId, params: CoachMemoryParams) {
			const validation = validateCoachMemoryInput(params);
			if (!validation.ok) {
				return validationFailureResult(validation);
			}

			const file = coachMemoryPath();
			const markdown = await withQueuedFileMutation(file, async () => {
				const existing = (await readText(file)) || renderCoachMemoryTemplate();
				const next = appendCoachMemoryEntry(existing, params, validation.evidence);
				await mkdir(dirname(file), { recursive: true });
				await writeFile(file, next, "utf8");
				return next;
			});

			pi.appendEntry("feynman-coach-memory", {
				event: "coach_memory_updated",
				category: params.category,
				project: params.project ? slugify(params.project) : undefined,
				path: file,
				updatedAt: nowStamp(),
			});

			return {
				content: [{ type: "text", text: `Updated coach memory at ${file}` }],
				details: {
					ok: true,
					path: file,
					category: params.category,
					entry_count: (markdown.match(/^### Update /gm) || []).length,
				},
			};
		},
	});

	pi.registerTool({
		name: "feynman_read_coach_memory",
		label: "Read Feynman Coach Memory",
		description:
			"Read the cross-project learner coaching memory from ~/.pi/feynman-projects/_learner/SOUL.md.",
		promptSnippet:
			"feynman_read_coach_memory: read SOUL.md when adapting coaching across projects.",
		promptGuidelines: [
			"Use feynman_read_coach_memory to adapt coaching style across projects without loading unrelated project progress.",
			"Treat SOUL.md as coaching memory, not as a personality prompt or a replacement for progress.json.",
		],
		parameters: readCoachMemoryParameters,
		async execute(_toolCallId, params: ReadCoachMemoryParams = {}) {
			const file = coachMemoryPath();
			const existing = (await readText(file)) || renderCoachMemoryTemplate();
			const selected =
				params.category && coachMemoryCategorySet.has(params.category)
					? extractCoachMemorySection(existing, params.category)
					: params.includeRetracted
						? existing
						: stripCoachMemorySection(existing, "## Retracted");
			const limit = Math.max(1000, Math.min(Number(params.maxChars || 12000), 30000));
			const text = selected.length > limit ? `${selected.slice(0, limit)}\n\n[truncated]` : selected;

			return {
				content: [{ type: "text", text }],
				details: {
					ok: true,
					path: file,
					category: params.category,
					truncated: selected.length > limit,
					chars: text.length,
				},
			};
		},
	});

	pi.registerTool({
		name: "feynman_retract_coach_memory",
		label: "Retract Feynman Coach Memory",
		description:
			"Move a disproven or superseded coach memory entry to the audit-only Retracted section of SOUL.md.",
		promptSnippet:
			"feynman_retract_coach_memory: retract a coach memory entry that should no longer guide coaching.",
		promptGuidelines: [
			"Use feynman_retract_coach_memory when a prior SOUL.md entry is disproven, superseded, or should stop affecting coaching.",
			"Provide a concrete reason. The original entry is preserved under Retracted for auditability.",
		],
		parameters: retractCoachMemoryParameters,
		async execute(_toolCallId, params: RetractCoachMemoryParams) {
			const needle = params.entryIdOrMatch.trim();
			const reason = params.reason.trim();
			if (needle.length < 6 || reason.length < 20) {
				return validationFailureResult({
					ok: false,
					reason: "coach_memory_retraction_too_vague",
					message:
						"Cannot retract coach memory without a specific entry match and a concrete reason of at least 20 characters.",
				});
			}

			const file = coachMemoryPath();
			const result = await withQueuedFileMutation(file, async () => {
				const existing = (await readText(file)) || renderCoachMemoryTemplate();
				const retracted = retractCoachMemoryEntry(existing, needle, reason);
				if (retracted.retracted) {
					await mkdir(dirname(file), { recursive: true });
					await writeFile(file, retracted.markdown, "utf8");
				}
				return retracted;
			});

			if (!result.retracted) {
				return validationFailureResult({
					ok: false,
					reason: "coach_memory_entry_not_found",
					message:
						"Cannot retract coach memory: no active entry matched the provided entryIdOrMatch.",
				});
			}

			pi.appendEntry("feynman-coach-memory", {
				event: "coach_memory_retracted",
				entryIdOrMatch: needle,
				path: file,
				updatedAt: nowStamp(),
			});

			return {
				content: [{ type: "text", text: `Retracted coach memory entry in ${file}` }],
				details: {
					ok: true,
					path: file,
					entryIdOrMatch: needle,
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
				// upsertConceptIndex initializes the spaced-repetition schedule on first pass.
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
			const limited = concepts.slice(0, limit);

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
			"List concepts whose spaced-repetition review is due today (next_review_at <= now), with stage and overdue days. Use at session start and after scoring to plan the 5-minute active-recall warm-up.",
		promptSnippet:
			"feynman_review_due: list concepts due for spaced repetition (1d -> 3d -> 1w -> 1m cadence) so each session starts with active recall.",
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
			const due = concepts
				.filter((c) => isReviewDue(c.review_schedule, now))
				.sort((a, b) =>
					(a.review_schedule?.next_review_at || "").localeCompare(b.review_schedule?.next_review_at || ""),
				);

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
										.map((c) => `${c.concept} (stage ${c.review_schedule?.stage}, ${daysOverdue(c.review_schedule, now)}d overdue)`)
										.join("; ")}`,
					},
				],
				details: { ok: true, project, total_due: due.length, now, due: limited },
			};
		},
	});

	pi.registerTool({
		name: "feynman_record_review",
		label: "Record Review Completion",
		description:
			"Mark a concept as reviewed, advancing its spaced-repetition stage (1d -> 3d -> 1w -> 1m -> graduated). Also rebuilds the project site.",
		promptSnippet:
			"feynman_record_review: advance a concept's review schedule after the learner completes a spaced-repetition review.",
		promptGuidelines: [
			"Call after the learner finishes the active-recall review for a due concept.",
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
			},
			required: ["project", "outline_node", "concept"],
			additionalProperties: false,
		} as any,
		async execute(
			_toolCallId,
			params: { project: string; outline_node: string; concept: string; learnerSummary?: string },
		) {
			const reserved = reservedProjectValidation(params.project);
			if (reserved) return validationFailureResult(reserved);
			const project = slugify(params.project);
			const file = conceptIndexPath(project);
			const now = nowStamp();

			const { entry, total } = await upsertConceptIndex(project, {
				outline_node: params.outline_node,
				concept: params.concept,
				path: join(
					projectDir(project),
					"concept-notes",
					slugify(params.outline_node) || "outline-node",
					`${slugify(params.concept) || "concept"}.md`,
				),
				review_schedule: advanceReviewSchedule(
					await entryReviewSchedule(project, params.outline_node, params.concept),
					now,
				),
			});

			const graduated = entry.review_schedule?.stage !== undefined && entry.review_schedule.stage >= REVIEW_GRADUATED_STAGE;
			const dueCount = await dueCountForProject(project, now);

			// Keep the project dashboard in sync with the new schedule.
			await buildSite(project).catch(() => undefined);

			return {
				content: [
					{
						type: "text",
						text: graduated
							? `${params.concept} reviewed and graduated (no more scheduled reviews).`
							: `${params.concept} reviewed; next review in ${REVIEW_CADENCE_DAYS[entry.review_schedule?.stage ?? 0]} day(s).`,
					},
				],
				details: {
					ok: true,
					project,
					outline_node: params.outline_node,
					concept: params.concept,
					review_schedule: entry.review_schedule,
					graduated,
					remaining_due: dueCount,
					concept_count: total,
				},
			};
		},
	});

	pi.registerTool({
		name: "feynman_build_site",
		label: "Build Project Site",
		description:
			"Generate the project's local dashboard website (site/index.html) from progress.json, index.json, and outline.md: progress bar, review queue, outline navigation, concept list with scores, and learning stats. Called automatically after score/review/progress updates.",
		promptSnippet:
			"feynman_build_site: rebuild the project dashboard HTML (site/index.html) from current project data.",
		promptGuidelines: [
			"Call automatically after record_score, record_review, and update_progress.",
			"The site is a projection of project data; never edit site/index.html by hand.",
		],
		parameters: {
			type: "object",
			properties: {
				project: { type: "string" },
			},
			required: ["project"],
			additionalProperties: false,
		} as any,
		async execute(_toolCallId, params: { project: string }) {
			const reserved = reservedProjectValidation(params.project);
			if (reserved) return validationFailureResult(reserved);
			const project = slugify(params.project);
			try {
				const sitePath = await buildSite(project);
				return {
					content: [{ type: "text", text: `Rebuilt project site at ${sitePath}.` }],
					details: { ok: true, project, site_path: sitePath },
				};
			} catch (error: any) {
				return {
					content: [{ type: "text", text: `Failed to build site: ${error?.message || String(error)}` }],
					details: { ok: false, project, reason: "site_build_failed", error: String(error) },
				};
			}
		},
	});
}

// ============================================================
// Project site generation (local dashboard website)
// ============================================================

const SITE_CSS = `
:root {
  --paper: #fdfcf9; --card: #ffffff; --ink: #1c1c1c;
  --muted: #555555; --faint: #8a8a8a;
  --rule: #e0ddd5; --rule-strong: #b8b4aa;
  --def: #8a6d3b; --def-bg: #faf6ee;
  --intu: #5b7f67; --intu-bg: #f2f6f3;
  --warn: #a05c3c; --warn-bg: #faf3ef;
  --key: #5d5f8a; --key-bg: #f3f3f8;
  --code-bg: #f5f3ef; --radius: 6px;
  --font-main: "Maple Mono NF CN", "Maple Mono CN", "Maple Mono",
    "HarmonyOS Sans SC", "Noto Sans CJK SC", "Microsoft YaHei", monospace;
}
* { box-sizing: border-box; }
html { font-size: 16px; -webkit-text-size-adjust: 100%; }
body { margin: 0; padding: 3rem 1.5rem 6rem; background: var(--paper); color: var(--ink);
  font-family: var(--font-main); line-height: 1.8; font-size: 1rem; }
.page { max-width: 720px; margin: 0 auto; }
.site-header { border-bottom: 4px solid var(--rule-strong); padding-bottom: 1.2rem; margin-bottom: 2rem; }
.site-header .eyebrow { font-size: .8rem; letter-spacing: .12em; text-transform: uppercase; color: var(--faint); margin: 0 0 .4rem; }
.site-header h1 { font-size: 1.6rem; margin: 0 0 .5rem; line-height: 1.4; }
.site-header .meta { color: var(--muted); font-size: .9rem; }
.state-badge { display: inline-block; padding: .1rem .6rem; border-radius: var(--radius);
  background: var(--key-bg); color: var(--key); font-size: .8rem; }
.card { background: var(--card); border: 1px solid var(--rule); border-radius: var(--radius);
  padding: 1.1rem 1.3rem; margin: 0 0 1.4rem; }
.card h2 { font-size: 1.02rem; margin: 0 0 .8rem; color: var(--ink); }
.card h2 .count { color: var(--faint); font-weight: normal; font-size: .85rem; }
.progress-track { background: var(--code-bg); border-radius: var(--radius); height: 12px; overflow: hidden; margin: .4rem 0 .6rem; }
.progress-fill { background: var(--intu); height: 100%; border-radius: var(--radius); }
.progress-labels { display: flex; justify-content: space-between; color: var(--muted); font-size: .85rem; }
.due-item { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem;
  padding: .5rem 0; border-bottom: 1px dashed var(--rule); }
.due-item:last-child { border-bottom: none; }
.due-item .tag { font-size: .78rem; color: var(--warn); white-space: nowrap; }
.due-item .node { color: var(--faint); font-size: .8rem; }
.empty { color: var(--faint); font-style: italic; }
table { width: 100%; border-collapse: collapse; font-size: .9rem; }
th, td { text-align: left; padding: .45rem .6rem; border-bottom: 1px solid var(--rule); }
th { color: var(--muted); font-weight: 600; border-bottom: 2px solid var(--rule-strong); }
.node-row { border-bottom: 2px solid var(--rule); }
.node-row .node-name { font-weight: 600; }
.badge { display: inline-block; padding: 0 .45rem; border-radius: var(--radius); font-size: .78rem; }
.badge.passed { background: var(--intu-bg); color: var(--intu); }
.badge.active { background: var(--def-bg); color: var(--def); }
.badge.todo { background: var(--code-bg); color: var(--faint); }
.badge.remediating { background: var(--warn-bg); color: var(--warn); }
.stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: .8rem; }
.stat { background: var(--card); border: 1px solid var(--rule); border-radius: var(--radius); padding: .8rem 1rem; }
.stat .num { font-size: 1.4rem; font-weight: 600; }
.stat .lbl { color: var(--muted); font-size: .8rem; }
.footer { color: var(--faint); font-size: .78rem; text-align: center; margin-top: 3rem; }
a { color: var(--key); text-decoration: none; }
a:hover { text-decoration: underline; }
@media print { body { padding: 1rem; } .card { break-inside: avoid; } }
`;

function escHtml(value: unknown): string {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function fmtDate(iso: string | undefined): string {
	if (!iso) return "—";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "—";
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type OutlineNodeInfo = { title: string; slug: string };

function parseOutlineNodes(outlineText: string | undefined): OutlineNodeInfo[] {
	if (!outlineText) return [];
	const nodes: OutlineNodeInfo[] = [];
	for (const line of outlineText.split("\n")) {
		const m = line.match(/^###\s+(N\d+)\s*[—-]?\s*(.+)$/);
		if (m) nodes.push({ title: `${m[1]} — ${m[2].trim()}`, slug: m[1].trim().toLowerCase() });
	}
	return nodes;
}

async function readOutline(project: string): Promise<string | undefined> {
	try {
		return await readText(join(projectDir(project), "outline.md"));
	} catch {
		return undefined;
	}
}

async function buildSite(project: string): Promise<string> {
	const dir = projectDir(project);
	const siteDir = join(dir, "site");
	await mkdir(siteDir, { recursive: true });

	const progress = await readJson(progressPath(project), { project, completed_nodes: [] });
	const { concepts } = await readConceptIndex(project);
	const outlineText = await readOutline(project);
	const outlineNodes = parseOutlineNodes(outlineText);
	const now = nowStamp();

	const completedNodes = new Set<string>(
		(Array.isArray(progress.completed_nodes) ? progress.completed_nodes : []).map((n: any) => String(n).toLowerCase()),
	);
	const currentNode = String(progress.current_outline_node || "").toLowerCase();

	const passedConcepts = concepts.filter((c) => c.last_outcome === "passed");
	const remediatingConcepts = concepts.filter((c) => c.last_outcome === "remediating");
	const dueConcepts = concepts
		.filter((c) => isReviewDue(c.review_schedule, now))
		.sort((a, b) => (a.review_schedule?.next_review_at || "").localeCompare(b.review_schedule?.next_review_at || ""));
	const scores = Array.isArray(progress.scores) ? (progress.scores as any[]) : [];
	const averages = scores.filter((s) => typeof s?.average === "number").map((s) => s.average as number);
	const avgScore = averages.length ? (averages.reduce((a, b) => a + b, 0) / averages.length).toFixed(2) : "—";
	const passCount = scores.filter((s) => s?.passed === true).length;

	// ---- outline table rows (concept counts per node) ----
	const conceptsByNode = new Map<string, ConceptIndexEntry[]>();
	for (const c of concepts) {
		const key = entryNodeSlug(c);
		const list = conceptsByNode.get(key) || [];
		list.push(c);
		conceptsByNode.set(key, list);
	}
	const outlineRows = outlineNodes.map((node) => {
		const nodeConcepts = conceptsByNode.get(node.slug) || [];
		const passed = nodeConcepts.filter((c) => c.last_outcome === "passed").length;
		const total = nodeConcepts.length;
		const status = completedNodes.has(node.slug) ? "passed" : currentNode === node.slug ? "active" : "todo";
		const statusBadge =
			status === "passed"
				? '<span class="badge passed">完成</span>'
				: status === "active"
					? '<span class="badge active">进行中</span>'
					: '<span class="badge todo">待学</span>';
		return `<tr class="node-row"><td class="node-name">${escHtml(node.title)}</td><td>${total ? `${passed}/${total}` : "—"}</td><td>${statusBadge}</td></tr>`;
	}).join("\n");

	// ---- concept table ----
	const conceptRows = concepts
		.slice()
		.sort((a, b) => a.outline_node.localeCompare(b.outline_node) || a.concept.localeCompare(b.concept))
		.map((c) => {
			const outcome = c.last_outcome || "new";
			const badge =
				outcome === "passed"
					? '<span class="badge passed">通过</span>'
					: outcome === "remediating"
						? '<span class="badge remediating">补救中</span>'
						: '<span class="badge todo">学习中</span>';
			const avg = c.last_score?.average !== undefined ? `${c.last_score.average.toFixed(1)}` : "—";
			const due = c.review_schedule?.next_review_at
				? fmtDate(c.review_schedule.next_review_at)
				: "—";
			const stage = c.review_schedule?.stage !== undefined ? `S${c.review_schedule.stage}` : "—";
			return `<tr><td>${escHtml(c.outline_node)}</td><td>${escHtml(c.concept)}</td><td>${badge}</td><td>${avg}</td><td>${stage}</td><td>${due}</td></tr>`;
		})
		.join("\n");

	// ---- due review items ----
	const dueItems =
		dueConcepts.length === 0
			? '<div class="empty">今天没有到期的复习 🎉</div>'
			: dueConcepts
					.map((c) => {
						const overdue = daysOverdue(c.review_schedule, now);
						const stageLabel = c.review_schedule?.stage ?? 0;
						const nextLabel =
							stageLabel < REVIEW_GRADUATED_STAGE ? `${REVIEW_CADENCE_DAYS[stageLabel]}天后` : "毕业";
						return `<div class="due-item"><span><strong>${escHtml(c.concept)}</strong> <span class="node">(${escHtml(c.outline_node)})</span></span><span class="tag">${overdue > 0 ? `超期 ${overdue} 天 · ` : ""}下一轮 ${nextLabel}</span></div>`;
					})
					.join("\n");

	// ---- stats ----
	const totalConcepts = concepts.length;
	const nodeTotal = outlineNodes.length;
	const nodeDone = outlineNodes.filter((n) => completedNodes.has(n.slug)).length;
	const progressPct = nodeTotal ? Math.round((nodeDone / nodeTotal) * 100) : 0;

	const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(progress.project || project)} · 学习仪表盘</title>
<style>${SITE_CSS}</style>
</head>
<body>
<div class="page">
  <header class="site-header">
    <p class="eyebrow">Feynman Learning Project</p>
    <h1>🎓 ${escHtml(progress.project || project)}</h1>
    <div class="meta">当前状态: <span class="state-badge">${escHtml(progress.current_state || "NEW")}</span>
      ${progress.current_concept ? ` · 当前概念: <strong>${escHtml(progress.current_concept)}</strong>` : ""}</div>
  </header>

  <div class="card">
    <h2>📈 学习进度 <span class="count">${nodeDone}/${nodeTotal} 节点 · ${passedConcepts.length}/${totalConcepts} 概念</span></h2>
    <div class="progress-track"><div class="progress-fill" style="width:${progressPct}%"></div></div>
    <div class="progress-labels"><span>${nodeDone} 节点完成</span><span>${progressPct}%</span></div>
  </div>

  <div class="card">
    <h2>🔔 复习队列 <span class="count">${dueConcepts.length} 个到期</span></h2>
    ${dueItems}
  </div>

  <div class="card">
    <h2>🗺 大纲导航</h2>
    <table>
      <thead><tr><th>节点</th><th>概念进度</th><th>状态</th></tr></thead>
      <tbody>${outlineRows}</tbody>
    </table>
  </div>

  <div class="card">
    <h2>📖 概念清单 <span class="count">${totalConcepts} 个</span></h2>
    <table>
      <thead><tr><th>节点</th><th>概念</th><th>状态</th><th>均分</th><th>复习阶段</th><th>下次复习</th></tr></thead>
      <tbody>${conceptRows}</tbody>
    </table>
  </div>

  <div class="card">
    <h2>📊 学习统计</h2>
    <div class="stat-grid">
      <div class="stat"><div class="num">${avgScore}</div><div class="lbl">概念平均分</div></div>
      <div class="stat"><div class="num">${passCount}/${scores.length}</div><div class="lbl">评分通过</div></div>
      <div class="stat"><div class="num">${remediatingConcepts.length}</div><div class="lbl">补救中概念</div></div>
      <div class="stat"><div class="num">${dueConcepts.length}</div><div class="lbl">今日待复习</div></div>
    </div>
  </div>

  <div class="footer">由 feynman_build_site 自动生成 · ${escHtml(now)}</div>
</div>
</body>
</html>`;

	const sitePath = join(siteDir, "index.html");
	await writeFile(sitePath, html, "utf8");
	return sitePath;
}

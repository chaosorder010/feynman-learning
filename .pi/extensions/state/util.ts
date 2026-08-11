import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type JsonObject = Record<string, any>;
type MutationQueue = <T>(path: string, mutation: () => Promise<T>) => Promise<T>;
type ToolContext = {
	sessionManager?: {
		getBranch?: () => Array<{ id?: string; type?: string; customType?: string; data?: any }>;
		getSessionFile?: () => string | undefined;
	};
};

type BranchMode = "strict" | "adopt";

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

const localMutationQueues = new Map<string, Promise<unknown>>();
let piMutationQueue: MutationQueue | undefined | null;

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

async function readText(file: string): Promise<string | undefined> {
	try {
		return await readFile(file, "utf8");
	} catch (error: any) {
		if (error?.code === "ENOENT") return undefined;
		throw error;
	}
}

// Shared description for the branchMode parameter used by several tools.
const BRANCH_MODE_DESCRIPTION =
	"Branch ownership mode: strict (default) rejects writes from forked session branches; adopt transfers project ownership to the current branch.";

function clampScore(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(10, value));
}

// Average of rubric values, rounded to 2 decimals. Single source for the
// 5-dimension average shared by record_score and record_review.
function rubricAverage(values: number[]): number {
	return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

// Whole days from b to a, never negative (a == b -> 0).
function daysBetween(a: Date | string, b: Date | string): number {
	const ms = new Date(a).getTime() - new Date(b).getTime();
	return Math.max(0, Math.floor(ms / 86_400_000));
}

// Tool entry-point project resolution: validates reserved names and applies
// the slug. Use instead of the repeated reservedProjectValidation + slugify pair.
function resolveProject(value: string): { reserved?: ValidationResult; project: string } {
	const reserved = reservedProjectValidation(value);
	if (reserved) return { reserved, project: "" };
	return { project: slugify(value) };
}

// Canonical path to a concept note file.
function conceptNotePath(project: string, outlineNode: string, concept: string): string {
	return join(
		projectDir(project),
		"concept-notes",
		slugify(outlineNode) || "outline-node",
		`${slugify(concept) || "concept"}.md`,
	);
}

// Per-project graduation threshold (stability days) from project.json, falling
// back to the default when absent or invalid.
async function readGraduationStabilityDays(project: string, defaultDays: number): Promise<number> {
	const config = await readJson(join(projectDir(project), "project.json"), {
		graduation_stability_days: defaultDays,
	});
	const value = config?.graduation_stability_days;
	return typeof value === "number" && value > 0 ? value : defaultDays;
}

export type {
	JsonObject,
	MutationQueue,
	ToolContext,
	BranchMode,
	BranchInfo,
	ValidationResult,
};
export {
	slugify,
	isReservedProjectInput,
	reservedProjectValidation,
	projectDir,
	progressPath,
	reviewsPath,
	conceptIndexPath,
	coachMemoryPath,
	nowStamp,
	getPiMutationQueue,
	localWithFileMutationQueue,
	withQueuedFileMutation,
	normalizeBranchMode,
	getBranchInfo,
	branchStamp,
	validateBranchOwnership,
	validationFailureResult,
	readJson,
	writeJson,
	readText,
	clampScore,
	BRANCH_MODE_DESCRIPTION,
	rubricAverage,
	daysBetween,
	resolveProject,
	conceptNotePath,
	readGraduationStabilityDays,
};

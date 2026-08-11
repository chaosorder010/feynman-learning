import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";

// FSRS scheduler tests - covers issue #3 acceptance criteria at the scheduler
// layer (pure functions) and the rubric->rating->schedule path.

async function loadJiti() {
	try {
		return await import("jiti");
	} catch {
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
		throw new Error("jiti not found");
	}
}

const { createJiti } = await loadJiti();
const jiti = createJiti(import.meta.url, { moduleCache: false });
const mod = await jiti.import("../.pi/extensions/state/review-scheduler.ts");
const {
	scoreToRating,
	newReviewSchedule,
	advanceReviewSchedule,
	isReviewDue,
	isGraduated,
	backfillLegacySchedule,
	Rating,
	REVIEW_CADENCE_DAYS,
	DEFAULT_GRADUATION_STABILITY_DAYS,
} = mod;

const NOW = "2026-08-11T00:00:00.000Z";

// Acceptance #5: rating is derived from the rubric score (single source of truth).
assert.equal(scoreToRating(9.5), Rating.Easy, "avg>=9 -> Easy");
assert.equal(scoreToRating(8), Rating.Good, "7<=avg<9 -> Good");
assert.equal(scoreToRating(6.5), Rating.Hard, "6<=avg<7 -> Hard");
assert.equal(scoreToRating(5), Rating.Again, "avg<6 -> Again");

// Acceptance #1: Easy-band rubric average yields a further next_review_at than Hard-band.
const easyFromRubric = newReviewSchedule(NOW, scoreToRating(9.5));
const hardFromRubric = newReviewSchedule(NOW, scoreToRating(6.5));
assert.ok(new Date(easyFromRubric.next_review_at) > new Date(NOW), "Easy schedules a future review");
assert.ok(new Date(hardFromRubric.next_review_at) > new Date(NOW), "Hard schedules a future review");
assert.ok(
	new Date(easyFromRubric.next_review_at) > new Date(hardFromRubric.next_review_at),
	"Easy-band rubric -> further next_review_at than Hard-band",
);
assert.ok(easyFromRubric.stability !== undefined, "FSRS schedule carries stability");
assert.ok(easyFromRubric.last_rating === Rating.Easy, "last_rating recorded");

// Direct rating comparison (no rubric) - Easy interval >= Hard interval.
const easyDirect = newReviewSchedule(NOW, Rating.Easy);
const hardDirect = newReviewSchedule(NOW, Rating.Hard);
assert.ok(
	new Date(easyDirect.next_review_at) >= new Date(hardDirect.next_review_at),
	"Easy rating yields >= interval than Hard rating",
);

// Acceptance #2: review_due surfaces concepts whose FSRS next_review_at has passed.
assert.equal(isReviewDue(undefined, NOW), false, "no schedule -> not due");
assert.equal(isReviewDue({ next_review_at: "2000-01-01T00:00:00.000Z" }, NOW), true, "past due -> due");
assert.equal(isReviewDue({ next_review_at: "2099-01-01T00:00:00.000Z" }, NOW), false, "future -> not due");
assert.equal(
	isReviewDue({ next_review_at: "2000-01-01T00:00:00.000Z", state: "graduated" }, NOW),
	false,
	"graduated -> not due even if next_review_at is past",
);

// Acceptance #3: graduation by a configurable stability threshold, not a fixed stage.
const lowStability = { stability: 10, next_review_at: "2000-01-01T00:00:00.000Z" };
const highStability = { stability: 200, next_review_at: "2000-01-01T00:00:00.000Z" };
assert.equal(isGraduated(lowStability, 100), false, "stability below threshold -> not graduated");
assert.equal(isGraduated(highStability, 100), true, "stability above threshold -> graduated");
assert.equal(
	isGraduated(highStability, 300),
	false,
	"threshold is configurable per project (300 > 200 stability)",
);
assert.equal(DEFAULT_GRADUATION_STABILITY_DAYS, 100, "default threshold is 100 days");

// advanceReviewSchedule graduates when stability crosses the threshold.
const nearGraduation = newReviewSchedule(NOW, Rating.Easy);
// Repeatedly advance with Easy; FSRS stability grows. After enough Easy reviews the
// concept should graduate. We cap iterations to avoid an infinite loop.
let sched = nearGraduation;
let graduated = false;
for (let i = 0; i < 20; i++) {
	sched = advanceReviewSchedule(sched, NOW, Rating.Easy, 50);
	if (sched.state === "graduated") {
		graduated = true;
		break;
	}
}
assert.ok(graduated, "repeated Easy reviews eventually graduate via stability threshold (50 days)");

// Acceptance #4: legacy stage-based schedule backfills without error.
const legacyStage2 = {
	stage: 2,
	next_review_at: "2026-08-11T00:00:00.000Z",
	last_reviewed_at: "2026-08-11T00:00:00.000Z",
};
const backfilled = backfillLegacySchedule(legacyStage2, NOW);
assert.ok(backfilled.stability !== undefined, "backfill sets stability");
assert.equal(backfilled.stability, REVIEW_CADENCE_DAYS[2], "stage k -> stability = cadence[k]");
assert.equal(backfilled.state, "review", "legacy non-graduated -> review state");
assert.ok(backfilled.next_review_at, "backfill produces a next_review_at");
assert.equal(backfilled.stage, 2, "legacy stage field retained on disk");

// Legacy graduated stage backfills to graduated state.
const legacyGraduated = { stage: 4, next_review_at: "", last_reviewed_at: "2026-08-11T00:00:00.000Z" };
const bfGrad = backfillLegacySchedule(legacyGraduated, NOW);
assert.equal(bfGrad.state, "graduated", "legacy stage 4 -> graduated state");
assert.ok(bfGrad.stability !== undefined, "graduated backfill still sets stability");

// Already-FSRS schedule is not re-backfilled (idempotent).
const fsrsSched = { stability: 5, next_review_at: "2099-01-01T00:00:00.000Z", state: "review" };
assert.strictEqual(backfillLegacySchedule(fsrsSched, NOW), fsrsSched, "FSRS schedule passes through unchanged");

// Backfilling undefined / missing schedule is safe.
assert.strictEqual(backfillLegacySchedule(undefined, NOW), undefined, "undefined -> undefined");

// advanceReviewSchedule: advancing with Hard yields a shorter interval than Easy.
const baseSched = newReviewSchedule(NOW, Rating.Good);
const advHard = advanceReviewSchedule(baseSched, NOW, Rating.Hard);
const advEasy = advanceReviewSchedule(baseSched, NOW, Rating.Easy);
assert.ok(
	new Date(advEasy.next_review_at) >= new Date(advHard.next_review_at),
	"Easy advance yields >= interval than Hard advance",
);
assert.ok(advHard.last_reviewed_at, "advance records last_reviewed_at");

console.log("feynman-scheduler tests passed");

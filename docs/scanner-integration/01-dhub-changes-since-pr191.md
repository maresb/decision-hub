# dhub Changes Since PR #191 Branch

**Date**: 2026-03-13
**Merge base**: `b02cab5` (PR #191 branched from main here)
**Commits on main since**: 99 commits across ~80 merged PRs

## Overview

PR #191 (`fix/scanner-gemini-schema-patch`) branched from main around 2026-02-24. Since then, 99 commits have landed on main. The changes relevant to scanner re-integration are categorized below.

---

## 1. Publish Pipeline Refactoring

### `execute_publish` Extraction (#236)

The biggest structural change. The publish logic was extracted from three separate locations (HTTP endpoint, crawler, tracker) into a single `execute_publish()` function in a new module `server/src/decision_hub/domain/publish_pipeline.py`.

**Impact on scanner integration**: This is a *major simplification*. PR #191 had to patch three separate code paths (registry_routes, crawler/processing, tracker_service). Now there's a single entry point. The scanner integration only needs to hook into `execute_publish()` and `run_gauntlet_pipeline()`.

Key files:
- `server/src/decision_hub/domain/publish_pipeline.py` (new — 794 lines)
- `server/src/decision_hub/api/registry_routes.py` (simplified to -200 lines)
- `server/src/decision_hub/api/registry_service.py` (reduced to -538 lines, now mostly re-exports)
- `server/src/decision_hub/domain/tracker_service.py` (reduced to -166 lines)

### Crawler Parallelization (#249)

Crawler now processes skills in parallel via `ThreadPoolExecutor`. This matters for the scanner bridge because:
- The old PR #191 `_capture_stdout_during()` hack (replacing `sys.stdout` globally) is **NOT thread-safe**. With parallel crawling, this is a guaranteed race condition.
- The scanner bridge must be thread-safe or use per-invocation isolation.

### S3 Upload Reordering (#231)

DB commit now happens *before* S3 upload, with rollback on S3 failure. Scanner results stored in audit logs would benefit from this pattern (durable even if S3 fails).

---

## 2. Gauntlet Improvements

Since PR #191, the gauntlet has received significant hardening:

### Security Hardening (#198 — +736 lines to gauntlet.py)
- Holistic LLM body review (`review_prompt_body_safety`) — fallback when regex finds nothing
- Holistic LLM code review (`review_code_body_safety`) — fallback when regex finds nothing
- Scan coverage warnings for oversized content
- `_always_fail_combo()` for exec/eval + network + file read
- Tool-use consistency check (`check_tool_consistency`)
- Pipeline taint tracking (`check_pipeline_taint`)
- Source size warning (`check_source_size`)
- `unscanned_files` tracking

### False Positive Reduction (#262)
- 57 of 102 F-graded skills were false positives (56%)
- Added meta-skill exemptions and improved detection thresholds

### Specific Fixes
- Credential detection FP reduction (#210)
- `parse_frontmatter_yaml` in manifest schema check (ce4ed57)
- Strip markdown code fences before elevated permission scanning (#287, #288)
- Holistic body review FP reduction on meta-skills (#292)
- LLM body review cap raised from 30KB to 50KB (#297)

### Dead Code Removal (#234)
- Removed unused DB functions, legacy test models, and a feature flag
- Removed 94 lines from gauntlet.py, 48 from database.py, 7 from models.py

---

## 3. Gauntlet Current Architecture

The gauntlet now runs **10 checks** (up from ~5 in the PR #191 era):

| # | Check | Type | LLM Fallback |
|---|-------|------|-------------|
| 1 | `manifest_schema` | YAML validation | No |
| 2 | `unscanned_files` | Zip inspection | No |
| 3 | `source_size` | Size limit | No |
| 4 | `llm_coverage` | Content cap warnings | No |
| 5 | `dependency_audit` | Package blocklist | No |
| 6 | `embedded_credentials` | Regex + entropy + LLM | Yes |
| 7 | `safety_scan` | Regex + LLM code review | Yes |
| 8 | `prompt_safety` | Regex + LLM body review | Yes |
| 9 | `pipeline_taint` | Shell taint tracking | No |
| 10 | `tool_consistency` | Manifest vs code check | No |

Five LLM callbacks are now wired through `run_gauntlet_pipeline()`:
1. `analyze_fn` — code safety judge
2. `analyze_prompt_fn` — prompt injection judge
3. `review_body_fn` — holistic SKILL.md body review
4. `review_code_fn` — holistic code review
5. `analyze_credential_fn` — credential entropy review

---

## 4. Data Model Changes

### eval_audit_logs Table
Still exists and is actively used. Schema unchanged from PR #191 era:
- Stores grade (A/B/C/F), check_results (JSONB), llm_reasoning (JSONB)
- Quarantine dedup index added (#277): `(org_slug, skill_name, checksum, grade)`
- **No `scan_reports` or `scan_findings` tables exist on main**

### New Model Fields (models.py)
- `github_stars`, `github_forks`, `github_license` on `SkillIndexEntry` (#223)
- `source_status` field (#258)
- `manifest_path` (#217)
- `github_license` on SkillSummary (#225)
- `ask_result_count` on SkillIndexEntry (#211)
- `tracker_consecutive_failures` (#257)

### New Database Functions
- `fetch_quarantine_dedup()` — check if identical checksum was already F-graded (#277)
- `fetch_similar_skills()` — embedding-based similarity (#246)
- `update_tracker_consecutive_failures()` (#257)
- `detect_removed_skills()` (#227)
- Various tracker hardening functions

---

## 5. Infrastructure Changes

### Gemini Model Update (#243)
Model changed from `gemini-2.5-flash` to `gemini-3.1-flash-lite-preview`. This affects both gauntlet LLM calls and would affect scanner LLM calls.

### Rate Limiting (#230)
New publish/auth rate limiters. Any new scan-report endpoints would need similar rate limiting.

### TTL Cache (#233)
Hot read paths now use in-memory TTL cache. Scan report endpoints could benefit from this.

### Structured JSON Logging (#232)
New `log_format` setting. Scanner bridge logging should follow the same pattern.

### Retry/Backoff for Gemini (#266, #296)
Transient Gemini errors now get automatic retry with backoff. Scanner LLM calls should use the same pattern.

---

## 6. Tracker/Crawler Hardening

Significant effort went into making the tracker and crawler robust:
- Mass GitHub API failure handling (#274)
- Consecutive failure thresholds before disabling trackers (#257)
- Version race conditions (#271, #281, #294)
- Quarantine checksum dedup for tracker (#277)
- Timeout handling (#279, #290)
- Archived repo handling (#261)
- Removed skills detection (#227, #268)
- Circuit breaker for systemic failures

These changes affect `tracker_service.py`, `crawler/processing.py`, and `database.py` — all files that PR #191 modified heavily.

---

## 7. Frontend Changes

- Styled audit log with severity grid (#201) — the frontend now has a pattern for displaying audit data
- Typography CSS variables (#204) — all new UI must use the scale
- Mobile-first requirement — all new components need responsive styles
- Similar skills panel (#246) — sidebar pattern reusable for scan reports
- Feature flags file exists: `frontend/src/featureFlags.ts` with `LINK_TO_MANIFEST`

---

## Summary: Integration Points

For a fresh scanner integration, the key touchpoints are:

1. **`publish_pipeline.py`** — single entry point for all publishes (new since PR #191)
2. **`run_gauntlet_pipeline()`** — where to add parallel scanner execution
3. **`execute_publish()`** — where to combine gauntlet + scanner grades
4. **`eval_audit_logs`** — existing audit table (do NOT drop; add scan data alongside)
5. **`settings.py`** — needs scanner feature flag and config
6. **`frontend/src/featureFlags.ts`** — established pattern for feature flags
7. **`gauntlet.py`** — 1355 lines of mature check logic that should NOT be replaced

The publish pipeline unification (#236) is the single biggest enabler — it means one integration point instead of three.

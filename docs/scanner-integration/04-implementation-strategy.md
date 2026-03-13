# Implementation Strategy: Parallel Cisco Scanner Integration

**Date**: 2026-03-13
**Goal**: Run the Cisco skill-scanner alongside the existing gauntlet, behind a feature flag, storing results for comparison without affecting the publish decision.

---

## Context and Alignment

From the PR #191 discussion, the agreed plan is:

> - rebase on main, skipping dropping the gauntlet
> - run gauntlet and Cisco in parallel
> - update the UI to show both results
> - cherry-pick the tests from arXiv

This strategy implements that plan as a series of small, incremental PRs. The gauntlet remains the sole decision-maker. The Cisco scanner runs in parallel for data collection and comparison. A feature flag controls whether the scanner runs at all.

---

## Design Principles

1. **Gauntlet stays in control** — the scanner never affects publish/reject decisions
2. **Additive only** — no tables dropped, no code paths removed
3. **Feature-flagged** — scanner can be toggled per environment via settings
4. **Thread-safe** — no global state mutation (no stdout capture hacks)
5. **Fail-open for the scanner** — scanner errors never block publishing
6. **Incremental delivery** — each PR is independently reviewable and deployable

---

## Phase 1: Data Model + Feature Flag

**PR scope**: ~200 lines, no behavioral changes

### 1a. Feature Flag in Settings

Add to `server/src/decision_hub/settings.py`:

```python
# Cisco skill-scanner (parallel mode — does not affect publish decisions)
enable_cisco_scanner: bool = False
cisco_scanner_policy: str = "balanced"  # "strict" | "balanced" | "permissive"
```

The flag defaults to `False` so it has zero impact until explicitly enabled in `.env.dev`. Production stays off until confidence is established.

### 1b. Database Migration: `scan_reports` + `scan_findings`

Create `server/migrations/YYYYMMDD_HHMMSS_create_scan_tables.sql`:

```sql
CREATE TABLE IF NOT EXISTS scan_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version_id UUID REFERENCES skill_versions(id) ON DELETE CASCADE,
    org_slug TEXT NOT NULL,
    skill_name TEXT NOT NULL,
    semver TEXT NOT NULL,
    -- Scanner output
    is_safe BOOLEAN NOT NULL,
    max_severity TEXT NOT NULL,
    grade TEXT NOT NULL,                    -- A/B/C/F mapped from severity
    findings_count INTEGER NOT NULL DEFAULT 0,
    analyzers_used TEXT[] NOT NULL DEFAULT '{}',
    analyzability_score REAL,
    scan_duration_ms INTEGER,
    policy_name TEXT,
    policy_fingerprint TEXT,
    scanner_version TEXT,
    scanner_model TEXT,
    -- Full report blob
    full_report JSONB,
    meta_analysis JSONB,
    -- Timestamps
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scan_reports_version ON scan_reports(version_id);
CREATE INDEX IF NOT EXISTS idx_scan_reports_skill ON scan_reports(org_slug, skill_name);

ALTER TABLE scan_reports ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS scan_findings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id UUID NOT NULL REFERENCES scan_reports(id) ON DELETE CASCADE,
    rule_id TEXT NOT NULL,
    category TEXT NOT NULL,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    file_path TEXT,
    line_number INTEGER,
    snippet TEXT,
    remediation TEXT,
    analyzer TEXT,
    aitech_code TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scan_findings_report ON scan_findings(report_id);
CREATE INDEX IF NOT EXISTS idx_scan_findings_severity ON scan_findings(severity);

ALTER TABLE scan_findings ENABLE ROW LEVEL SECURITY;

-- updated_at trigger for scan_reports (scan_findings is immutable)
CREATE TRIGGER set_scan_reports_updated_at
    BEFORE UPDATE ON scan_reports
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

### 1c. SQLAlchemy Table Definitions

Add to `database.py` alongside existing `eval_audit_logs_table`:

```python
scan_reports_table = Table(
    "scan_reports",
    metadata,
    Column("id", UUID, primary_key=True, server_default=sa.text("gen_random_uuid()")),
    Column("version_id", UUID, ForeignKey("skill_versions.id", ondelete="CASCADE")),
    Column("org_slug", String, nullable=False),
    Column("skill_name", String, nullable=False),
    Column("semver", String, nullable=False),
    Column("is_safe", Boolean, nullable=False),
    Column("max_severity", String, nullable=False),
    Column("grade", String, nullable=False),
    Column("findings_count", Integer, nullable=False, server_default="0"),
    Column("analyzers_used", ARRAY(String), nullable=False, server_default="{}"),
    Column("analyzability_score", Float),
    Column("scan_duration_ms", Integer),
    Column("policy_name", String),
    Column("policy_fingerprint", String),
    Column("scanner_version", String),
    Column("scanner_model", String),
    Column("full_report", JSONB),
    Column("meta_analysis", JSONB),
    Column("created_at", DateTime(timezone=True), server_default=sa.text("now()")),
    Column("updated_at", DateTime(timezone=True), server_default=sa.text("now()")),
)

scan_findings_table = Table(
    "scan_findings",
    metadata,
    Column("id", UUID, primary_key=True, server_default=sa.text("gen_random_uuid()")),
    Column("report_id", UUID, ForeignKey("scan_reports.id", ondelete="CASCADE"), nullable=False),
    Column("rule_id", String, nullable=False),
    Column("category", String, nullable=False),
    Column("severity", String, nullable=False),
    Column("title", String, nullable=False),
    Column("description", String),
    Column("file_path", String),
    Column("line_number", Integer),
    Column("snippet", String),
    Column("remediation", String),
    Column("analyzer", String),
    Column("aitech_code", String),
    Column("metadata_", JSONB, server_default="{}"),
    Column("created_at", DateTime(timezone=True), server_default=sa.text("now()")),
)
```

### 1d. Pydantic Models

Add to `models.py`:

```python
@dataclass(frozen=True)
class ScanReport:
    id: UUID
    version_id: UUID | None
    org_slug: str
    skill_name: str
    semver: str
    is_safe: bool
    max_severity: str
    grade: str
    findings_count: int
    analyzers_used: list[str]
    analyzability_score: float | None
    scan_duration_ms: int | None
    policy_name: str | None
    scanner_version: str | None
    scanner_model: str | None
    created_at: datetime

@dataclass(frozen=True)
class ScanFinding:
    id: UUID
    report_id: UUID
    rule_id: str
    category: str
    severity: str
    title: str
    description: str | None
    file_path: str | None
    line_number: int | None
    analyzer: str | None
```

---

## Phase 2: Scanner Bridge (Simplified)

**PR scope**: ~300 lines — the bridge module without any monkey patches

### 2a. `server/src/decision_hub/domain/skill_scanner_bridge.py`

A clean rewrite using the 2.0.3 API:

```python
"""Adapter between cisco-ai-skill-scanner and dhub's publish pipeline.

Runs the Cisco scanner and maps results to dhub's data model.
No monkey patches — requires cisco-ai-skill-scanner >= 2.0.0.
"""

@dataclass(frozen=True)
class BridgeScanResult:
    """Normalized scan result returned by the bridge to callers."""
    is_safe: bool
    max_severity: str
    grade: SafetyGrade
    findings_count: int
    findings: list[dict]
    analyzers_used: list[str]
    analyzers_failed: list[dict]
    analyzability_score: float | None
    scan_duration_ms: int
    policy_name: str | None
    policy_fingerprint: str | None
    full_report: dict
    meta_analysis: dict | None
    scanner_version: str | None
    scanner_model: str | None
    llm_degraded: bool


def scan_skill_zip(zip_bytes: bytes, settings: Settings) -> BridgeScanResult:
    """Extract zip, scan, and return normalized result.

    Uses the analyzer factory from 2.0.x — no manual analyzer construction.
    Scanner errors are caught and returned as fail-closed results.
    """
    ...
```

Key design changes from PR #191:
- **No monkey patches** — all upstream bugs are fixed
- **No `_capture_stdout_during`** — check `analyzers_failed` and `LLM_ANALYSIS_FAILED` findings instead
- **Use `build_analyzers()` factory** — pass policy, LLM config; the factory handles the rest
- **Use `ScanPolicy.from_preset()`** — configurable via `settings.cisco_scanner_policy`
- **Thread-safe** — no global state mutation
- **Typed `settings: Settings`** — no `getattr` hacks

### 2b. Grade Mapping

Same logic as PR #191, proven correct:

```python
_SEVERITY_TO_GRADE: dict[str, SafetyGrade] = {
    "CRITICAL": "F",
    "HIGH": "F",
    "MEDIUM": "C",
    "LOW": "A",
    "INFO": "A",
    "SAFE": "A",
}
```

With `_effective_max_severity()` to recompute after excluding meta-analysis false positives.

### 2c. MetaAnalyzer Orchestration

The MetaAnalyzer is still a post-processing step. The bridge calls it explicitly after `scan_skill()`:

```python
if settings.google_api_key and result.findings:
    meta = MetaAnalyzer(
        model=f"gemini/{settings.gemini_model}",
        api_key=settings.google_api_key,
        max_tokens=32768,
        policy=policy,
    )
    meta_result = await meta.analyze_with_findings(
        skill=skill, findings=result.findings, analyzers_used=result.analyzers_used
    )
    enriched = apply_meta_analysis_to_results(
        original_findings=result.findings, meta_result=meta_result, skill=skill
    )
```

### 2d. Dependency Addition

Add to `server/pyproject.toml`:

```toml
# Cisco scanner runs in parallel with the gauntlet (feature-flagged).
# Minimum 2.0.0 required — fixes for Gemini schema, dict compat, and
# LLM error surfacing are all included.
"cisco-ai-skill-scanner>=2.0.0",
```

No pin needed — the monkey patches that required pinning are gone.

---

## Phase 3: Pipeline Integration

**PR scope**: ~100 lines — wire scanner into `execute_publish`

### 3a. Parallel Execution in `publish_pipeline.py`

Add scanner invocation inside `execute_publish()`, after the gauntlet but before the grade decision:

```python
# 3. Run gauntlet security pipeline (decides publish/reject)
report, check_results_dicts, llm_reasoning = run_gauntlet_pipeline(...)

# 3b. Run Cisco scanner in parallel (observational only)
scan_result: BridgeScanResult | None = None
if settings.enable_cisco_scanner:
    try:
        scan_result = scan_skill_zip(file_bytes, settings)
        logger.info(
            "Cisco scan for {}/{} v{}: grade={} findings={} duration={}ms",
            org_slug, skill_name, version,
            scan_result.grade, scan_result.findings_count, scan_result.scan_duration_ms,
        )
    except Exception:
        logger.opt(exception=True).warning(
            "Cisco scanner failed for {}/{} — continuing with gauntlet result only",
            org_slug, skill_name,
        )

# 4. Quarantine if rejected (gauntlet grade only — scanner doesn't affect this)
if not report.passed:
    ...
```

### 3b. Store Scan Report After Publish

After the version is committed (step 9–11), store the scan report:

```python
# 11b. Store Cisco scan report (non-critical, fail-open)
if scan_result is not None:
    try:
        insert_scan_report(conn, version_id=version_record.id, scan_result=scan_result,
                          org_slug=org_slug, skill_name=skill_name, semver=version)
        conn.commit()
    except Exception:
        logger.opt(exception=True).warning(
            "Failed to store scan report for {}/{} — scan data lost but publish succeeded",
            org_slug, skill_name,
        )
```

### 3c. Handle F-Graded Skills (Quarantined)

For quarantined skills (gauntlet grade F), store the scan report with `version_id=None`:

```python
if not report.passed:
    # Store scan report even for rejected skills (useful for comparison analysis)
    if scan_result is not None:
        try:
            insert_scan_report(conn, version_id=None, scan_result=scan_result,
                              org_slug=org_slug, skill_name=skill_name, semver=version)
            conn.commit()
        except Exception:
            logger.opt(exception=True).warning("Failed to store scan report for rejected {}/{}", org_slug, skill_name)
    quarantine_and_log_rejection(...)
    raise GauntletRejectionError(report.summary)
```

---

## Phase 4: API Endpoints + Frontend

**PR scope**: ~200 lines backend, ~300 lines frontend

### 4a. Scan Report API Endpoints

Add to `registry_routes.py`:

```
GET /v1/skills/{org}/{skill}/scan-report?version={semver}
    → Returns latest scan report with findings for the version

GET /v1/skills/{org}/{skill}/scan-report/{report_id}/full
    → Returns the full JSONB report blob
```

With rate limiting following the existing `audit_log_rate_limit` pattern. Add corresponding settings:

```python
scan_report_rate_limit: int = 30
scan_report_rate_window: int = 60
```

### 4b. Frontend Feature Flag

Add to `frontend/src/featureFlags.ts`:

```typescript
/** When true, show Cisco scanner results alongside gauntlet audit data. */
export const SHOW_SCANNER_RESULTS = false;
```

### 4c. Frontend UI

On the skill detail page, add a "Scanner Report" section (gated behind `SHOW_SCANNER_RESULTS`) below the existing audit log:

- Severity badge (A/B/C/F with color)
- Finding count by severity
- Expandable findings list (rule_id, title, severity, file path, snippet)
- Analyzability score indicator
- "View Full Report" expandable JSON viewer
- Scanner vs gauntlet grade comparison badge

---

## Phase 5: arXiv Test Suite

**PR scope**: Cherry-pick and adapt from PR #194

The arXiv test suite from PR #194 / #197 has 31 malicious skill test cases + 31 evaded variants. These should be:

1. Cherry-picked from the `cursor/arxiv-test-set-gauntlet-eb6f` branch
2. Adapted to run against both the gauntlet and the scanner
3. Added as a non-CI benchmark (too slow for every PR — requires LLM calls)

Structure:
```
server/tests/benchmarks/
    arxiv_test_cases/        # 31 original + 31 evaded skill zips
    test_arxiv_gauntlet.py   # gauntlet benchmark
    test_arxiv_scanner.py    # scanner benchmark
    conftest.py              # shared fixtures
```

Run via: `make benchmark-arxiv` (not in CI — requires API keys and takes ~20min)

---

## Phase 6: Backfill + Analysis

**Not a PR — operational task**

Once the scanner is running in production (dev), run a backfill on existing skills:

```bash
cd server && DHUB_ENV=dev uv run --package decision-hub-server \
    python -m decision_hub.scripts.backfill_scan_reports --workers 4 --resume
```

Then compare scanner vs gauntlet grades across the catalog to establish confidence:

| Metric | Target |
|--------|--------|
| Scanner F-rate on trusted publishers | < 10% (vs 26% in PR #191 era with 1.0.2) |
| Scanner agreement with gauntlet on F-grades | > 90% |
| Scanner catches that gauntlet misses | Track for value assessment |
| Scanner FPs that gauntlet correctly passes | Track for calibration |

---

## Phase 7: Decision Layer Migration (Future)

Once confidence is established (Phase 6 data looks good):

1. Add a `scanner_grade` column to the version response
2. Update the decision layer to consider both grades
3. Optionally: make the scanner the primary decision-maker with gauntlet as fallback
4. Optionally: drop the gauntlet once the scanner is proven reliable

This phase is explicitly **out of scope** for now. The goal is data collection, not replacement.

---

## Execution Order and Dependencies

```
Phase 1 (data model + flag)     ← can merge independently
    ↓
Phase 2 (bridge module)         ← depends on Phase 1 for models
    ↓
Phase 3 (pipeline integration)  ← depends on Phase 2
    ↓
Phase 4 (API + frontend)        ← depends on Phases 1 + 3
    ↓
Phase 5 (arXiv tests)           ← independent, can merge anytime
    ↓
Phase 6 (backfill + analysis)   ← operational, after Phase 3 deployed
    ↓
Phase 7 (decision migration)    ← future, data-driven decision
```

Phases 1 and 5 can proceed in parallel. Phases 2–4 are sequential but small enough for quick review.

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Scanner adds latency to publish | Wrapped in try/except with timeout; failure doesn't block publish |
| Scanner dependency increases container size | Monitor Modal image size; scanner is pure Python, should be manageable |
| Scanner LLM calls double Gemini API costs | Feature flag defaults to off; enable only on dev initially |
| Scanner FP rate still too high | Policy engine allows per-environment tuning; `permissive` preset as fallback |
| Scanner API changes break bridge | Pin minimum version `>=2.0.0`; bridge uses stable public API only |
| Thread safety in crawler | No global state mutation; each scan is isolated |

---

## What's Reusable from PR #191

| Component | Reusable? | Notes |
|-----------|-----------|-------|
| `BridgeScanResult` dataclass | Yes | Same shape, minor field additions (`analyzers_failed`, `llm_degraded`) |
| `severity_to_grade` mapping | Yes | Unchanged |
| `_effective_max_severity` | Yes | Unchanged |
| `_map_scan_result` | Partially | Needs update for 2.0.3 `ScanResult` shape |
| `_error_scan_result` | Yes | Unchanged |
| `_safe_extract_zip` | Yes | Unchanged |
| `_find_skill_root` | Yes | Unchanged |
| `scan_reports` migration | Mostly | Add `analyzers_failed` column |
| `scan_findings` migration | Yes | Unchanged |
| Bridge tests | Partially | Remove monkey-patch tests; keep mapping/grade tests |
| `_fix_gemini_union_types` | No | Upstream fixed |
| `_patch_gemini_schema_sanitizer` | No | Upstream fixed |
| `_patch_dict_compatibility_crash` | No | Upstream fixed |
| `_capture_stdout_during` | No | Replaced by structured error detection |
| `_check_llm_degradation` | No | Replaced by `analyzers_failed` check |
| `_build_analyzers` (manual) | No | Use `build_analyzers()` factory |

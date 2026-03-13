# Implementation Strategy: Parallel Cisco Scanner Integration (Revised)

**Date**: 2026-03-13 (revised)

---

## Context

From the PR #191 discussion, the agreed plan is:

> - rebase on main, skipping dropping the gauntlet
> - run gauntlet and Cisco in parallel
> - update the UI to show both results
> - cherry-pick the tests from arXiv

This is a **clean-slate implementation**. Nothing from the PR #191 branch is being rebased or cherry-picked as code — the old branch is reference material only. The gauntlet remains the sole decision-maker for publish/reject. The Cisco scanner runs in parallel for data collection, and its results are stored and displayed alongside the gauntlet's letter grade.

---

## Design Principles

1. **Gauntlet stays in control** — scanner never affects publish/reject decisions
2. **Additive only** — new tables created fresh, existing tables untouched
3. **Feature-flagged** — `enable_cisco_scanner` in settings, defaults to `False`
4. **Thread-safe** — no global state mutation; each scan call is self-contained
5. **Fail-open for the scanner** — scanner errors never block publishing
6. **Comprehensive scan** — use all available analyzers (static, behavioral, pipeline, bytecode, trigger, LLM, meta-analysis) to maximize the value of the data we collect
7. **Native output** — store and display scanner results in their own format, not mapped to gauntlet concepts

---

## Comprehensive Scanner Configuration

The scanner in 2.0.3 has a rich set of analyzers. For maximum data value, we should run the full pipeline:

### Analyzers to Enable

| Analyzer | Flag | What it does | Cost |
|----------|------|-------------|------|
| **Static** | Always on | 13-pass static analysis: YARA rules, regex signatures, manifest validation, homoglyphs, prompt injection in assets | Free (CPU only) |
| **Bytecode** | Always on | `.pyc` without `.py` source, AST mismatch detection | Free |
| **Pipeline** | Always on | Shell taint flow tracking (source → sink) | Free |
| **Behavioral** | `use_behavioral=True` | AST dataflow analysis, import graph, capability mapping | Free |
| **Trigger** | `use_trigger=True` | Description specificity analysis (overly generic → suspicious) | Free |
| **LLM** | `use_llm=True` | Semantic analysis via Gemini | ~1 LLM call per skill |
| **Meta-analysis** | Post-processing | Cross-validates findings, filters FPs, correlation groups | ~1 LLM call per skill |

All free analyzers should always run. The LLM analyzer and meta-analysis should run when `google_api_key` is available (which it always is in dev/prod). This gives us the full 2-phase pipeline: deterministic engines first, then LLM enriched with Phase 1 context.

### Policy Selection

Use `balanced` as the default policy. This can be overridden via `cisco_scanner_policy` in settings. The policy engine is one of 2.0's best features — it directly addresses the false-positive problem from the 1.0.2 era. If the backfill shows too many false positives, we can switch to `permissive` without code changes.

### Bridge Configuration Code (Sketch)

```python
from skill_scanner.core.analyzer_factory import build_analyzers
from skill_scanner.core.scan_policy import ScanPolicy

policy = ScanPolicy.from_preset(settings.cisco_scanner_policy)

analyzers = build_analyzers(
    policy,
    use_behavioral=True,
    use_llm=bool(settings.google_api_key),
    llm_model=f"gemini/{settings.gemini_model}",
    llm_api_key=settings.google_api_key,
    use_trigger=True,
)

scanner = SkillScanner(analyzers=analyzers, policy=policy)
result = scanner.scan_skill(skill_dir)

# Meta-analysis as post-processing (if LLM available and findings exist)
if settings.google_api_key and result.findings:
    meta = MetaAnalyzer(
        model=f"gemini/{settings.gemini_model}",
        api_key=settings.google_api_key,
        policy=policy,
    )
    meta_result = await meta.analyze_with_findings(
        skill=skill, findings=result.findings, analyzers_used=result.analyzers_used,
    )
    result.findings = apply_meta_analysis_to_results(
        original_findings=result.findings, meta_result=meta_result, skill=skill,
    )
```

This is the equivalent of `skill-scanner scan /path --use-behavioral --use-llm --use-trigger --enable-meta --policy balanced`.

---

## Data Model

### Tables (created fresh — no relation to PR #191 migrations)

**`scan_reports`** — one row per scan execution:

```sql
CREATE TABLE IF NOT EXISTS scan_reports (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version_id      UUID REFERENCES skill_versions(id) ON DELETE CASCADE,
    org_slug        TEXT NOT NULL,
    skill_name      TEXT NOT NULL,
    semver          TEXT NOT NULL,

    -- Scanner verdict
    is_safe         BOOLEAN NOT NULL,
    max_severity    TEXT NOT NULL,       -- CRITICAL / HIGH / MEDIUM / LOW / INFO / SAFE
    findings_count  INTEGER NOT NULL DEFAULT 0,

    -- Analyzer metadata
    analyzers_used  TEXT[] NOT NULL DEFAULT '{}',
    analyzers_failed JSONB DEFAULT '[]',
    analyzability_score REAL,

    -- Scan config
    scanner_version TEXT,
    scanner_model   TEXT,               -- e.g. "gemini/gemini-3.1-flash-lite-preview"
    policy_name     TEXT,               -- e.g. "balanced"
    scan_duration_ms INTEGER,

    -- Full blobs
    full_report     JSONB,              -- ScanResult.to_dict()
    meta_analysis   JSONB,              -- MetaAnalysisResult.to_dict() if meta ran

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Note what's **not** here compared to PR #191: no `grade` column, no `policy_fingerprint`. The scanner doesn't produce letter grades — that's a gauntlet concept. We store the scanner's native output (`max_severity`, `is_safe`) and let the UI present it directly. If we later want to derive a letter grade, we can compute it at display time.

**`scan_findings`** — denormalized findings for querying:

```sql
CREATE TABLE IF NOT EXISTS scan_findings (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id   UUID NOT NULL REFERENCES scan_reports(id) ON DELETE CASCADE,
    rule_id     TEXT NOT NULL,
    category    TEXT NOT NULL,           -- ThreatCategory enum value
    severity    TEXT NOT NULL,           -- Severity enum value
    title       TEXT NOT NULL,
    description TEXT,
    file_path   TEXT,
    line_number INTEGER,
    snippet     TEXT,
    remediation TEXT,
    analyzer    TEXT,                    -- which analyzer produced this
    metadata    JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Both tables get RLS enabled, standard indexes on `version_id` / `report_id` / `severity`, and the `set_updated_at` trigger on `scan_reports`.

### What We Don't Need

- **No `grade` column** — the scanner speaks in severities, not letter grades
- **No `policy_fingerprint`** — the policy name is sufficient for traceability
- **No separate `BridgeScanResult` dataclass** — we can work directly with the scanner's `ScanResult` and store `result.to_dict()` as the `full_report` blob. The bridge maps to the DB insert, not to an intermediate representation
- **No `_scan_result_to_audit_fields` cross-module import** — the bridge writes directly to `scan_reports`

---

## Incremental Testing Plan

### Why the Old Backfill Parameters Need Revisiting

The PR #191 backfill used `--limit 100 --workers 20`. That was with scanner 1.0.2 which ran 4 analyzers (static, behavioral, trigger, LLM). With 2.0.3 we're running 5 core analyzers + LLM + meta-analysis — roughly double the work per skill, with two LLM calls instead of one.

The old approach also had `_capture_stdout_during()` which was not thread-safe. That's gone now, but the LLM calls themselves share a rate limit on the Gemini API. Too many concurrent workers will hit rate limits and cause retries.

### Recommended Testing Sequence

**Step 0: Smoke test (1 skill, no LLM)**

Before any bulk run, verify the bridge works end-to-end with a single skill and only free analyzers (no Gemini calls):

```bash
cd server && DHUB_ENV=dev uv run --package decision-hub-server \
    python -c "
from decision_hub.domain.skill_scanner_bridge import scan_skill_zip
from decision_hub.settings import create_settings
settings = create_settings()
settings.enable_cisco_scanner = True
# Test with a known skill zip from S3...
"
```

This validates: dependency installs correctly, bridge imports work, scanner loads rules/packs, result mapping is correct.

**Step 1: Single skill with full LLM pipeline**

Run one skill through the complete pipeline (all analyzers + meta-analysis) to verify Gemini integration:

```bash
cd server && DHUB_ENV=dev uv run --package decision-hub-server \
    python -m decision_hub.scripts.backfill_scan_reports --limit 1 --workers 1
```

Check: scan completes, findings are reasonable, meta-analysis runs, report stores correctly, no errors in logs.

**Step 2: Small batch (10 skills, 2 workers)**

```bash
cd server && DHUB_ENV=dev uv run --package decision-hub-server \
    python -m decision_hub.scripts.backfill_scan_reports --limit 10 --workers 2
```

Check: no rate limit errors, no thread-safety issues, scan times are reasonable (expect 30-60s per skill with LLM), grade distribution looks sane.

**Step 3: Medium batch (100 skills, 4 workers)**

```bash
cd server && DHUB_ENV=dev uv run --package decision-hub-server \
    python -m decision_hub.scripts.backfill_scan_reports --limit 100 --workers 4
```

This is where we validate at scale. Key metrics to check:
- **Severity distribution**: what % of skills get CRITICAL/HIGH findings?
- **Comparison with gauntlet**: how often do scanner and gauntlet agree on "problematic" vs "clean"?
- **LLM reliability**: how many scans had `analyzers_failed` entries for `llm_analyzer`?
- **Scan duration**: median/p90/p99 per skill
- **Gemini rate limits**: any 429 errors in logs?

At 4 workers with 2 LLM calls each (LLM analyzer + meta), that's ~8 concurrent Gemini requests. With gemini-3.1-flash-lite-preview, this should be well within rate limits. If we see 429s, reduce to 2 workers.

**Step 4: Full catalog**

```bash
cd server && DHUB_ENV=dev uv run --package decision-hub-server \
    python -m decision_hub.scripts.backfill_scan_reports --workers 4 --resume
```

The `--resume` flag skips skills that already have a scan report (LEFT JOIN IS NULL pattern). This makes the backfill restartable after crashes or interruptions.

### Backfill Script Design

The new backfill follows the same pattern as the old one (from PR #191) but simplified:

1. Query skills whose latest version has no `scan_report` row
2. Download zip from S3
3. Run scanner (in worker thread)
4. Insert `scan_report` + `scan_findings` rows (in main thread, batched)
5. Circuit breaker on N consecutive errors

Key differences from the old backfill:
- No `_capture_stdout_during` — thread-safe by default
- Uses `build_analyzers()` factory — not manual analyzer construction
- Stores `result.to_dict()` directly as `full_report` — no intermediate mapping
- `--delay` parameter for throttling Gemini requests if needed

---

## UI Presentation

### Design Philosophy

The gauntlet and scanner serve different purposes and speak different languages. The gauntlet produces a letter grade (A/B/C/F) based on specific checks (manifest validation, credential scanning, prompt injection, etc.). The scanner produces a severity verdict (CRITICAL/HIGH/MEDIUM/LOW/INFO/SAFE) based on structured findings from multiple analyzers.

Rather than trying to unify them into one view, we present each in its native format:

- **Gauntlet**: letter grade badge + check results grid (existing UI, unchanged)
- **Scanner**: severity-based findings view (new section on the Audit tab)

### Audit Tab Layout (Revised)

Currently the Audit tab shows a flat list of `AuditLogEntry` cards. Each card has a grade badge, version, publisher, date, and a "Safety Checks" grid.

The revised layout adds a "Scanner Report" section below each audit entry, gated behind a feature flag:

```
┌─────────────────────────────────────────────────────┐
│  Audit Log                                          │
│                                                     │
│  ┌───────────────────────────────────────────────┐  │
│  │ ● A  v1.2.3  by user  2026-03-13             │  │
│  │                                               │  │
│  │ Safety Checks (gauntlet — existing)           │  │
│  │ ┌──────────┐ ┌──────────┐ ┌──────────┐       │  │
│  │ │ ✓ Manifest│ │ ✓ Safety │ │ ✓ Prompt │       │  │
│  │ │  schema  │ │   scan   │ │  safety  │       │  │
│  │ └──────────┘ └──────────┘ └──────────┘       │  │
│  │                                               │  │
│  │ Scanner Report (new — when available)         │  │
│  │ ┌─────────────────────────────────────────┐   │  │
│  │ │ Verdict: SAFE  │ 3 findings │ 94% score │   │  │
│  │ ├─────────────────────────────────────────┤   │  │
│  │ │ ▸ MEDIUM  Overly broad description      │   │  │
│  │ │   static_analyzer · prompt_injection     │   │  │
│  │ │                                          │   │  │
│  │ │ ▸ LOW  Undeclared network capability     │   │  │
│  │ │   behavioral · unauthorized_tool_use     │   │  │
│  │ │                                          │   │  │
│  │ │ ▸ INFO  LLM context budget exceeded      │   │  │
│  │ │   meta_analyzer · policy_violation       │   │  │
│  │ ├─────────────────────────────────────────┤   │  │
│  │ │ Analyzers: static, behavioral, pipeline, │   │  │
│  │ │ bytecode, trigger, llm, meta             │   │  │
│  │ │ Policy: balanced │ Duration: 34s         │   │  │
│  │ │ Scanner v2.0.3 │ Model: gemini/3.1-...  │   │  │
│  │ └─────────────────────────────────────────┘   │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### Scanner Report Component

The scanner report section shows:

1. **Summary bar**: max severity badge (color-coded), finding count, analyzability score (as a percentage bar or number)
2. **Findings list**: expandable, sorted by severity. Each finding shows:
   - Severity badge (CRITICAL=red, HIGH=orange, MEDIUM=yellow, LOW=blue, INFO=gray)
   - Title
   - Analyzer name + threat category (as small labels)
   - Expandable: description, file path + line number, code snippet, remediation
3. **Metadata footer**: analyzers used, policy name, scan duration, scanner version, model

### Severity Color Mapping

Use the existing severity color pattern from `CheckResultsGrid` but adapted for the scanner's 6-level scale:

| Severity | Color | CSS variable |
|----------|-------|-------------|
| CRITICAL | Red (`#ff4757`) | `severityCritical` |
| HIGH | Orange (`#ff6b35`) | `severityHigh` |
| MEDIUM | Yellow (`#ffa502`) | `severityMedium` |
| LOW | Blue (`#3742fa`) | `severityLow` |
| INFO | Gray (`#747d8c`) | `severityInfo` |
| SAFE | Green (`#2ed573`) | `severitySafe` |

### Feature Flag

```typescript
// frontend/src/featureFlags.ts
export const SHOW_SCANNER_REPORT = false;
```

The scanner report section is only rendered when `SHOW_SCANNER_REPORT` is `true` AND the API returns scan data for the version. This means:
- Production: off until we're confident
- Dev: enable when ready to test

### TypeScript Types

```typescript
// frontend/src/types/api.ts

export interface ScanFinding {
  rule_id: string;
  category: string;
  severity: string;
  title: string;
  description: string | null;
  file_path: string | null;
  line_number: number | null;
  snippet: string | null;
  remediation: string | null;
  analyzer: string | null;
  metadata: Record<string, unknown>;
}

export interface ScanReport {
  id: string;
  version_id: string | null;
  is_safe: boolean;
  max_severity: string;
  findings_count: number;
  findings: ScanFinding[];
  analyzers_used: string[];
  analyzers_failed: { analyzer: string; error: string }[];
  analyzability_score: number | null;
  scanner_version: string | null;
  scanner_model: string | null;
  policy_name: string | null;
  scan_duration_ms: number | null;
  created_at: string;
}
```

### API Endpoint

```
GET /v1/skills/{org}/{skill}/scan-report?version={semver}
```

Returns the latest `ScanReport` for the given version, with findings included inline (no separate findings endpoint needed — findings are part of the report). The `full_report` JSONB blob is NOT returned by default (it's large); a separate endpoint can serve it if needed.

---

## Implementation Phases

### Phase 1: Foundation (~200 lines)

**One PR. No behavioral changes.**

- [ ] Feature flag: `enable_cisco_scanner: bool = False` and `cisco_scanner_policy: str = "balanced"` in `settings.py`
- [ ] SQL migration: `scan_reports` + `scan_findings` tables (created fresh)
- [ ] SQLAlchemy table definitions in `database.py`
- [ ] DB helper functions: `insert_scan_report()`, `insert_scan_findings()`, `find_scan_report_for_version()`
- [ ] Pydantic models in `models.py`
- [ ] `cisco-ai-skill-scanner>=2.0.0` dependency in `server/pyproject.toml`

### Phase 2: Bridge + Pipeline Integration (~300 lines)

**One PR. Scanner runs in parallel but results are only logged, not stored yet if you want to split further — but storing is simple enough to include.**

- [ ] `server/src/decision_hub/domain/skill_scanner_bridge.py` — clean implementation using `build_analyzers()` factory and `ScanPolicy.from_preset()`
- [ ] Hook into `execute_publish()` in `publish_pipeline.py`: run scanner after gauntlet, store result, never affect the publish decision
- [ ] Backfill script: `server/src/decision_hub/scripts/backfill_scan_reports.py`
- [ ] Makefile target: `backfill-scan-reports`
- [ ] Tests: bridge unit tests (result mapping, error handling, LLM degradation detection via `analyzers_failed`)

### Phase 3: API + Frontend (~400 lines)

**One PR. Purely additive UI.**

- [ ] `GET /v1/skills/{org}/{skill}/scan-report` endpoint with rate limiting
- [ ] Frontend feature flag: `SHOW_SCANNER_REPORT` in `featureFlags.ts`
- [ ] `ScannerReport` component on the Audit tab
- [ ] TypeScript types for `ScanReport` / `ScanFinding`
- [ ] Responsive styles following mobile-first pattern

### Phase 4: arXiv Benchmark Suite

**One PR. Independent of Phases 1-3.**

- [ ] Cherry-pick test cases from PR #194 branch (`cursor/arxiv-test-set-gauntlet-eb6f`)
- [ ] Adapt to run against both gauntlet and scanner
- [ ] `make benchmark-arxiv` target (not in CI)

### Phase 5: Backfill + Analysis (Operational)

**Not a PR — operational work after Phase 2 is deployed to dev.**

- [ ] Step 0-4 testing sequence as described above
- [ ] Full catalog backfill
- [ ] Write up comparison analysis: scanner vs gauntlet agreement, false positive rates, new findings caught

---

## What We're Deliberately NOT Doing

These are conscious decisions to keep the scope manageable:

1. **No letter grade for scanner** — the scanner speaks in severities. A grade mapping can be added later if wanted, but it's not the scanner's native language.
2. **No `BridgeScanResult` intermediate dataclass** — the scanner's `ScanResult.to_dict()` is the canonical format. The bridge maps directly from scanner output to DB insert.
3. **No gauntlet removal** — the gauntlet is the decision-maker. Period.
4. **No `eval_audit_logs` changes** — the existing audit log stays as-is. Scan reports are a parallel data stream.
5. **No scanner grade in version resolution** — `resolve_version` still uses `eval_status` (gauntlet grade). Scanner data is display-only.
6. **No stdout capture** — the scanner's structured error reporting (`analyzers_failed`, `LLM_ANALYSIS_FAILED` findings) replaces the old hack.
7. **No monkey patches** — all upstream issues are fixed in 2.0.0+.
8. **No cross-skill scanning** — the scanner supports multi-skill batch scanning with cross-skill findings, but we scan one skill at a time (matching the publish pipeline's granularity).

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Scanner adds latency to publish | Wrapped in try/except; failure = warning log + no scan data stored. Consider running async/in background if latency is a problem. |
| Scanner dependency bloats container | Monitor Modal image size. Scanner is mostly pure Python; YARA rules are small. Magika model (~1MB) is the largest addition. |
| Gemini rate limits from double LLM usage | Scanner + gauntlet both call Gemini. Monitor 429 rates. If problematic, scanner can use a different model or skip LLM. |
| False positive rate still too high | Policy engine is the escape valve. Switch to `permissive` preset or create a custom policy YAML. |
| Scanner API breaks in future versions | Pin `>=2.0.0,<3.0.0`. The bridge uses only the public API (`SkillScanner`, `build_analyzers`, `ScanPolicy`, `MetaAnalyzer`). |

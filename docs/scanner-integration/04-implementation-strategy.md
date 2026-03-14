# Implementation Strategy: Parallel Cisco Scanner Integration (v3)

**Date**: 2026-03-13 (v3)

---

## Context

From the PR #191 discussion, the agreed plan is:

> - rebase on main, skipping dropping the gauntlet
> - run gauntlet and Cisco in parallel
> - update the UI to show both results
> - cherry-pick the tests from arXiv

This is a **clean-slate, single-PR implementation**. The gauntlet remains the sole decision-maker for publish/reject. The scanner runs alongside it, and its native results (findings, meta-analysis verdict, risk assessment, correlations, recommendations) are stored and displayed in the UI next to the gauntlet's letter grade.

---

## Database Cleanup

The PR #191 branch created `scan_reports` and `scan_findings` tables on the dev database during testing. These need to be dropped and recreated cleanly as part of our new migration.

The migration should:

```sql
-- Clean slate: drop any leftover tables from the PR #191 branch
DROP TABLE IF EXISTS scan_findings;
DROP TABLE IF EXISTS scan_reports;
```

This is safe because these tables only contain test data from the old branch's backfill runs, and were never exposed in production. The gauntlet's `eval_audit_logs` table is **not touched** — it stays exactly as-is.

---

## Scanner Output: Complete Data Model

The scanner produces a rich, multi-layered output. The previous drafts flattened this into a single "verdict". Here's the full picture of what the scanner actually produces and what we should store.

### Layer 1: ScanResult (from `scanner.scan_skill()`)

```python
@dataclass
class ScanResult:
    skill_name: str
    skill_directory: str
    findings: list[Finding]               # The core output
    scan_duration_seconds: float
    analyzers_used: list[str]             # e.g. ["static", "bytecode", "pipeline", "behavioral", "trigger", "llm"]
    analyzers_failed: list[dict[str, str]]  # e.g. [{"analyzer": "llm_analyzer", "error": "..."}]
    timestamp: datetime
    analyzability_score: float | None     # 0-100
    analyzability_details: dict | None    # {score, total_files, analyzed_files, risk_level, unanalyzable_file_list}
    scan_metadata: dict | None            # policy fingerprint, llm_overall_assessment, llm_primary_threats

    # Computed properties:
    is_safe: bool       # True if no CRITICAL/HIGH findings
    max_severity: Severity  # Highest severity across all findings
```

### Layer 2: Individual Findings

Each finding has:

```python
@dataclass
class Finding:
    id: str                    # Unique ID (rule_id + line + context hash)
    rule_id: str               # e.g. "COMMAND_INJECTION_SUBPROCESS", "LLM_ANALYSIS_FAILED"
    category: ThreatCategory   # e.g. "command_injection", "data_exfiltration", "prompt_injection"
    severity: Severity         # CRITICAL / HIGH / MEDIUM / LOW / INFO / SAFE
    title: str
    description: str
    file_path: str | None
    line_number: int | None
    snippet: str | None
    remediation: str | None
    analyzer: str | None       # "static", "llm", "behavioral", "pipeline", "meta_analyzer", etc.
    metadata: dict             # After meta-analysis, enriched with:
                               #   meta_false_positive: bool
                               #   meta_reason: str (if FP)
                               #   meta_validated: bool (if TP)
                               #   meta_confidence: "HIGH" | "MEDIUM" | "LOW"
                               #   meta_confidence_reason: str
                               #   meta_exploitability: str
                               #   meta_impact: str
                               #   meta_priority: int (rank in priority order)
```

### Layer 3: MetaAnalysisResult (from `meta.analyze_with_findings()`)

The meta-analyzer is a senior-analyst LLM pass that cross-validates findings from all other analyzers. It produces:

```python
@dataclass
class MetaAnalysisResult:
    validated_findings: list[dict]    # Confirmed true positives with confidence/exploitability/impact
    false_positives: list[dict]       # Findings identified as FPs with reasons
    missed_threats: list[dict]        # NEW threats the meta-analyzer found that others missed
    priority_order: list[int]         # Finding indices ordered by what to fix first
    correlations: list[dict]          # Groups of related findings (e.g. "Credential Theft Chain")
                                      #   Each: {group_name, finding_indices, relationship,
                                      #          combined_severity, consolidated_remediation}
    recommendations: list[dict]       # Actionable items (e.g. "Remove hardcoded credentials")
                                      #   Each: {priority, title, affected_findings, fix, effort}
    overall_risk_assessment: dict     # The "verdict":
                                      #   risk_level: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "SAFE"
                                      #   summary: str (one-sentence assessment)
                                      #   top_priority: str (single most important thing to fix)
                                      #   skill_verdict: "SAFE" | "SUSPICIOUS" | "MALICIOUS"
                                      #   verdict_reasoning: str
```

### Layer 4: LLM Analyzer's Own Assessment

The LLM analyzer (separate from meta) also produces a skill-level assessment captured in `scan_metadata`:

```python
scan_metadata = {
    "policy_name": "balanced",
    # ... policy fingerprint fields ...
    "llm_overall_assessment": "This skill appears safe. ...",
    "llm_primary_threats": ["prompt_injection", "data_exfiltration"],
}
```

### What This Means for the Data Model

The scanner doesn't have a single "verdict" — it has **four layers of signal**:

1. **`ScanResult.is_safe`** / **`ScanResult.max_severity`** — mechanical rollup (any CRITICAL/HIGH = unsafe)
2. **Per-finding metadata** — after meta-analysis, each finding has `meta_false_positive`, confidence, priority
3. **`MetaAnalysisResult.overall_risk_assessment`** — the LLM meta-analyst's expert opinion: `risk_level`, `skill_verdict` (SAFE/SUSPICIOUS/MALICIOUS), reasoning
4. **`MetaAnalysisResult.correlations`** + **`recommendations`** — the highest-value output: correlated attack chains and actionable fixes

All four layers should be stored and surfaceable in the UI.

---

## Database Schema

### `scan_reports`

```sql
CREATE TABLE IF NOT EXISTS scan_reports (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version_id          UUID REFERENCES skill_versions(id) ON DELETE CASCADE,
    org_slug            TEXT NOT NULL,
    skill_name          TEXT NOT NULL,
    semver              TEXT NOT NULL,

    -- Layer 1: ScanResult mechanical rollup
    is_safe             BOOLEAN NOT NULL,
    max_severity        TEXT NOT NULL,           -- CRITICAL/HIGH/MEDIUM/LOW/INFO/SAFE
    findings_count      INTEGER NOT NULL DEFAULT 0,

    -- Analyzer metadata
    analyzers_used      TEXT[] NOT NULL DEFAULT '{}',
    analyzers_failed    JSONB DEFAULT '[]',      -- [{analyzer, error}]

    -- Analyzability
    analyzability_score REAL,                    -- 0-100
    analyzability_details JSONB,                 -- {score, total_files, analyzed_files, risk_level, ...}

    -- Layer 3: Meta-analysis verdict (NULL if meta didn't run)
    meta_verdict        TEXT,                    -- SAFE / SUSPICIOUS / MALICIOUS
    meta_risk_level     TEXT,                    -- CRITICAL / HIGH / MEDIUM / LOW / SAFE
    meta_summary        TEXT,                    -- One-sentence expert assessment
    meta_top_priority   TEXT,                    -- Single most important fix

    -- Meta-analysis structured data
    meta_correlations   JSONB,                   -- Correlated finding groups
    meta_recommendations JSONB,                  -- Actionable fix items
    meta_false_positive_count INTEGER,           -- How many findings meta filtered as FP

    -- Scan configuration
    scanner_version     TEXT,
    scanner_model       TEXT,                    -- e.g. "gemini/gemini-3.1-flash-lite-preview"
    policy_name         TEXT,                    -- e.g. "balanced"
    scan_duration_ms    INTEGER,

    -- Full blobs (for download / deep inspection)
    full_report         JSONB,                   -- ScanResult.to_dict()
    meta_analysis       JSONB,                   -- MetaAnalysisResult.to_dict()
    scan_metadata       JSONB,                   -- policy fingerprint, llm_overall_assessment, etc.

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scan_reports_version ON scan_reports(version_id);
CREATE INDEX IF NOT EXISTS idx_scan_reports_skill ON scan_reports(org_slug, skill_name);

ALTER TABLE scan_reports ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER set_scan_reports_updated_at
    BEFORE UPDATE ON scan_reports
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

### `scan_findings`

```sql
CREATE TABLE IF NOT EXISTS scan_findings (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id       UUID NOT NULL REFERENCES scan_reports(id) ON DELETE CASCADE,

    -- Core finding fields
    rule_id         TEXT NOT NULL,
    category        TEXT NOT NULL,               -- ThreatCategory value
    severity        TEXT NOT NULL,               -- Severity value
    title           TEXT NOT NULL,
    description     TEXT,
    file_path       TEXT,
    line_number     INTEGER,
    snippet         TEXT,
    remediation     TEXT,
    analyzer        TEXT,                        -- Which analyzer produced this

    -- Meta-analysis enrichment (populated after meta runs)
    is_false_positive   BOOLEAN,                 -- meta_false_positive
    meta_confidence     TEXT,                    -- HIGH / MEDIUM / LOW
    meta_priority       INTEGER,                 -- Position in priority order

    -- Full metadata blob (includes aitech_code, policy fingerprint, etc.)
    metadata        JSONB NOT NULL DEFAULT '{}',

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scan_findings_report ON scan_findings(report_id);
CREATE INDEX IF NOT EXISTS idx_scan_findings_severity ON scan_findings(severity);

ALTER TABLE scan_findings ENABLE ROW LEVEL SECURITY;
```

### Design Rationale

**Why denormalize meta-analysis fields into both tables?**
- `scan_reports` gets the top-level verdict (`meta_verdict`, `meta_risk_level`, `meta_summary`) for list-view display without JOINs
- `scan_findings` gets per-finding enrichment (`is_false_positive`, `meta_confidence`, `meta_priority`) for filtering/sorting in the detail view
- The full blobs (`meta_analysis` JSONB) are preserved for debugging and future use

**Why not a `grade` column?**
The scanner's `meta_verdict` (SAFE/SUSPICIOUS/MALICIOUS) and `meta_risk_level` (CRITICAL-SAFE) are richer than a letter grade and are its native language. If we want to show a letter grade derived from scanner results, we compute it at display time.

---

## Scan Policy

### Which Preset?

The three presets differ primarily in:

| Dimension | Strict | Balanced | Permissive |
|-----------|--------|----------|------------|
| Hidden file allowlist | 6 files, 3 dirs | ~50 files, ~16 dirs | ~70 files, ~30 dirs |
| Pipeline taint | No trusted domains, no benign pipes | 16 trusted domains, 7 pipe patterns | 26 trusted domains, 11 pipe patterns |
| Rule scoping | Rules fire everywhere | Some rules skip docs | More rules skip docs |
| Credential suppression | Minimal | Known test values | Extended test values |
| File limits | `100 files, 5MB` | Same | `500 files, 20MB` |
| Severity overrides | None | None | 3 rules demoted |
| Disabled rules | None | None | 7 rules disabled entirely |
| LLM context budget | Default (20K/15K/100K) | Same | 2.5x (50K/30K/200K) |

**Recommendation: `balanced`** for the initial deployment. Rationale:

1. `balanced` is the scanner's default and most tested preset
2. It has sensible rule scoping (skip code-injection rules in doc files) without over-suppressing
3. It doesn't disable any rules, so we get the fullest signal
4. The 26% F-rate problem from PR #191 was on scanner 1.0.2 without meta-analysis or finding dedup — 2.0.3's meta-analyzer, dedup, and policy engine should significantly reduce FPs without needing `permissive`
5. If the backfill shows too many FPs, switching to `permissive` is a settings change, not a code change

### Custom Policy Considerations

We might want a custom policy that tweaks `balanced` for our specific use case. Candidates:

```yaml
# dhub_policy.yaml — balanced with dhub-specific overrides
policy_name: dhub
policy_version: "1.0"
preset_base: balanced

# Our skills often legitimately use shell commands and network
# Demote tool-use findings that are expected in agent skills
severity_overrides:
  - rule_id: TOOL_ABUSE_SYSTEM_PACKAGE_INSTALL
    severity: LOW
    reason: "Agent skills commonly install system packages"

# Increase LLM context for larger skills
llm_analysis:
  max_instruction_body_chars: 40000
  max_code_file_chars: 25000
  max_total_prompt_chars: 150000
  max_output_tokens: 16384
```

However, we should **start with stock `balanced`** and only create a custom policy after analyzing the backfill data. Premature customization hides real signals.

### Settings

```python
# settings.py additions
enable_cisco_scanner: bool = False
cisco_scanner_policy: str = "balanced"   # "strict" | "balanced" | "permissive" | path to YAML
```

---

## UI Presentation

### Gauntlet: Unchanged

The existing Audit tab continues to show gauntlet results exactly as they are: letter grade badge (A/B/C/F), check results grid, quarantine info.

### Scanner Report: New Section

Below each gauntlet audit entry, when a scan report exists for that version, a "Scanner Report" section appears. This section shows the scanner's results in their native format.

#### Summary Header

```
┌─────────────────────────────────────────────────────────────────┐
│  Scanner Report                                                 │
│                                                                 │
│  ┌──────────┐  ┌──────────────┐  ┌───────────┐  ┌───────────┐ │
│  │   SAFE   │  │ 5 findings   │  │ 2 FPs     │  │ Score: 94 │ │
│  │  verdict │  │ (3 validated)│  │ filtered  │  │ ████████░ │ │
│  └──────────┘  └──────────────┘  └───────────┘  └───────────┘ │
│                                                                 │
│  "Skill appears safe. Minor description-vs-implementation       │
│   mismatch detected but not exploitable." — meta-analysis       │
└─────────────────────────────────────────────────────────────────┘
```

The summary bar shows:
- **Meta verdict badge**: SAFE (green) / SUSPICIOUS (yellow) / MALICIOUS (red). Falls back to `max_severity` if meta didn't run.
- **Finding counts**: total, validated (non-FP), false positives filtered
- **Analyzability score**: percentage bar
- **Meta summary**: the one-sentence expert assessment from `overall_risk_assessment.summary`

#### Correlations (if any)

```
┌─────────────────────────────────────────────────────────────────┐
│  ▾ Correlated: "Credential Theft Chain"  (CRITICAL)             │
│    Findings #1, #3, #5 form a credential exfiltration attack    │
│    Fix: Replace hardcoded keys with environment variables       │
└─────────────────────────────────────────────────────────────────┘
```

These are the meta-analyzer's correlation groups — the highest-value output. Each shows the group name, combined severity, relationship description, and consolidated remediation.

#### Recommendations (if any)

```
┌─────────────────────────────────────────────────────────────────┐
│  Recommendations                                                │
│  1. Remove hardcoded credentials  (LOW effort, findings #0, #1) │
│  2. Narrow skill description      (LOW effort, finding #2)      │
└─────────────────────────────────────────────────────────────────┘
```

#### Findings List

Expandable, sorted by meta_priority (then severity). Each finding shows:

```
┌─────────────────────────────────────────────────────────────────┐
│  ▸ MEDIUM  Over-broad Capability Claims        [validated, HIGH]│
│    static_analyzer · prompt_injection · meta_priority: 1        │
│                                                                 │
│  ▸ LOW  Undeclared network capability           [validated, MED]│
│    behavioral · unauthorized_tool_use · meta_priority: 2        │
│                                                                 │
│  ▸ INFO  LLM context budget exceeded           [false positive] │
│    meta_analyzer · policy_violation                             │
└─────────────────────────────────────────────────────────────────┘
```

Expanding a finding shows: description, file path + line number, code snippet, remediation, exploitability/impact from meta.

False positives are shown dimmed/struck-through with the meta's reason, not hidden — transparency is the goal.

#### Metadata Footer

```
Analyzers: static, behavioral, pipeline, bytecode, trigger, llm, meta
Policy: balanced │ Duration: 34s │ Scanner v2.0.3
```

### Feature Flag

```typescript
// frontend/src/featureFlags.ts
export const SHOW_SCANNER_REPORT = false;
```

---

## Comprehensive Scanner Run

### Analyzer Configuration

Use `build_analyzers()` with all engines enabled:

```python
from skill_scanner.core.analyzer_factory import build_analyzers
from skill_scanner.core.scan_policy import ScanPolicy
from skill_scanner.core.analyzers.meta_analyzer import MetaAnalyzer, apply_meta_analysis_to_results
from skill_scanner import SkillScanner

policy = ScanPolicy.from_preset(settings.cisco_scanner_policy)

analyzers = build_analyzers(
    policy,
    use_behavioral=True,
    use_llm=bool(settings.google_api_key),
    llm_model=f"gemini/{settings.gemini_model}",
    llm_api_key=settings.google_api_key,
    use_trigger=True,
    llm_max_tokens=16384,   # more than the default 8192 for richer output
)

scanner = SkillScanner(analyzers=analyzers, policy=policy)
result = scanner.scan_skill(skill_dir)
```

This runs: static (13 passes), bytecode, pipeline, behavioral, trigger, LLM (with Phase 1 enrichment). The scanner's internal two-phase execution handles passing Phase 1 context to the LLM automatically.

### Meta-Analysis (Post-Processing)

Meta-analysis is a separate step. It requires findings from the scan:

```python
meta_result = None
if settings.google_api_key and result.findings:
    meta = MetaAnalyzer(
        model=f"gemini/{settings.gemini_model}",
        api_key=settings.google_api_key,
        policy=policy,
    )
    meta_result = await meta.analyze_with_findings(
        skill=loaded_skill,
        findings=result.findings,
        analyzers_used=result.analyzers_used,
    )
    result.findings = apply_meta_analysis_to_results(
        original_findings=result.findings,
        meta_result=meta_result,
        skill=loaded_skill,
    )
    if "meta_analyzer" not in result.analyzers_used:
        result.analyzers_used.append("meta_analyzer")
```

After `apply_meta_analysis_to_results`, every finding's `metadata` dict is enriched with `meta_false_positive`, `meta_confidence`, `meta_priority`, etc.

### What Gets Stored

```python
# scan_reports row
{
    "is_safe": result.is_safe,
    "max_severity": result.max_severity.value,
    "findings_count": len(result.findings),
    "analyzers_used": result.analyzers_used,
    "analyzers_failed": result.analyzers_failed,
    "analyzability_score": result.analyzability_score,
    "analyzability_details": result.analyzability_details,
    # Meta verdict (from overall_risk_assessment)
    "meta_verdict": meta_result.overall_risk_assessment.get("skill_verdict") if meta_result else None,
    "meta_risk_level": meta_result.overall_risk_assessment.get("risk_level") if meta_result else None,
    "meta_summary": meta_result.overall_risk_assessment.get("summary") if meta_result else None,
    "meta_top_priority": meta_result.overall_risk_assessment.get("top_priority") if meta_result else None,
    "meta_correlations": meta_result.correlations if meta_result else None,
    "meta_recommendations": meta_result.recommendations if meta_result else None,
    "meta_false_positive_count": len(meta_result.false_positives) if meta_result else None,
    # Blobs
    "full_report": result.to_dict(),
    "meta_analysis": meta_result.to_dict() if meta_result else None,
    "scan_metadata": result.scan_metadata,
}

# scan_findings rows (one per finding)
for i, f in enumerate(result.findings):
    {
        "rule_id": f.rule_id,
        "category": f.category.value,
        "severity": f.severity.value,
        "title": f.title,
        "description": f.description,
        "file_path": f.file_path,
        "line_number": f.line_number,
        "snippet": f.snippet,
        "remediation": f.remediation,
        "analyzer": f.analyzer,
        "is_false_positive": f.metadata.get("meta_false_positive"),
        "meta_confidence": f.metadata.get("meta_confidence"),
        "meta_priority": f.metadata.get("meta_priority"),
        "metadata": f.metadata,
    }
```

---

## Incremental Testing Plan

### Step 0: Unit Tests (No API Keys Required)

Test the bridge module with mocked scanner output:
- Result mapping (ScanResult → DB insert dict)
- Finding mapping (Finding → scan_findings row)
- Error handling (scanner crash → fail-open, no publish block)
- Meta-analysis mapping (MetaAnalysisResult → denormalized fields)
- LLM degradation detection via `analyzers_failed`

### Step 1: Smoke Test (1 Skill, Static-Only)

Deploy to dev with `enable_cisco_scanner=True` but using only free analyzers (no LLM). Verify:
- Scanner dependency installs correctly in Modal container
- Bridge imports, loads rules/packs, runs static + bytecode + pipeline + behavioral + trigger
- Result stores correctly in `scan_reports` + `scan_findings`
- API endpoint returns the report
- Frontend renders it (if SHOW_SCANNER_REPORT enabled)

```bash
cd server && DHUB_ENV=dev uv run --package decision-hub-server \
    python -m decision_hub.scripts.backfill_scan_reports --limit 1 --workers 1 --no-llm
```

### Step 2: Single Skill, Full Pipeline

One skill through the complete pipeline (all analyzers + meta-analysis):

```bash
cd server && DHUB_ENV=dev uv run --package decision-hub-server \
    python -m decision_hub.scripts.backfill_scan_reports --limit 1 --workers 1
```

Verify: LLM analyzer runs, meta-analysis runs, `meta_verdict` is populated, findings have `meta_false_positive` enrichment, scan duration is reasonable (~30-60s).

### Step 3: Small Batch (10 Skills, 2 Workers)

```bash
cd server && DHUB_ENV=dev uv run --package decision-hub-server \
    python -m decision_hub.scripts.backfill_scan_reports --limit 10 --workers 2
```

Verify: no Gemini rate limits, no thread-safety issues, results look reasonable.

### Step 4: Scale Test (100 Skills, 4 Workers)

```bash
cd server && DHUB_ENV=dev uv run --package decision-hub-server \
    python -m decision_hub.scripts.backfill_scan_reports --limit 100 --workers 4
```

At 4 workers, each skill makes ~2 Gemini calls (LLM + meta), so ~8 concurrent requests. Expected scan rate: ~2-3 skills/minute with LLM.

Key metrics to analyze:
- **Meta verdict distribution**: % SAFE / SUSPICIOUS / MALICIOUS
- **Max severity distribution**: % CRITICAL / HIGH / MEDIUM / LOW / INFO / SAFE
- **FP filtering rate**: what % of findings does meta mark as FP?
- **Agreement with gauntlet**: compare scanner verdicts to gauntlet grades
- **LLM reliability**: any `LLM_ANALYSIS_FAILED` findings or `analyzers_failed` entries?
- **Scan duration**: median / p90

### Step 5: Full Catalog

```bash
cd server && DHUB_ENV=dev uv run --package decision-hub-server \
    python -m decision_hub.scripts.backfill_scan_reports --workers 4 --resume
```

---

## What We're Deliberately NOT Doing

1. **No gauntlet changes** — it stays as-is, including `eval_audit_logs`
2. **No scanner-based publish decisions** — scanner data is display-only
3. **No letter grade for scanner** — we show meta_verdict and severity natively
4. **No monkey patches** — all upstream bugs are fixed in 2.0.0+
5. **No stdout capture** — `analyzers_failed` + `LLM_ANALYSIS_FAILED` findings replace the old hack
6. **No multi-PR phasing** — this is one PR since the partial states aren't useful on their own
7. **No custom policy** — start with stock `balanced`, customize after data

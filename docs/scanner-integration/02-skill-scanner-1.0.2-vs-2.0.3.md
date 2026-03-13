# skill-scanner: Pinned 1.0.2 vs Latest 2.0.3

**Date**: 2026-03-13
**Pinned version (PR #191)**: `cisco-ai-skill-scanner==1.0.2` (released 2026-02-06)
**Latest release**: `cisco-ai-skill-scanner==2.0.3` (released 2026-03-12)
**Releases between**: 2.0.0 (2026-02-26), 2.0.1 (2026-03-06), 2.0.2 (2026-03-09), 2.0.3 (2026-03-12)
**Files changed**: 261 files between 1.0.2 and 2.0.3

---

## 1. Major Architectural Changes (2.0.0)

### Scan Policy Engine
The biggest change. All previously hardcoded thresholds and allowlists are now configurable via YAML policy files.

- **Three built-in presets**: `strict`, `balanced` (default), `permissive`
- **13 independently configurable sections**: `HiddenFilePolicy`, `PipelinePolicy`, `RuleScopingPolicy`, `CredentialPolicy`, `CommandSafetyPolicy`, `FileLimitsPolicy`, `AnalysisThresholdsPolicy`, `AnalyzersPolicy`, `LLMAnalysisPolicy`, etc.
- `ScanPolicy.default()` returns balanced defaults; `ScanPolicy.from_preset("strict")` loads strict
- All analyzers now accept an optional `policy` parameter
- `SkillScanner.__init__` accepts `policy: ScanPolicy | None`

**Impact on bridge**: The bridge can now pass a policy object to tune detection sensitivity, which directly addresses the false-positive problem that plagued PR #191 (26% F-rate on trusted publishers). A `permissive` policy for trusted publishers vs `strict` for unknown ones is now a first-class concept.

### Rule Pack Architecture
Monolithic `signatures.yaml` replaced by modular `packs/core/` directory:
- Per-rule IDs, categories, severities
- Signatures split by category (command injection, data exfil, secrets, obfuscation, prompt injection, etc.)
- 14 YARA rule files and 12 Python check modules
- `RuleRegistry` and `PackLoader` for rule discovery
- Custom rule packs via `--custom-rules`

### Centralized Analyzer Factory (`analyzer_factory.py`)
New module that is the single source of truth for building analyzers:
- `build_core_analyzers(policy)` — static + bytecode + pipeline (respects `policy.analyzers.*` toggles)
- `build_analyzers(policy, *, use_llm=True, llm_model=..., llm_api_key=..., ...)` — full analyzer list including optional LLM, behavioral, trigger, VirusTotal

**Impact on bridge**: The old bridge built analyzers manually (`StaticAnalyzer()`, `BehavioralAnalyzer()`, `TriggerAnalyzer()`, `LLMAnalyzer(...)`). The new `build_analyzers()` factory handles this correctly, respecting policy toggles and error handling. The bridge should delegate to it.

### Two-Phase Scan Execution
Phase 1 runs all deterministic analyzers. Phase 2 sends the LLM enrichment context from Phase 1 (static findings, file inventory, magic mismatches). The `SkillScanner._scan_single_skill()` method orchestrates this automatically.

**Impact on bridge**: The bridge no longer needs to manage the MetaAnalyzer separately in most cases — the scanner handles the phased execution internally. However, MetaAnalyzer is still a post-processing step that needs explicit orchestration.

---

## 2. New Analysis Engines (2.0.0)

| Engine | Description | Relevance to dhub |
|--------|-------------|-------------------|
| **Pipeline Analyzer** | Shell taint flow tracking (source → transform → sink) | Overlaps with gauntlet's `check_pipeline_taint`; more sophisticated |
| **Bytecode Analyzer** | `.pyc` without `.py`, AST mismatch detection | New capability — supply-chain tampering detection |
| **Content Extractor** | Recursive archive extraction with zip-bomb protection | Previously zip extraction was manual in the bridge |
| **File Magic Detection** | Extension vs content mismatch (Magika, 200+ types) | New capability — catches disguised executables |
| **Bash Taint Tracker** | Dataflow analysis for bash scripts | New capability |

### Command Safety Tiering
Four-tier risk model (SAFE / CAUTION / RISKY / DANGEROUS) replacing flat allowlist. Commands evaluated in full context including arguments, pipes, and redirects.

### 13-Pass Static Analysis
Expanded from a few passes to: manifest validation, prompt injection in SKILL.md, code-level Python/Bash checks, consistency verification, PDF structural analysis, Office macro detection, homoglyph attacks, YARA patterns, prompt injection in assets.

### Finding Deduplication
Multi-engine findings on the same line/threat are collapsed into one entry at highest severity with attribution metadata.

### Analyzability Scoring (0–100)
Quantifies what fraction of the skill the scanner can inspect. A high-opacity skill (large binaries, few text files) gets a low score with an explicit finding.

---

## 3. Bug Fixes Relevant to the Bridge

### PR #39: Google Schema Sanitizer (merged 2026-02-24)
**The fix that triggered the monkey patch.** `_sanitize_schema_for_google` now handles nullable union types (`["string", "null"]` → `{"type": "STRING", "nullable": true}`). Confirmed present in 2.0.3. The `_patch_gemini_schema_sanitizer` monkey patch is **no longer needed**.

### PR #49: Dict-valued Compatibility Field (merged 2026-02-25)
`_manifest_declares_network` now wraps with `str()` before calling `.lower()`. Confirmed fixed in 2.0.3 — uses `str(skill.manifest.compatibility).lower()`. The `_patch_dict_compatibility_crash` monkey patch is **no longer needed**.

### Issue #38 / PR #43: LLM Error Surfacing (merged 2026-02-25)
`LLMAnalyzer` now emits an INFO-level `LLM_ANALYSIS_FAILED` finding with error details when exceptions occur. The `last_error` attribute is also set for machine-readable access. The `_check_llm_degradation` function and `_capture_stdout_during` hack are **largely unnecessary** — the scanner now surfaces failures through findings.

However, there is a nuance: `LLM_ANALYSIS_FAILED` is a per-skill finding. The stdout-capture approach in PR #191 was a belt-and-suspenders check. Since 2.0.3 provides structured error reporting, the bridge should check for `LLM_ANALYSIS_FAILED` findings in the result rather than capturing stdout.

### PR #46: LLM False-Positive Filter Fix
Fixed a boolean precedence bug that silently disabled the FP filter for "external guideline files" findings. Also improved severity ordering consistency and broadened analyzer factory exception handling.

---

## 4. API Surface Changes

### SkillScanner Constructor
```python
# 1.0.2
SkillScanner(analyzers=analyzers)

# 2.0.3
SkillScanner(analyzers=analyzers, policy=policy)
# OR (recommended)
SkillScanner(policy=policy)  # uses build_core_analyzers internally
```

### scan_skill Method
```python
# 1.0.2
result = scanner.scan_skill(skill_directory)  # returns ScanResult

# 2.0.3
result = scanner.scan_skill(skill_directory, lenient=False)  # returns ScanResult
```

### ScanResult Shape
```python
# 2.0.3 ScanResult fields
skill_name: str
skill_directory: str
findings: list[Finding]
scan_duration_seconds: float
analyzers_used: list[str]
analyzers_failed: list[dict[str, str]]    # NEW — tracks which analyzers failed
timestamp: datetime
analyzability_score: float | None
analyzability_details: dict | None
scan_metadata: dict | None

# Properties
is_safe: bool                              # True if no CRITICAL/HIGH findings
max_severity: Severity                     # Enum (has .name and .value)
```

### LLMAnalyzer Constructor
```python
# 1.0.2
LLMAnalyzer(model=model, api_key=api_key, max_tokens=32768)

# 2.0.3
LLMAnalyzer(model=model, api_key=api_key, max_tokens=32768, policy=policy)
# OR via factory
build_analyzers(policy, use_llm=True, llm_model=model, llm_api_key=key, llm_max_tokens=32768)
```

### MetaAnalyzer
```python
# 1.0.2 — manual orchestration required
meta = MetaAnalyzer(model=litellm_model, api_key=api_key, max_tokens=32768)
meta_result = asyncio.run(meta.analyze_with_findings(skill=skill, findings=result.findings, analyzers_used=result.analyzers_used))
enriched = apply_meta_analysis_to_results(original_findings=result.findings, meta_result=meta_result, skill=skill)

# 2.0.3 — same API, but MetaAnalyzer now takes policy
meta = MetaAnalyzer(model=litellm_model, api_key=api_key, max_tokens=32768, policy=policy)
```

### New Top-Level Functions
```python
from skill_scanner import scan_skill, scan_directory, validate_skill
from skill_scanner.core.analyzer_factory import build_analyzers, build_core_analyzers
from skill_scanner.core.scan_policy import ScanPolicy
```

---

## 5. Post-2.0.0 Releases

### 2.0.1 (2026-03-06)
- Render markdown in terminal when `--format markdown` and stdout is a TTY

### 2.0.2 (2026-03-09)
- Strengthen multilingual prompt-injection detection in LLM guidance
- Apply policy filters to cross-skill findings
- GPT-5 model support via `drop_params=True`

### 2.0.3 (2026-03-12)
- Explicit UTF-8 encoding on all file I/O to prevent `UnicodeDecodeError`

---

## 6. Key Implications for the Bridge Rewrite

1. **Monkey patches are obsolete** — all three upstream issues (union types, dict compat, silent LLM failures) are fixed in 2.0.0+
2. **Use the analyzer factory** — `build_analyzers()` is the recommended way to construct the analyzer list, not manual instantiation
3. **Policy engine addresses the FP problem** — the 26% F-rate on trusted publishers can be mitigated by using `permissive` or custom policies
4. **Structured error reporting** — `analyzers_failed` field and `LLM_ANALYSIS_FAILED` findings replace the stdout-capture hack
5. **Richer output** — `analyzability_score`, finding dedup, correlation groups provide better data for the UI
6. **Thread safety** — no more global `sys.stdout` replacement needed; errors are in the result object
7. **Two-phase execution** is handled by the scanner — the bridge doesn't need to manage LLM enrichment manually
8. **MetaAnalyzer orchestration** still needs explicit handling (it's not part of the default `scan_skill` flow)

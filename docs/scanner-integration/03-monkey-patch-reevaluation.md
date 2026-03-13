# Monkey Patch Reevaluation

**Date**: 2026-03-13
**PR #191 pinned version**: `cisco-ai-skill-scanner==1.0.2`
**Current latest**: `cisco-ai-skill-scanner==2.0.3`

PR #191 applied three monkey patches and one workaround to compensate for bugs and missing features in skill-scanner 1.0.2. This document evaluates each against the 2.0.3 release.

---

## Patch 1: `_patch_gemini_schema_sanitizer`

### What it did
Replaced `LLMRequestHandler._sanitize_schema_for_google` to handle JSON Schema union types like `["string", "null"]` that the Google GenAI SDK rejects. The patched version converted these to `{"type": "STRING", "nullable": true}`.

### Upstream fix
**PR #39** — "fix: normalize nullable union types in Google schema sanitizer"
- Merged: 2026-02-24
- Included in: 2.0.0+
- Author: @maresb (the same contributor who wrote the PR #191 patch)

### Current state in 2.0.3
The `_sanitize_schema_for_google` method in `llm_request_handler.py` now handles:
- Nullable union types (`["string", "null"]` → `{"type": "STRING", "nullable": true}`)
- Case normalization (`"string"` → `"STRING"`)
- Recursive handling of `properties`, `items`, and nested schemas

### Verdict: **REMOVE** — fully fixed upstream

The upstream fix is functionally identical to the monkey patch (same author). No patch needed.

---

## Patch 2: `_patch_dict_compatibility_crash`

### What it did
Wrapped `StaticAnalyzer._manifest_declares_network` and `consistency_checks.manifest_declares_network` with `str()` before calling `.lower()`. Skills with `compatibility: {python-version: '3.8+'}` (a dict instead of a string) would crash because `.lower()` was called on a dict.

### Upstream fix
**PR #49** — "[BUG] Fix crash on dict-valued compatibility field in StaticAnalyzer"
- Merged: 2026-02-25
- Included in: 2.0.0+

### Current state in 2.0.3
```python
def _manifest_declares_network(self, skill: Skill) -> bool:
    if skill.manifest.compatibility:
        compatibility_lower = str(skill.manifest.compatibility).lower()
        return "network" in compatibility_lower or "internet" in compatibility_lower
    return False
```

Exactly the same fix that the monkey patch applied.

### Verdict: **REMOVE** — fully fixed upstream

---

## Patch 3: `_check_llm_degradation` + `_capture_stdout_during`

### What it did
Two related workarounds for **issue #38** — "LLMAnalyzer swallows provider exceptions and reports success without a machine-readable failure signal":

1. `_capture_stdout_during(fn)`: Replaced `sys.stdout` globally during scanner execution to capture any `print()` output from the scanner. The scanner printed error messages to stdout when LLM calls failed.

2. `_check_llm_degradation(result, llm_expected, captured_stdout)`: Examined captured stdout for error keywords. If LLM was expected but stdout contained errors, injected an `LLM_DEGRADED` INFO finding into the result.

### Upstream fix
**PR #43** — "fix: address issues #29, #38, #40, #41 with tests"
- Merged: 2026-02-25
- Included in: 2.0.0+

### Current state in 2.0.3
The `LLMAnalyzer` now:

1. **Emits an `LLM_ANALYSIS_FAILED` INFO finding** when analysis fails:
   ```python
   Finding(
       id=f"llm_analysis_failed_{skill.name}",
       rule_id="LLM_ANALYSIS_FAILED",
       severity=Severity.INFO,
       ...
   )
   ```

2. **Sets `self.last_error`** for machine-readable access to the error.

3. **Reports in `analyzers_failed`** — the `ScanResult` now includes an `analyzers_failed: list[dict[str, str]]` field that tracks which analyzers failed and why.

### Verdict: **REMOVE BOTH** — replace with structured detection

The `_capture_stdout_during` hack (which was NOT thread-safe and would race with the parallelized crawler) is completely unnecessary. The `_check_llm_degradation` function should be replaced with a simpler check:

```python
def _detect_llm_degradation(result: ScanResult) -> bool:
    """Check if LLM analysis failed using structured signals."""
    # Check analyzers_failed list
    if any(af.get("name") == "llm_analyzer" for af in result.analyzers_failed):
        return True
    # Check for LLM_ANALYSIS_FAILED finding
    return any(f.rule_id == "LLM_ANALYSIS_FAILED" for f in result.findings)
```

This is thread-safe, doesn't require stdout capture, and uses the scanner's own reporting mechanism.

---

## Patch 4: LLM Retry Logic

### What it did
The bridge retried the entire scan up to `_LLM_RETRY_MAX` (2) times when `_has_llm_error_output(stdout)` returned True. This was a compensating mechanism for the silent LLM failures.

### Current state in 2.0.3
The `LLMAnalyzer` has built-in retry logic:
- `max_retries: int = 3` (parameter in constructor)
- `rate_limit_delay: float = 2.0` (exponential backoff)
- Retries on rate limits and transient errors

### Verdict: **SIMPLIFY** — the scanner handles retries internally

The bridge-level retry (re-running the entire scan) is expensive and was only needed because the scanner silently failed. With 2.0.3's built-in retries and explicit failure reporting, the bridge should:

1. Let the scanner handle its own retries
2. Check `analyzers_failed` / `LLM_ANALYSIS_FAILED` after the scan
3. Optionally retry the full scan once if LLM failed AND the result has no HIGH/CRITICAL findings from static analysis alone (i.e., the LLM result might have changed the grade)

---

## Summary

| Patch | PR #191 | Status in 2.0.3 | Action |
|-------|---------|-----------------|--------|
| `_patch_gemini_schema_sanitizer` | Monkey-patched `LLMRequestHandler._sanitize_schema_for_google` | Fixed upstream (PR #39) | **Remove** |
| `_patch_dict_compatibility_crash` | Monkey-patched `StaticAnalyzer._manifest_declares_network` | Fixed upstream (PR #49) | **Remove** |
| `_capture_stdout_during` | Global `sys.stdout` replacement (not thread-safe) | `analyzers_failed` + `LLM_ANALYSIS_FAILED` finding | **Remove** |
| `_check_llm_degradation` | Parsed captured stdout for error signals | `analyzers_failed` + `LLM_ANALYSIS_FAILED` finding | **Replace with structured check** |
| LLM retry loop | Re-ran entire scan on LLM failure | Built-in `max_retries=3` in LLMAnalyzer | **Simplify** |

**Net result**: All monkey patches are obsolete. The bridge becomes dramatically simpler — no patching, no stdout capture, no thread-safety concerns. The remaining logic is: configure scanner → run scan → map results.

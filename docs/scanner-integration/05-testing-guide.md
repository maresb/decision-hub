# Testing Guide: Scanner Integration

Step-by-step instructions for testing the Cisco scanner integration on your branch before merging.

---

## Prerequisites

- You're on the `cursor/plan-implementation-strategy-f4a2` branch
- You have `server/.env.dev` with valid credentials (DATABASE_URL, GOOGLE_API_KEY, S3, etc.)
- You have `uv` installed (`curl -LsSf https://astral.sh/uv/install.sh | sh`)

---

## Step 1: Run the unit tests locally

Verify the bridge tests pass before touching any infrastructure.

```bash
cd server && uv run --package decision-hub-server --extra dev \
    pytest tests/test_domain/test_skill_scanner_bridge.py -v
```

**Expected**: 14 tests pass. These are fully mocked — no API keys or DB needed.

---

## Step 2: Apply the database migration to dev

This drops any leftover `scan_reports`/`scan_findings` tables from the old PR #191 branch and recreates them with the new schema.

```bash
make migrate-dev
```

**Expected**: Migration `20260313_173012_create_scan_tables.sql` applies successfully. You should see it listed in the output.

**Verify** the tables exist:

```bash
cd server && DHUB_ENV=dev uv run --package decision-hub-server python -c "
from decision_hub.settings import create_settings
from decision_hub.infra.database import create_engine, scan_reports_table, scan_findings_table
import sqlalchemy as sa

settings = create_settings()
engine = create_engine(settings.database_url)
with engine.connect() as conn:
    r = conn.execute(sa.text('SELECT count(*) FROM scan_reports'))
    print(f'scan_reports rows: {r.scalar()}')
    r = conn.execute(sa.text('SELECT count(*) FROM scan_findings'))
    print(f'scan_findings rows: {r.scalar()}')
"
```

**Expected**: Both counts are 0.

---

## Step 3: Smoke test — scan one skill without LLM

Run the backfill on a single skill with only free analyzers (static, bytecode, pipeline, behavioral, trigger — no Gemini calls). This verifies the scanner dependency loads correctly.

```bash
cd server && DHUB_ENV=dev GOOGLE_API_KEY="" uv run --package decision-hub-server \
    python -m decision_hub.scripts.backfill_scan_reports --limit 1 --workers 1
```

**Note**: Setting `GOOGLE_API_KEY=""` overrides the `.env.dev` value so the scanner skips the LLM analyzer and meta-analysis.

**Expected**: One skill scanned, result stored. Output shows something like:

```
[1/1] org/skill-name v1.0.0: SAFE severity=LOW findings=3
Backfill complete: 1 scanned, 0 failed out of 1 total
```

**Verify** the data was stored:

```bash
cd server && DHUB_ENV=dev uv run --package decision-hub-server python -c "
from decision_hub.settings import create_settings
from decision_hub.infra.database import create_engine
import sqlalchemy as sa

settings = create_settings()
engine = create_engine(settings.database_url)
with engine.connect() as conn:
    r = conn.execute(sa.text('''
        SELECT org_slug, skill_name, semver, is_safe, max_severity,
               findings_count, analyzers_used, meta_verdict,
               scan_duration_ms, scanner_version
        FROM scan_reports ORDER BY created_at DESC LIMIT 1
    '''))
    row = r.one()
    print(dict(row._mapping))
"
```

**Check**:
- `is_safe` should be a boolean
- `analyzers_used` should contain `static`, `behavioral`, `pipeline`, `bytecode`, `trigger` but NOT `llm_analyzer` or `meta_analyzer`
- `meta_verdict` should be `None` (no LLM = no meta-analysis)
- `scanner_version` should be `2.0.x`

---

## Step 4: Single skill with full LLM pipeline

Now run with the real Gemini key, which enables the LLM analyzer and meta-analysis:

```bash
cd server && DHUB_ENV=dev uv run --package decision-hub-server \
    python -m decision_hub.scripts.backfill_scan_reports --limit 1 --workers 1
```

(The `--resume` behavior is the default — it skips the skill from Step 3 because it already has a report. This will scan a different skill.)

**Expected**: One skill scanned. Scan duration will be ~30-60 seconds (two Gemini calls: LLM analyzer + meta-analysis). Output shows the meta verdict:

```
Cisco scan complete: safe=True max_severity=MEDIUM meta_verdict=SAFE findings=5 fp_filtered=2 ...
```

**Verify** the meta-analysis fields are populated:

```bash
cd server && DHUB_ENV=dev uv run --package decision-hub-server python -c "
from decision_hub.settings import create_settings
from decision_hub.infra.database import create_engine
import sqlalchemy as sa

settings = create_settings()
engine = create_engine(settings.database_url)
with engine.connect() as conn:
    r = conn.execute(sa.text('''
        SELECT org_slug, skill_name, is_safe, max_severity,
               findings_count, meta_verdict, meta_risk_level,
               meta_summary, meta_false_positive_count,
               array_length(analyzers_used, 1) as num_analyzers
        FROM scan_reports
        WHERE meta_verdict IS NOT NULL
        ORDER BY created_at DESC LIMIT 1
    '''))
    row = r.one_or_none()
    if row:
        print(dict(row._mapping))
    else:
        print('No reports with meta-analysis found')
"
```

**Check**:
- `meta_verdict` is one of `SAFE`, `SUSPICIOUS`, `MALICIOUS`
- `meta_risk_level` is one of `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, `SAFE`
- `meta_summary` is a one-sentence English description
- `meta_false_positive_count` is a non-negative integer
- `num_analyzers` should be 7 (static, bytecode, pipeline, behavioral, trigger, llm_analyzer, meta_analyzer)

Also check that findings have meta-enrichment:

```bash
cd server && DHUB_ENV=dev uv run --package decision-hub-server python -c "
from decision_hub.settings import create_settings
from decision_hub.infra.database import create_engine
import sqlalchemy as sa

settings = create_settings()
engine = create_engine(settings.database_url)
with engine.connect() as conn:
    r = conn.execute(sa.text('''
        SELECT rule_id, severity, title, analyzer,
               is_false_positive, meta_confidence, meta_priority
        FROM scan_findings f
        JOIN scan_reports r ON f.report_id = r.id
        WHERE r.meta_verdict IS NOT NULL
        ORDER BY r.created_at DESC, f.meta_priority ASC NULLS LAST
        LIMIT 10
    '''))
    for row in r:
        d = dict(row._mapping)
        fp = '(FP)' if d['is_false_positive'] else ''
        print(f\"  {d['severity']:8s} {d['title'][:60]:60s} {d['analyzer'] or '':15s} conf={d['meta_confidence'] or '-':6s} pri={d['meta_priority'] or '-'} {fp}\")
"
```

---

## Step 5: Small batch (10 skills, 2 workers)

```bash
cd server && DHUB_ENV=dev uv run --package decision-hub-server \
    python -m decision_hub.scripts.backfill_scan_reports --limit 10 --workers 2
```

**Watch for**: Gemini 429 rate-limit errors in the output. If you see them, reduce to `--workers 1` or add `--delay 2`.

**Expected**: ~10 skills scanned in ~3-5 minutes (each takes 30-60s with 2 workers).

---

## Step 6: Verify the API endpoint

The scan report endpoint works even without deploying — you can test it against the dev database by running a local server, or by querying the DB directly. But to test the full HTTP path, pick an org/skill from the reports you just created:

```bash
cd server && DHUB_ENV=dev uv run --package decision-hub-server python -c "
from decision_hub.settings import create_settings
from decision_hub.infra.database import create_engine
import sqlalchemy as sa

settings = create_settings()
engine = create_engine(settings.database_url)
with engine.connect() as conn:
    r = conn.execute(sa.text('''
        SELECT org_slug, skill_name FROM scan_reports
        WHERE meta_verdict IS NOT NULL
        ORDER BY created_at DESC LIMIT 3
    '''))
    for row in r:
        print(f'{row.org_slug}/{row.skill_name}')
"
```

Then curl the endpoint on the deployed dev server (after deploying — see Step 8):

```bash
curl -s "https://hub-dev.decision.ai/v1/skills/ORG/SKILL/scan-report" | python -m json.tool | head -30
```

---

## Step 7: Medium batch (100 skills, 4 workers)

Once Steps 3-6 look good, run a larger batch to get meaningful statistics:

```bash
cd server && DHUB_ENV=dev uv run --package decision-hub-server \
    python -m decision_hub.scripts.backfill_scan_reports --limit 100 --workers 4
```

After it completes, run the analysis query:

```bash
cd server && DHUB_ENV=dev uv run --package decision-hub-server python -c "
from decision_hub.settings import create_settings
from decision_hub.infra.database import create_engine
import sqlalchemy as sa

settings = create_settings()
engine = create_engine(settings.database_url)
with engine.connect() as conn:
    # Verdict distribution
    r = conn.execute(sa.text('''
        SELECT meta_verdict, count(*) as n
        FROM scan_reports
        GROUP BY meta_verdict ORDER BY n DESC
    '''))
    print('=== Meta Verdict Distribution ===')
    for row in r:
        print(f'  {row.meta_verdict or \"(no meta)\":12s}  {row.n}')

    # Severity distribution
    r = conn.execute(sa.text('''
        SELECT max_severity, count(*) as n
        FROM scan_reports
        GROUP BY max_severity ORDER BY n DESC
    '''))
    print()
    print('=== Max Severity Distribution ===')
    for row in r:
        print(f'  {row.max_severity:12s}  {row.n}')

    # FP filtering rate
    r = conn.execute(sa.text('''
        SELECT
            sum(findings_count) as total_findings,
            sum(meta_false_positive_count) as total_fps,
            round(100.0 * sum(meta_false_positive_count) / nullif(sum(findings_count), 0), 1) as fp_pct
        FROM scan_reports
        WHERE meta_verdict IS NOT NULL
    '''))
    row = r.one()
    print()
    print(f'=== FP Filtering ===')
    print(f'  Total findings:     {row.total_findings}')
    print(f'  Marked as FP:       {row.total_fps}')
    print(f'  FP rate:            {row.fp_pct}%')

    # Scan duration stats
    r = conn.execute(sa.text('''
        SELECT
            round(avg(scan_duration_ms) / 1000.0, 1) as avg_sec,
            round(percentile_cont(0.5) WITHIN GROUP (ORDER BY scan_duration_ms) / 1000.0, 1) as median_sec,
            round(percentile_cont(0.9) WITHIN GROUP (ORDER BY scan_duration_ms) / 1000.0, 1) as p90_sec
        FROM scan_reports
    '''))
    row = r.one()
    print()
    print(f'=== Scan Duration ===')
    print(f'  Average:  {row.avg_sec}s')
    print(f'  Median:   {row.median_sec}s')
    print(f'  P90:      {row.p90_sec}s')
"
```

**Key numbers to evaluate**:
- `MALICIOUS` verdict rate on trusted publishers: ideally < 5%
- FP filtering rate: meta-analysis should be catching 20-40% of findings as FPs
- Scan duration median: ~30-60s is expected with LLM

---

## Step 8: Deploy to dev and enable the backend flag

Once you're satisfied with the backfill data, deploy your branch to dev. This will:
1. Build the frontend (with `SHOW_SCANNER_REPORT = false` — UI hidden)
2. Apply the migration (already done, so no-op)
3. Deploy the Modal app with the scanner code

**Important**: The deploy bakes `server/.env.dev` into the Modal image. To enable the scanner on future publishes, you need to add the flag to that file before deploying. But since `.env.dev` is in the forbidden-modifications list, instead override via an environment variable.

Deploy your branch:

```bash
make deploy-dev
```

After deploy, verify the API endpoint works on the live dev server by curling one of the skills you backfilled:

```bash
curl -s "https://hub-dev.decision.ai/v1/skills/ORG/SKILL/scan-report" | python -m json.tool | head -30
```

**At this point**: The scanner is deployed but dormant. No new publishes will trigger scans because `enable_cisco_scanner` defaults to `False`. The backfilled data is visible via the API but not in the UI (feature flag is off).

---

## Step 9: Enable the scanner for new publishes (optional)

To test the scanner on actual publishes (not just backfill), set the env var before deploying:

Add to `server/.env.dev`:
```
ENABLE_CISCO_SCANNER=true
```

Then redeploy:
```bash
make deploy-dev
```

Now publish a test skill and check that the scan report appears:

```bash
DHUB_ENV=dev dhub publish path/to/test-skill
```

Then check for the scan report:
```bash
curl -s "https://hub-dev.decision.ai/v1/skills/YOUR_ORG/test-skill/scan-report" | python -m json.tool
```

---

## Step 10: Enable the frontend feature flag

Once you've verified the backend data looks correct, flip the frontend flag to see the UI:

Edit `frontend/src/featureFlags.ts`:

```typescript
export const SHOW_SCANNER_REPORT = true;
```

Then deploy again:

```bash
make deploy-dev
```

Navigate to any skill detail page on `https://hub-dev.decision.ai` that has a scan report (from your backfill). Go to the **Audit** tab. Below the gauntlet check results grid, you should see the **Scanner Report** section with:

- Verdict badge (SAFE/SUSPICIOUS/MALICIOUS)
- Finding counts
- Meta summary sentence
- Correlation groups (if any)
- Recommendations (if any)
- Expandable findings list

**Remember**: Commit the flag change to your branch if you want it persisted, or leave it as a local change for testing only.

---

## Step 11: Full catalog backfill (when ready)

After everything looks good:

```bash
make backfill-scan-reports ARGS="--workers 4 --resume"
```

This scans all remaining skills. The `--resume` flag (default behavior) skips skills that already have reports. You can interrupt and restart safely.

---

## Troubleshooting

### "skill_scanner not installed" error
```bash
cd /workspace && uv sync
```

### Gemini 429 rate limit errors during backfill
Reduce workers or add delay:
```bash
make backfill-scan-reports ARGS="--limit 10 --workers 1 --delay 3"
```

### Migration fails with "table already exists"
The migration uses `DROP TABLE IF EXISTS` before `CREATE TABLE`, so this shouldn't happen. If it does, check that `schema_migrations` hasn't already recorded this migration name:
```sql
SELECT * FROM schema_migrations WHERE filename LIKE '%scan_tables%';
```

### Scanner crashes on a specific skill
The bridge catches scanner crashes and logs them. The backfill has a circuit breaker at 10 consecutive errors. Check Modal logs for the traceback:
```bash
modal app logs decision-hub-dev 2>&1 | grep -i "skill-scanner crashed"
```

### Frontend doesn't show scanner report
1. Check `SHOW_SCANNER_REPORT` is `true` in `featureFlags.ts`
2. Check the API returns data: `curl .../scan-report`
3. Check the browser console for errors
4. The report only shows on the Audit tab, attached to the first audit entry

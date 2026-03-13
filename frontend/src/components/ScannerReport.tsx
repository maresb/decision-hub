import { useState } from "react";
import { ChevronDown, ChevronRight, Shield, AlertTriangle, Info } from "lucide-react";
import type { ScanReport, ScanFinding } from "../types/api";
import styles from "./ScannerReport.module.css";

const SEVERITY_COLORS: Record<string, string> = {
  CRITICAL: "#ff4757",
  HIGH: "#ff6b35",
  MEDIUM: "#ffa502",
  LOW: "#3742fa",
  INFO: "#747d8c",
  SAFE: "#2ed573",
};

const VERDICT_COLORS: Record<string, string> = {
  SAFE: "#2ed573",
  SUSPICIOUS: "#ffa502",
  MALICIOUS: "#ff4757",
};

function SeverityBadge({ severity }: { severity: string }) {
  const color = SEVERITY_COLORS[severity] || "#747d8c";
  return (
    <span className={styles.severityBadge} style={{ borderColor: color, color }}>
      {severity}
    </span>
  );
}

function VerdictBadge({ verdict }: { verdict: string }) {
  const color = VERDICT_COLORS[verdict] || "#747d8c";
  return (
    <span className={styles.verdictBadge} style={{ backgroundColor: color }}>
      {verdict}
    </span>
  );
}

function FindingRow({ finding }: { finding: ScanFinding }) {
  const [expanded, setExpanded] = useState(false);
  const isFP = finding.is_false_positive === true;

  return (
    <div
      className={`${styles.findingRow} ${isFP ? styles.findingFP : ""}`}
      onClick={() => setExpanded(!expanded)}
    >
      <div className={styles.findingHeader}>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <SeverityBadge severity={finding.severity} />
        <span className={styles.findingTitle}>{finding.title}</span>
        {isFP && <span className={styles.fpLabel}>false positive</span>}
        {finding.meta_confidence && !isFP && (
          <span className={styles.confidenceLabel}>{finding.meta_confidence}</span>
        )}
      </div>
      <div className={styles.findingMeta}>
        {finding.analyzer && <span>{finding.analyzer}</span>}
        {finding.category && <span>{finding.category.replace(/_/g, " ")}</span>}
        {finding.meta_priority != null && <span>priority #{finding.meta_priority}</span>}
      </div>
      {expanded && (
        <div className={styles.findingDetails}>
          {finding.description && <p>{finding.description}</p>}
          {finding.file_path && (
            <div className={styles.findingLocation}>
              {finding.file_path}
              {finding.line_number != null && `:${finding.line_number}`}
            </div>
          )}
          {finding.snippet && (
            <pre className={styles.findingSnippet}>{finding.snippet}</pre>
          )}
          {finding.remediation && (
            <div className={styles.findingRemediation}>
              <strong>Fix:</strong> {finding.remediation}
            </div>
          )}
          {isFP && finding.metadata?.meta_reason && (
            <div className={styles.findingFPReason}>
              <Info size={12} /> FP reason: {String(finding.metadata.meta_reason)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function ScannerReport({ report }: { report: ScanReport }) {
  const [showFindings, setShowFindings] = useState(true);
  const validatedCount = report.findings.filter(
    (f) => f.is_false_positive !== true
  ).length;
  const fpCount = report.meta_false_positive_count ?? 0;
  const verdict = report.meta_verdict || report.max_severity;
  const durationSec = report.scan_duration_ms
    ? (report.scan_duration_ms / 1000).toFixed(0)
    : null;

  return (
    <div className={styles.scannerReport}>
      <div className={styles.reportHeader}>
        <Shield size={16} />
        <span className={styles.reportTitle}>Scanner Report</span>
      </div>

      <div className={styles.summaryBar}>
        {report.meta_verdict ? (
          <VerdictBadge verdict={report.meta_verdict} />
        ) : (
          <SeverityBadge severity={report.max_severity} />
        )}
        <div className={styles.summaryStats}>
          <span>
            {report.findings_count} finding{report.findings_count !== 1 ? "s" : ""}
            {validatedCount < report.findings_count && ` (${validatedCount} validated)`}
          </span>
          {fpCount > 0 && <span>{fpCount} FP filtered</span>}
          {report.analyzability_score != null && (
            <span>
              Score: {Math.round(report.analyzability_score)}%
            </span>
          )}
        </div>
      </div>

      {report.meta_summary && (
        <p className={styles.metaSummary}>{report.meta_summary}</p>
      )}

      {report.meta_correlations && report.meta_correlations.length > 0 && (
        <div className={styles.correlations}>
          <h4>Correlated Findings</h4>
          {report.meta_correlations.map((c, i) => (
            <div key={i} className={styles.correlationGroup}>
              <div className={styles.correlationHeader}>
                <AlertTriangle size={14} />
                <strong>{String(c.group_name || `Group ${i + 1}`)}</strong>
                {c.combined_severity && (
                  <SeverityBadge severity={String(c.combined_severity)} />
                )}
              </div>
              {c.relationship && (
                <p className={styles.correlationDesc}>
                  {String(c.relationship)}
                </p>
              )}
              {c.consolidated_remediation && (
                <p className={styles.correlationFix}>
                  <strong>Fix:</strong> {String(c.consolidated_remediation)}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {report.meta_recommendations && report.meta_recommendations.length > 0 && (
        <div className={styles.recommendations}>
          <h4>Recommendations</h4>
          {report.meta_recommendations.map((r, i) => (
            <div key={i} className={styles.recommendation}>
              <span className={styles.recPriority}>
                {Number(r.priority) || i + 1}.
              </span>
              <span>{String(r.title || r.fix || "")}</span>
              {r.effort && (
                <span className={styles.recEffort}>{String(r.effort)} effort</span>
              )}
            </div>
          ))}
        </div>
      )}

      {report.findings.length > 0 && (
        <div className={styles.findingsSection}>
          <button
            className={styles.findingsToggle}
            onClick={() => setShowFindings(!showFindings)}
          >
            {showFindings ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            Findings ({report.findings.length})
          </button>
          {showFindings && (
            <div className={styles.findingsList}>
              {report.findings.map((f, i) => (
                <FindingRow key={`${f.rule_id}-${i}`} finding={f} />
              ))}
            </div>
          )}
        </div>
      )}

      <div className={styles.reportFooter}>
        <span>
          Analyzers: {report.analyzers_used.join(", ")}
        </span>
        <span>Policy: {report.policy_name || "default"}</span>
        {durationSec && <span>Duration: {durationSec}s</span>}
        {report.scanner_version && (
          <span>Scanner v{report.scanner_version}</span>
        )}
      </div>
    </div>
  );
}

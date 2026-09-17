import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { requestJson } from "../../api";
import { compactWallet, formatCompactPft } from "../hive/HiveView.jsx";
import { ProfilePortrait, ProfileArtTraits } from "../profile/ProfilePortrait.jsx";
import "./directory.css";

const SORT_COLUMNS = [
  { key: "networkTasks", label: "Network" },
  { key: "personalTasks", label: "Personal" },
  { key: "rewards", label: "Rewards" },
  { key: "alignment", label: "Alignment (7d)" },
  { key: "score", label: "Score" },
];

function rankOperators(operators = []) {
  return [...operators]
    .sort((a, b) => (
      Number(b.score || 0) - Number(a.score || 0) ||
      Number(b.networkTasks || 0) - Number(a.networkTasks || 0) ||
      Number(b.rewards || 0) - Number(a.rewards || 0) ||
      String(a.handle || "").localeCompare(String(b.handle || ""))
    ))
    .map((operator, index) => ({ ...operator, rank: index + 1 }));
}

function sortOperators(operators = [], sortKey = "score") {
  const ranked = rankOperators(operators);
  if (sortKey === "score") return ranked;
  return [...ranked].sort((a, b) => {
    const aValue = sortKey === "alignment" && a.alignment === null ? -1 : Number(a[sortKey] || 0);
    const bValue = sortKey === "alignment" && b.alignment === null ? -1 : Number(b[sortKey] || 0);
    return bValue - aValue || Number(b.score || 0) - Number(a.score || 0) || a.rank - b.rank;
  });
}

function alignmentTone(value) {
  const score = Number(value || 0);
  if (score >= 70) return "high";
  if (score >= 55) return "medium";
  return "low";
}

function profileHref(accountId = "") {
  return `#/profile?account=${encodeURIComponent(accountId)}`;
}

function HeaderStat({ label, value, accent = false }) {
  return (
    <div className="directory-stat">
      <strong className={accent ? "is-accent" : ""}>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function DirectoryStatus({ status, onRefresh }) {
  if (status === "loading") return <div className="directory-empty">Loading directory.</div>;
  if (status === "error") {
    return (
      <div className="directory-empty is-error">
        <span>Directory is unavailable.</span>
        <button onClick={onRefresh} type="button">Retry</button>
      </div>
    );
  }
  return <div className="directory-empty">No operators yet.</div>;
}

function OperatorIdentity({ operator }) {
  return (
    <span className="directory-operator">
      <ProfilePortrait nft={operator.heroNft} seed={operator.accountId || operator.handle} label={`${operator.displayName || operator.handle || "Member"} profile picture`} size={64} className="directory-avatar" />
      <span className="directory-operator-copy">
        <strong>
          {operator.handle ? `@${operator.handle}` : operator.displayName || "Task Node member"}
          {operator.isYou && <em>You</em>}
        </strong>
        {operator.operatorDisclosure?.isMachineOperator && (
          <span className="directory-machine-badge">{operator.operatorDisclosure.label || "Orc operator"}</span>
        )}
        <small>{compactWallet(operator.wallet)}</small>
        <ProfileArtTraits nft={operator.heroNft} />
      </span>
    </span>
  );
}

function OperatorRow({ operator }) {
  const RowTag = operator.hasPublicProfile ? "a" : "div";
  const rowProps = operator.hasPublicProfile
    ? { href: profileHref(operator.accountId), "aria-label": `Open ${operator.displayName || operator.handle} public profile` }
    : {};
  const alignment = operator.alignment;
  const hasAlignment = alignment !== null && alignment !== undefined && Number.isFinite(Number(alignment));
  return (
    <RowTag
      className={`directory-row${operator.isYou ? " is-you" : ""}${operator.hasPublicProfile ? " is-link" : ""}`}
      role="row"
      {...rowProps}
    >
      <span className={`directory-rank${operator.rank <= 3 ? " is-top" : ""}`}>{operator.rank}</span>
      <OperatorIdentity operator={operator} />
      <span className="directory-row-stats">
        <span className="directory-stat-cell">
          {operator.networkTasks}
          <small>Network</small>
        </span>
        <span className="directory-stat-cell">
          {operator.personalTasks}
          <small>Personal</small>
        </span>
        <span className="directory-stat-cell">
          {formatCompactPft(operator.rewards)}
          <small>Rewards</small>
        </span>
        <span className="directory-alignment">
          <span>{hasAlignment ? Math.round(Number(alignment)) : "—"}</span>
          {hasAlignment && <small>/ 100</small>}
          <i className={`tone-${alignmentTone(alignment)}`}>
            <b style={{ width: hasAlignment ? `${Math.max(0, Math.min(100, Number(alignment)))}%` : "0%" }} />
          </i>
          <small title="Airdrop PFT received over the last 7 days as a share of the maximum possible">Alignment (7d)</small>
        </span>
        <span className="directory-stat-cell is-score">
          {Math.round(Number(operator.score || 0))}
          <small>Score</small>
        </span>
      </span>
    </RowTag>
  );
}

export function DirectoryView() {
  const [document, setDocument] = useState(null);
  const [status, setStatus] = useState("loading");
  const [refreshing, setRefreshing] = useState(false);
  const [sortKey, setSortKey] = useState("score");

  const loadDirectory = useCallback(async ({ showLoading = false, shouldApply = () => true } = {}) => {
    if (showLoading && shouldApply()) setStatus("loading");
    setRefreshing(true);
    try {
      const result = await requestJson("/api/directory/leaderboard");
      if (!shouldApply()) return;
      if (!result.ok) throw new Error(result.body?.message || `Directory returned HTTP ${result.status}.`);
      setDocument(result.body?.document || null);
      setStatus("ready");
    } catch {
      if (!shouldApply()) return;
      setDocument(null);
      setStatus("error");
    } finally {
      if (shouldApply()) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadDirectory({ showLoading: true, shouldApply: () => !cancelled });
    return () => {
      cancelled = true;
    };
  }, [loadDirectory]);

  const operators = useMemo(() => sortOperators(document?.operators || [], sortKey), [document?.operators, sortKey]);
  const totals = document?.totals || {};
  const readyWithRows = status === "ready" && operators.length > 0;

  return (
    <div className="route-scroll directory-route">
      <div className="directory-shell">
        <header className="directory-header">
          <div>
            <div className={`directory-live-kicker${readyWithRows ? " is-live" : ""}`}>
              <span />
              {readyWithRows ? "Live" : "Directory"}
            </div>
            <h1>Directory</h1>
            <p>Public, discoverable operators ranked by rewarded work, PFT earned, and current alignment score.</p>
          </div>
          <div className="directory-header-actions">
            <div className="directory-stats">
              <HeaderStat label="operators" value={status === "ready" ? totals.operators || 0 : "—"} />
              <HeaderStat label="tasks rewarded" value={status === "ready" ? Number(totals.tasksRewarded || 0).toLocaleString("en-US") : "—"} />
              <HeaderStat label="PFT distributed" value={status === "ready" ? formatCompactPft(totals.pftDistributed) : "—"} accent />
            </div>
            <button
              className="directory-refresh"
              disabled={refreshing}
              onClick={() => loadDirectory()}
              title="Refresh directory"
              type="button"
            >
              <RefreshCw aria-hidden="true" size={15} strokeWidth={1.8} />
              <span>{refreshing ? "Refreshing" : "Refresh"}</span>
            </button>
          </div>
        </header>

        <section className="directory-board" aria-label="Operator leaderboard">
          <div className="directory-board-title">
            <div>
              <h2>Leaderboard</h2>
              <p>Rank score = 3x network tasks + personal tasks + rewards/25000 + alignment.</p>
            </div>
            <small>Showing public, discoverable operators only.</small>
          </div>

          <div className="directory-row directory-row-head" role="row">
            <span>Rank</span>
            <span>Operator</span>
            {SORT_COLUMNS.map((column) => (
              <button
                className={sortKey === column.key ? "is-active" : ""}
                key={column.key}
                onClick={() => setSortKey(column.key)}
                type="button"
              >
                {column.label}
              </button>
            ))}
          </div>

          {operators.length > 0 ? (
            <div className="directory-rows">
              {operators.map((operator) => (
                <OperatorRow key={operator.accountId} operator={operator} />
              ))}
            </div>
          ) : (
            <DirectoryStatus onRefresh={() => loadDirectory()} status={status} />
          )}
        </section>

        <footer className="directory-note">
          Ranks stay tied to the composite score when sorting by a column. Rows without a discoverable public profile are intentionally not links.
          {document?.generatedAt && <span> Generated {new Date(document.generatedAt).toLocaleString()}.</span>}
        </footer>
      </div>
    </div>
  );
}

export default DirectoryView;

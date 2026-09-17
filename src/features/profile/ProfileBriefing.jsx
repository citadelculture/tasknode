import { useMemo, useRef, useState } from "react";
import {
  C,
  MONO,
  dateKeyUtc,
  fmtDate,
  fmtDateLabel,
  fmtN,
  fmtPft,
} from "./profile-view-shared.jsx";

export const NFT_DATA = [
  { id: "n1", title: "Network Reliability Engineer", date: "May 13, 2026", kind: "topology", palette: "green", rarity: "Common" },
  { id: "n2", title: "NFT 2026-05-12",               date: "May 12, 2026", kind: "circuit",  palette: "gray",  rarity: "Common" },
  { id: "n3", title: "Alpha Brief Analyst",          date: "May 7, 2026",  kind: "sunburst", palette: "gold",  rarity: "Uncommon" },
  { id: "n4", title: "Alpha Brief Analyst",          date: "May 7, 2026",  kind: "flow",     palette: "blue",  rarity: "Uncommon" },
];

export function NFTArt({ kind, palette, size = 160 }) {
  const id = useMemo(() => Math.random().toString(36).slice(2, 8), []);
  const palettes = {
    green: { base: "#5FA66D", dark: "#2F5A3A", light: "#B8E0BB", accent: "#0F3A1E" },
    gray:  { base: "#7C7269", dark: "#3D3833", light: "#C9C2BA", accent: "#1F1B16" },
    gold:  { base: "#D89A30", dark: "#7A4C00", light: "#F3D88E", accent: "#3B2304" },
    blue:  { base: "#5293C2", dark: "#1E4561", light: "#B6D5E8", accent: "#0E2538" },
  };
  const p = palettes[palette] || palettes.green;
  return (
    <svg viewBox="0 0 160 160" width={size} height={size} style={{ display: "block", borderRadius: 12 }}>
      <defs>
        <radialGradient id={`bg-${id}`} cx="35%" cy="32%" r="80%">
          <stop offset="0%"  stopColor={p.light} stopOpacity="0.95" />
          <stop offset="55%" stopColor={p.base}  stopOpacity="1" />
          <stop offset="100%" stopColor={p.dark} stopOpacity="1" />
        </radialGradient>
        <linearGradient id={`sheen-${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.28" />
          <stop offset="60%" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
        <filter id={`grain-${id}`}>
          <feTurbulence type="fractalNoise" baseFrequency="1.4" numOctaves="2" />
          <feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.06 0" />
          <feComposite in2="SourceGraphic" operator="in" />
        </filter>
        <clipPath id={`clip-${id}`}>
          <rect width="160" height="160" rx="12" />
        </clipPath>
      </defs>

      <g clipPath={`url(#clip-${id})`}>
        <rect width="160" height="160" fill={`url(#bg-${id})`} />

        {kind === "topology" && (
          <g stroke={p.accent} strokeOpacity="0.55" fill="none" strokeWidth="0.6">
            {[14, 26, 38, 50, 62, 74, 86].map((r, i) => (
              <circle key={i} cx="62" cy="74" r={r} strokeDasharray={i % 2 ? "2 3" : "0"} />
            ))}
            {[[62,74],[108,50],[120,100],[40,110],[30,50],[100,36],[82,130]].map(([x,y], i) => (
              <circle key={i} cx={x} cy={y} r={i === 0 ? 4 : 2.2} fill={p.accent} strokeWidth="0" />
            ))}
            {[[62,74,108,50],[62,74,120,100],[62,74,40,110],[62,74,30,50],[62,74,100,36],[62,74,82,130]].map(([x1,y1,x2,y2], i) => (
              <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} strokeOpacity="0.4" />
            ))}
          </g>
        )}

        {kind === "circuit" && (
          <g stroke={p.accent} strokeOpacity="0.6" fill="none" strokeWidth="0.7">
            {Array.from({ length: 9 }).map((_, i) => (
              <line key={`v-${i}`} x1={20 + i * 16} y1="20" x2={20 + i * 16} y2="140" strokeOpacity="0.18" />
            ))}
            {Array.from({ length: 9 }).map((_, i) => (
              <line key={`h-${i}`} x1="20" y1={20 + i * 16} x2="140" y2={20 + i * 16} strokeOpacity="0.18" />
            ))}
            <path d="M28 36 L60 36 L60 60 L92 60 L92 92 L124 92" strokeWidth="1.4" />
            <path d="M28 100 L44 100 L44 116 L84 116 L84 132 L116 132" strokeWidth="1.4" />
            <path d="M132 28 L132 60 L116 60 L116 76" strokeWidth="1.4" />
            {[[60,60],[92,60],[92,92],[124,92],[84,116],[116,132],[116,76],[44,100]].map(([x,y], i) => (
              <circle key={i} cx={x} cy={y} r="2.4" fill={p.accent} />
            ))}
          </g>
        )}

        {kind === "sunburst" && (
          <g transform="translate(80 86)">
            {Array.from({ length: 36 }).map((_, i) => {
              const a = (i / 36) * Math.PI * 2;
              const len = 52 + ((i * 13) % 9);
              const x1 = Math.cos(a) * 16, y1 = Math.sin(a) * 16;
              const x2 = Math.cos(a) * len, y2 = Math.sin(a) * len;
              return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2}
                stroke={p.accent} strokeOpacity={i % 3 ? 0.35 : 0.7}
                strokeWidth={i % 3 ? 0.7 : 1.2} />;
            })}
            <circle r="14" fill={p.accent} fillOpacity="0.9" />
            <circle r="8"  fill={p.light} />
            <circle r="3"  fill={p.accent} />
          </g>
        )}

        {kind === "flow" && (
          <g stroke={p.accent} strokeOpacity="0.55" fill="none" strokeWidth="0.8">
            {Array.from({ length: 11 }).map((_, i) => {
              const y = 18 + i * 11;
              const o = (i % 2) * 6;
              return (
                <path key={i}
                  d={`M${0+o} ${y} C 40 ${y - 14}, 80 ${y + 14}, 120 ${y - 6} S 200 ${y + 8}, 240 ${y}`}
                  strokeOpacity={0.18 + (i % 3) * 0.18} />
              );
            })}
            <circle cx="48" cy="62" r="3" fill={p.accent} stroke="none" />
            <circle cx="100" cy="92" r="2.4" fill={p.accent} stroke="none" />
            <circle cx="124" cy="46" r="1.8" fill={p.accent} stroke="none" />
          </g>
        )}

        <rect width="160" height="160" fill={`url(#sheen-${id})`} />
        <rect width="160" height="160" filter={`url(#grain-${id})`} />
        <rect width="160" height="160" fill="none" stroke="rgba(0,0,0,.18)" strokeWidth="1" rx="12" />
      </g>
    </svg>
  );
}
export function RewardsChart({ data = [] }) {
  const [hover, setHover] = useState(null);
  const ref = useRef(null);
  const points = Array.isArray(data) ? data : [];

  if (!points.length) {
    return (
      <div style={{
        borderTop: `1px solid ${C.ruleSoft}`,
        color: C.ink4,
        fontSize: 13.5,
        lineHeight: 1.55,
        paddingTop: 24,
      }}>
        No rewarded task payments are available for this range yet.
      </div>
    );
  }

  const W = 760, H = 240;
  const padL = 8, padR = 64, padT = 28, padB = 26;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const totals = points.map(d => Number(d.total || 0));
  const maxY = Math.max(1, ...totals) * 1.12;
  const x = i => points.length <= 1 ? padL + innerW : padL + (i / (points.length - 1)) * innerW;
  const y = v => padT + innerH - (Number(v || 0) / maxY) * innerH;
  const baseline = H - padB;
  const linePath = "M " + points.map((d, i) => `${x(i)} ${y(d.total)}`).join(" L ");
  const areaPath = [
    `M ${x(0)} ${baseline}`,
    ...points.map((d, i) => `L ${x(i)} ${y(d.total)}`),
    `L ${x(points.length - 1)} ${baseline}`,
    "Z",
  ].join(" ");
  const ticks = points.map((d, i) => ({ i, d })).filter(({ i }) => i % 7 === 0 || i === points.length - 1);
  const lastIdx = points.length - 1;
  const lastTotal = totals[lastIdx] || 0;

  const handleMove = (e) => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    if (px < padL || px > padL + innerW) { setHover(null); return; }
    const rel = (px - padL) / innerW;
    const idx = Math.round(rel * (points.length - 1));
    setHover(Math.max(0, Math.min(points.length - 1, idx)));
  };
  const handleLeave = () => setHover(null);

  return (
    <div style={{ position: "relative" }}>
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} width="100%"
        style={{ display: "block", overflow: "visible" }}
        onMouseMove={handleMove} onMouseLeave={handleLeave}>
        <defs>
          <linearGradient id="grad-reward-actual" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={C.layerNetwork} stopOpacity="0.30" />
            <stop offset="100%" stopColor={C.layerNetwork} stopOpacity="0.08" />
          </linearGradient>
        </defs>

        <line x1={padL} x2={W - padR} y1={H - padB} y2={H - padB} stroke={C.rule} strokeWidth="0.8" />

        <path d={areaPath} fill="url(#grad-reward-actual)" />
        <path d={linePath} fill="none" stroke={C.ink} strokeWidth="1.4" />

        <circle cx={x(lastIdx)} cy={y(lastTotal)} r="4" fill={C.paper3} stroke={C.ink} strokeWidth="1.5" />
        <text x={x(lastIdx)} y={Math.max(12, y(lastTotal) - 12)} fontSize="10" fill={C.ink2}
          textAnchor="end" fontWeight="600" letterSpacing="0.05em">
          TODAY · {fmtPft(lastTotal)}
        </text>

        <text x={x(lastIdx)} y={padT - 6} fontSize="9.5" fill={C.ink5}
          textAnchor="end" fontFamily={MONO}>
          peak {fmtPft(Math.max(...totals))}
        </text>

        {ticks.map(({ i, d }) => (
          <text key={i} x={x(i)} y={H - 6} fontSize="10" fill={C.ink4}
            textAnchor="middle" fontFamily={MONO}>
            {fmtDate(new Date(`${d.date}T00:00:00Z`))}
          </text>
        ))}

        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={H - padB}
              stroke={C.ink} strokeOpacity="0.18" />
            <circle cx={x(hover)}
              cy={y(points[hover].total)}
              r="3" fill={C.ink} />
          </g>
        )}
      </svg>

      {hover !== null && (
        <div className="tn-fadeIn tn-mono" style={{
          position: "absolute",
          left: `${(x(hover) / W) * 100}%`,
          top: 8,
          transform: hover > data.length / 2 ? "translateX(-110%)" : "translateX(8%)",
          fontSize: 11.5,
          color: C.ink2,
          pointerEvents: "none",
          lineHeight: 1.55,
          background: "var(--tn-dark-bg, rgba(255,252,245,0.88))",
          padding: "6px 10px",
          backdropFilter: "blur(2px)",
        }}>
          <div style={{ color: C.ink4, marginBottom: 2 }}>
            {fmtDate(new Date(`${points[hover].date}T00:00:00Z`))}{hover === points.length - 1 ? " · today" : ""}
          </div>
          <div style={{ color: C.ink, fontWeight: 600 }}>
            {fmtPft(points[hover].total)} PFT
          </div>
          <div style={{ color: C.ink4 }}>
            Airdrops {fmtPft(points[hover].airdropPft || 0)} · Rewards {fmtPft(points[hover].rewardPft || 0)}
          </div>
          <div style={{ color: C.ink4 }}>
            {fmtN(points[hover].airdropCount || 0)} airdrop{Number(points[hover].airdropCount || 0) === 1 ? "" : "s"} · {fmtN(points[hover].taskCount)} rewarded task{Number(points[hover].taskCount || 0) === 1 ? "" : "s"}
          </div>
        </div>
      )}
    </div>
  );
}

export const MINT_STEPS = [
  { id: "prep",    label: "Preparing transaction",  pct: 18 },
  { id: "sign",    label: "Requesting signature",    pct: 38 },
  { id: "broad",   label: "Broadcasting to network", pct: 62 },
  { id: "confirm", label: "Confirming on ledger",    pct: 88 },
  { id: "done",    label: "Minted",                  pct: 100 },
];

export function mintStepForPhase(phase = "idle") {
  if (phase === "signing") return MINT_STEPS[1];
  if (phase === "broadcasting") return MINT_STEPS[2];
  if (phase === "confirming") return MINT_STEPS[3];
  if (phase === "success") return MINT_STEPS[4];
  return MINT_STEPS[0];
}

export function TodaysBriefing({ airdrop, error = "", loading = false, rewardHistory }) {
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const points = rewardHistory?.points || [];
  const totals = points.map((point) => Number(point.total || 0));
  const rewardTotal = Number(rewardHistory?.totals?.rewardPft || 0);
  const airdropTotal = Number(rewardHistory?.totals?.airdropPft || 0);
  const earnedTotal = Number(rewardHistory?.totals?.totalPft ?? (rewardTotal + airdropTotal));
  const taskCount = Number(rewardHistory?.totals?.taskCount || 0);
  const airdropCount = Number(rewardHistory?.totals?.airdropCount || 0);
  const paidAirdrop = airdrop?.issuance?.status === "submitted" ? airdrop.issuance : null;
  const payoutStatus = airdrop?.issuance?.status || (airdrop ? "scored" : "");
  const payoutStatusText = {
    submitted: "Paid",
    scored: "Scored, payout pending",
    pending: "Payout queued",
    processing_pre_submit: "Preparing payout",
    failed_before_submit: "Retry pending",
    submitting: "Submission in progress",
    submit_unknown: "Needs reconciliation",
    cancelled: "Cancelled",
  }[payoutStatus] || payoutStatus.replaceAll("_", " ");
  const payoutStatusTone = paidAirdrop
    ? C.success
    : payoutStatus === "submit_unknown" || payoutStatus === "submitting"
      ? C.rust
      : C.warning;
  const airdropAmount = Number(paidAirdrop?.amountPft || airdrop?.dailyAirdropPft || 0);
  // Two different 0-100 numbers live on this card and must not share a name:
  // - workQualityScore: the AI's assessment of the latest scored day's rewarded
  //   work (retention_value_score), independent of the payout.
  // - airdropAlignment7d: actual airdrop PFT / max possible over the last 7
  //   days (alignment_score_7d). This is the "Alignment" the directory ranks by.
  const workQualityScore = Number.isFinite(airdrop?.retentionValueScore)
    ? Math.round(Math.min(100, Math.max(0, airdrop.retentionValueScore)))
    : null;
  const airdropAlignment7d = Number.isFinite(airdrop?.alignmentScore7d)
    ? Math.round(Math.min(100, Math.max(0, airdrop.alignmentScore7d * 100)))
    : null;
  const airdropDateSource = paidAirdrop?.submittedAt || airdrop?.completedAt || airdrop?.runDate;
  const runDate = fmtDateLabel(airdropDateSource);
  const isTodaysAirdrop = Boolean(airdropDateSource) && dateKeyUtc(airdropDateSource) === dateKeyUtc(new Date());
  const airdropTitle = `${isTodaysAirdrop ? "Today's" : "Latest"} airdrop${runDate ? ` · ${runDate}` : ""}`;
  const headlineLabel = paidAirdrop ? "Daily airdrop paid" : "Daily airdrop scored, not paid yet";
  const rewardedTasks = Number(airdrop?.rewardTotals?.rewarded_task_count || 0);
  const hasReasoning = Boolean(String(airdrop?.reasoningText || "").trim());
  const airdropPointIndex = points.findIndex((point) => point.date === dateKeyUtc(airdropDateSource));
  const airdropPointWindowEnd = airdropPointIndex >= 0 ? airdropPointIndex : points.length - 1;
  const previousSeven = points.slice(Math.max(0, airdropPointWindowEnd - 7), Math.max(0, airdropPointWindowEnd));
  const previousSevenAverage = previousSeven.length
    ? previousSeven.reduce((sum, point) => sum + Number(point.airdropPft || 0), 0) / previousSeven.length
    : 0;
  const deltaVs7d = previousSevenAverage > 0
    ? ((airdropAmount - previousSevenAverage) / previousSevenAverage) * 100
    : null;
  const sparkW = 260;
  const sparkH = 56;
  const maxSpark = Math.max(1, ...totals);
  const sparkPoints = points.map((point, i) => {
    const x = points.length <= 1 ? sparkW : (i / (points.length - 1)) * sparkW;
    const y = sparkH - (Number(point.total || 0) / maxSpark) * sparkH + 2;
    return `${x},${y}`;
  }).join(" ");

  if (loading) {
    return (
      <section style={{ paddingTop: 8 }}>
        <div style={{ fontSize: 13, color: C.ink3, marginBottom: 28 }}>Today's airdrop</div>
        <div className="tn-shimmer" style={{ height: 116, borderRadius: 12 }} />
      </section>
    );
  }

  if (error) {
    return (
      <section style={{ paddingTop: 8 }}>
        <div style={{ fontSize: 13, color: C.ink3, marginBottom: 28 }}>Today's airdrop</div>
        <div style={{ color: C.rust, fontSize: 14 }}>{error}</div>
      </section>
    );
  }

  if (!airdrop) {
    return (
      <section style={{ paddingTop: 8 }}>
        <div style={{ fontSize: 13, color: C.ink3, marginBottom: 28 }}>Today's airdrop</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: 56, alignItems: "end", marginBottom: 36 }}>
          <div>
            <div style={{ fontSize: 13.5, color: C.ink3, marginBottom: 6 }}>No score generated yet</div>
            <div className="tn-bigNum" style={{ fontSize: 72, lineHeight: 0.95, color: C.ink, marginBottom: 16 }}>
              0<span style={{ fontSize: 24, color: C.ink4, fontWeight: 500, marginLeft: 12, letterSpacing: 0 }}>PFT</span>
            </div>
            <div style={{ fontSize: 13.5, color: C.ink4 }}>
              Run the daily airdrop scorer to populate this account-level panel.
            </div>
          </div>
          <RewardSparkline
            airdropTotal={airdropTotal}
            earnedTotal={earnedTotal}
            points={points}
            rewardTotal={rewardTotal}
            taskCount={taskCount}
          />
        </div>
      </section>
    );
  }

  return (
    <section style={{ paddingTop: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 28 }}>
        <div style={{ fontSize: 13, color: C.ink3 }}>
          {airdropTitle}
        </div>
        {hasReasoning && (
          <button
            className="tn-link"
            onClick={() => setReasoningOpen((value) => !value)}
            style={{ background: "transparent", border: 0, padding: 0 }}
            type="button"
          >
            {reasoningOpen ? "Hide reasoning" : "Full reasoning"} →
          </button>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: 56, alignItems: "flex-end", marginBottom: 36 }}>
        <div>
          <div style={{ fontSize: 13.5, color: C.ink3, marginBottom: 6 }}>
            {headlineLabel}
          </div>
          <div className="tn-bigNum" style={{ fontSize: 88, lineHeight: 0.95, color: C.ink, marginBottom: 16 }}>
            {fmtPft(airdropAmount)}<span style={{ fontSize: 24, color: C.ink4, fontWeight: 500, marginLeft: 12, letterSpacing: 0 }}>PFT</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 13.5, color: C.ink3, flexWrap: "wrap" }}>
            <span style={{ color: payoutStatusTone, fontWeight: 600 }}>
              {payoutStatusText}
            </span>
            {paidAirdrop?.txHash && (
              <>
                <span style={{ color: C.ink5 }}>·</span>
                <span title={paidAirdrop.txHash}>Tx {paidAirdrop.txHash.slice(0, 10)}...</span>
              </>
            )}
            <span style={{ color: C.ink5 }}>·</span>
            {deltaVs7d !== null && (
              <>
                <span style={{ color: deltaVs7d >= 0 ? C.success : C.rust, fontWeight: 600 }}>
                  {deltaVs7d >= 0 ? "↑" : "↓"} {Math.abs(deltaVs7d).toFixed(0)}% <span style={{ color: C.ink4, fontWeight: 400 }}>vs 7-day avg</span>
                </span>
                <span style={{ color: C.ink5 }}>·</span>
              </>
            )}
            <span data-testid="daily-airdrop-alignment" title="AI assessment of recent rewarded work on the latest scored day, independent of the PFT payout. Not the 7-day Alignment used by the directory.">
              Work quality (day) <strong style={{ color: C.ink, fontWeight: 600 }}>{workQualityScore ?? "—"}</strong><span style={{ color: C.ink5 }}> / 100</span>
            </span>
            <span style={{ color: C.ink5 }}>·</span>
            <span data-testid="daily-airdrop-alignment-7d" title="Airdrop PFT actually received over the last 7 days as a share of the maximum possible. This is the Alignment shown in the directory and on public profiles.">
              Alignment (7d) <strong style={{ color: C.ink, fontWeight: 600 }}>{airdropAlignment7d ?? "—"}</strong><span style={{ color: C.ink5 }}> / 100</span>
            </span>
            {rewardedTasks > 0 && (
              <>
                <span style={{ color: C.ink5 }}>·</span>
                <span>{fmtN(rewardedTasks)} rewarded task{rewardedTasks === 1 ? "" : "s"}</span>
              </>
            )}
          </div>
        </div>

        <RewardSparkline
          airdropCount={airdropCount}
          airdropTotal={airdropTotal}
          earnedTotal={earnedTotal}
          points={points}
          rangeLabel={rewardHistory?.range || "28d"}
          rewardTotal={rewardTotal}
          taskCount={taskCount}
          sparkPoints={sparkPoints}
          sparkW={sparkW}
          sparkH={sparkH}
        />
      </div>

      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr 1fr",
        gap: 40, paddingTop: 24, borderTop: `1px solid ${C.ruleSoft}`,
      }}>
        <Reasoning sign="↑" tone={C.success} label="What raised today" body={airdrop.whatRaisedToday || "No positive driver was recorded."} />
        <Reasoning sign="↓" tone={C.warning} label="What kept it lower" body={airdrop.whatKeptItLower || "No limiting factor was recorded."} />
        <Reasoning sign="→" tone={C.rust} label="To improve tomorrow" body={airdrop.toImproveTomorrow || "No next-step recommendation was recorded."} />
      </div>

      {reasoningOpen && (
        <div className="tn-fadeIn" style={{
          borderTop: `1px solid ${C.ruleSoft}`,
          color: C.ink2,
          fontSize: 13.5,
          lineHeight: 1.6,
          marginTop: 24,
          paddingTop: 18,
          maxWidth: 760,
        }}>
          {airdrop.reasoningText}
        </div>
      )}
    </section>
  );
}

export function RewardSparkline({
  airdropCount = 0,
  airdropTotal = 0,
  earnedTotal = 0,
  points = [],
  rangeLabel = "28d",
  rewardTotal = 0,
  taskCount = 0,
  sparkPoints = "",
  sparkW = 260,
  sparkH = 56,
}) {
  const nonZero = points.some((point) => Number(point.total || 0) > 0);
  const totals = points.map((point) => Number(point.total || 0));
  const maxSpark = Math.max(1, ...totals);
  const line = sparkPoints || points.map((point, i) => {
    const x = points.length <= 1 ? sparkW : (i / (points.length - 1)) * sparkW;
    const y = sparkH - (Number(point.total || 0) / maxSpark) * sparkH + 2;
    return `${x},${y}`;
  }).join(" ");
  const lastTotal = totals[totals.length - 1] || 0;
  return (
    <div>
      <div className="tn-eyebrow" style={{ marginBottom: 8, textAlign: "right" }}>Last {rangeLabel.replace("d", " days")}</div>
      {nonZero ? (
        <>
          <svg viewBox={`0 0 ${sparkW} ${sparkH + 4}`} width="100%" height={sparkH + 4} style={{ display: "block", overflow: "visible" }}>
            <polyline points={line} fill="none" stroke={C.ink} strokeWidth="1.4" />
            <circle cx={sparkW} cy={sparkH - (lastTotal / maxSpark) * sparkH + 2} r="3.5" fill={C.rust} />
          </svg>
          <div style={{ color: C.ink4, fontSize: 12, marginTop: 8, textAlign: "right" }}>
            {fmtPft(earnedTotal || rewardTotal + airdropTotal)} PFT · {fmtPft(airdropTotal)} airdrops · {fmtPft(rewardTotal)} rewards
            {airdropCount > 0 ? ` · ${fmtN(airdropCount)} airdrop${airdropCount === 1 ? "" : "s"}` : ""}
            {taskCount > 0 ? ` · ${fmtN(taskCount)} task${taskCount === 1 ? "" : "s"}` : ""}
          </div>
        </>
      ) : (
        <div style={{ color: C.ink4, fontSize: 13, lineHeight: 1.5, textAlign: "right" }}>
          No paid task rewards in this range.
        </div>
      )}
    </div>
  );
}

export function Reasoning({ sign, tone, label, body }) {
  return (
    <div>
      <div style={{
        fontSize: 11, fontWeight: 600, letterSpacing: "0.14em",
        textTransform: "uppercase", color: tone, marginBottom: 8,
      }}>
        <span style={{ fontSize: 13, marginRight: 4 }}>{sign}</span>{label}
      </div>
      <div style={{ fontSize: 13.5, color: C.ink2, lineHeight: 1.55 }}>{body}</div>
    </div>
  );
}

export function profileNftStatus(nft = {}) {
  return String(nft?.status || "").trim().toLowerCase();
}

export function profileNftIsGenerating(nft = {}) {
  return profileNftStatus(nft) === "generating";
}

export function profileNftFailed(nft = {}) {
  return profileNftStatus(nft) === "failed";
}

export function profileNftCanBecomeAvatar(nft = {}) {
  const status = profileNftStatus(nft);
  return Boolean(nft?.imageCid || nft?.imageDataUrl || nft?.imageGatewayUrl) &&
    status !== "generating" &&
    status !== "failed";
}

export function profileNftCreatedTime(nft = {}) {
  const date = new Date(nft?.createdAt || nft?.generatedAt || nft?.mintedAt || 0);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

export function latestAvatarNft(nfts = []) {
  const eligible = (Array.isArray(nfts) ? nfts : []).filter(profileNftCanBecomeAvatar);
  return eligible.find((nft) => nft.selected) || eligible
    .sort((left, right) => profileNftCreatedTime(right) - profileNftCreatedTime(left))[0] || null;
}

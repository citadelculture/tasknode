import { ExpandableProfileImage } from "./ExpandableProfileImage.jsx";
import { ProfilePortrait, ProfileArtTraits } from "./ProfilePortrait.jsx";
import { PROFILE_NFT_TITLE } from "../../../shared/profile-nft-art.js";
import React, { useEffect, useMemo, useState } from "react";
import {
  Bot,
  Bug,
  Clapperboard,
  ClipboardList,
  Crown,
  GitMerge,
  GitPullRequest,
  GraduationCap,
  Megaphone,
  Server,
  User,
} from "lucide-react";
import { requestJson } from "../../api";
import { profileNftImageCandidates } from "./profile-nft-images.js";

const C = {
  paper2: "var(--tn-dark-profile-surface, #FBF7EE)",
  ink: "var(--tn-dark-text, #1F1B16)",
  ink2: "var(--tn-dark-secondary, #3D362C)",
  ink3: "var(--tn-dark-secondary, #6B6052)",
  ink4: "var(--tn-dark-muted, #9B9081)",
  ink5: "var(--tn-dark-muted, #C4BBA9)",
  ruleSoft: "var(--tn-dark-border, #EFE7D6)",
  success: "var(--tn-dark-success, #5C8C4F)",
  warning: "var(--tn-dark-warning, #B07628)",
};

const fmtN = (n, options = {}) => Number(n || 0).toLocaleString("en-US", options);
const fmtPft = (n) => fmtN(n, { maximumFractionDigits: Number(n || 0) % 1 === 0 ? 0 : 2 });
const fmtDate = d => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
const fmtDateTime = (value = "") => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};
const NFT_GALLERY_PAGE_SIZE = 10;
const contributionLevelLabel = (tierNumber) => {
  const tier = Number(tierNumber || 0);
  if (tier >= 4) return "Network operator";
  if (tier >= 3) return "Core contributor";
  if (tier >= 2) return "Active contributor";
  if (tier >= 1) return "Contributor";
  return "Not established";
};
const badgeIconMap = {
  bot: Bot,
  bug: Bug,
  clapperboard: Clapperboard,
  clipboard_list: ClipboardList,
  crown: Crown,
  git_merge: GitMerge,
  git_pull_request: GitPullRequest,
  graduation_cap: GraduationCap,
  megaphone: Megaphone,
  server: Server,
  user: User,
};

function imageCandidatesForNft(nft = {}) {
  return profileNftImageCandidates(nft);
}

function SectionHead({ eyebrow, sub }) {
  return (
    <div style={{
      alignItems: "baseline",
      borderBottom: `1px solid ${C.ruleSoft}`,
      display: "flex",
      justifyContent: "space-between",
      marginBottom: 28,
      paddingBottom: 14,
    }}>
      <div>
        <div className="tn-eyebrow">{eyebrow}</div>
        {sub && <div style={{ color: C.ink3, fontSize: 13, marginTop: 4 }}>{sub}</div>}
      </div>
    </div>
  );
}

function PublicBadgeStrip({ badges = [] } = {}) {
  const visibleBadges = Array.isArray(badges)
    ? badges.filter((badge) => badge?.badgeId && badge?.label).slice(0, 8)
    : [];
  if (!visibleBadges.length) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
      {visibleBadges.map((badge) => {
        const Icon = badgeIconMap[badge.symbolKey] || User;
        const cap = Number(badge.maxPayoutPft || 0);
        const capLabel = cap > 0 ? ` · cap ${fmtPft(cap)} PFT` : "";
        return (
          <span
            key={badge.badgeId}
            title={badge.publicDescription || badge.label}
            style={{
              alignItems: "center",
              background: C.paper2,
              border: `1px solid ${C.ruleSoft}`,
              borderRadius: 999,
              color: C.ink2,
              display: "inline-flex",
              fontSize: 12.5,
              fontWeight: 650,
              gap: 7,
              lineHeight: 1,
              minHeight: 30,
              padding: "7px 10px",
            }}
          >
            <Icon aria-hidden="true" size={14} strokeWidth={2.2} />
            {badge.label}
            <span style={{ color: C.ink4, fontWeight: 550 }}>{capLabel}</span>
          </span>
        );
      })}
    </div>
  );
}

function IdentityHero({ profile = null, loading = false, profilePublic = true }) {
  const identity = profile?.identity || {};
  const metrics = profile?.metrics || {};
  const displayWallet = identity.displayWallet || identity.primaryWallet || "";
  const displayHandle = identity.hiveHandle ? `@${identity.hiveHandle}` : "";
  const displayName = identity.displayName || displayHandle || "Hive contributor";
  const publicAliases = Array.isArray(identity.publicAliases) ? identity.publicAliases : [];
  const networkBadges = Array.isArray(identity.networkBadges) ? identity.networkBadges : [];
  const operatorDisclosure = identity.operatorDisclosure || null;
  const totalPft = metrics.lifetimeTotalPft || 0;
  const taskPft = metrics.lifetimeTaskRewardPft || 0;
  const airdropPft = metrics.lifetimeAirdropPft || 0;
  const snapshot = profile?.snapshot || null;
  return (
    <section style={{ paddingTop: 8 }}>
      <div className="tn-profile-identity" style={{ alignItems: "center", display: "grid" }}>
        <div>
          <ExpandableProfileImage nft={profile?.heroNft} label="Expand profile picture">
            <ProfilePortrait nft={profile?.heroNft} seed={profile?.accountId || identity.hiveHandle || identity.displayName} size="var(--profile-portrait-size, 120px)" fullResolution />
          </ExpandableProfileImage>
          <ProfileArtTraits nft={profile?.heroNft} />
        </div>

        <div>
          <div className="tn-eyebrow" style={{ marginBottom: 6 }}>Hive profile</div>
          <div style={{ alignItems: "center", display: "flex", gap: 12, marginBottom: 12 }}>
            <span style={{ color: C.ink, fontSize: 22, fontWeight: 600 }}>
              {loading ? "Loading profile..." : displayName}
            </span>
            {displayHandle && displayHandle !== displayName && (
              <span className="tn-mono" style={{ color: C.ink3, fontSize: 14 }}>
                {displayHandle}
              </span>
            )}
            {operatorDisclosure?.isMachineOperator && (
              <span style={{ border: `1px solid ${C.ruleSoft}`, borderRadius: 999, color: C.ink2, fontSize: 12, fontWeight: 700, padding: "4px 8px", textTransform: "uppercase" }}>
                {operatorDisclosure.label || "Orc operator"}
              </span>
            )}
            {displayHandle && (
              <button
                className="tn-btn"
                onClick={() => navigator.clipboard?.writeText(displayHandle).catch(() => null)}
                style={{ padding: 4 }}
                title="Copy handle"
                type="button"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              </button>
            )}
          </div>
          <div style={{ alignItems: "center", color: C.ink3, display: "flex", flexWrap: "wrap", fontSize: 13, gap: 12 }}>
            <span style={{ alignItems: "center", color: profilePublic ? C.success : C.ink4, display: "inline-flex", fontWeight: 500, gap: 7 }}>
              <span className="tn-pulseGreen" />
              {profilePublic ? "Public profile enabled" : "Public profile hidden"}
            </span>
            {displayWallet && (
              <>
                <span style={{ color: C.ink5 }}>·</span>
                <span className="tn-mono">{displayWallet}</span>
              </>
            )}
            {publicAliases.map((alias) => (
              <React.Fragment key={`${alias.provider}-${alias.handle || alias.label}`}>
                <span style={{ color: C.ink5 }}>·</span>
                <span>
                  {alias.label}
                  {alias.handle ? ` @${alias.handle}` : ""}
                  {alias.verified ? " verified" : ""}
                </span>
              </React.Fragment>
            ))}
            {snapshot?.completedAt && (
              <>
                <span style={{ color: C.ink5 }}>·</span>
                <span>Profile refreshed {fmtDateTime(snapshot.completedAt)}</span>
              </>
            )}
          </div>
          <PublicBadgeStrip badges={networkBadges} />
        </div>

        <div className="tn-profile-lifetime" style={{ textAlign: "right" }}>
          <div className="tn-eyebrow" style={{ marginBottom: 6 }}>Total lifetime</div>
          <div className="tn-bigNum" style={{ color: C.ink, fontSize: 42, lineHeight: 1 }}>{loading ? "—" : fmtPft(totalPft)}</div>
          <div style={{ color: C.ink4, fontSize: 13, marginTop: 4 }}>
            PFT earned
            {!loading && <span> · {fmtPft(taskPft)} rewards · {fmtPft(airdropPft)} airdrops</span>}
          </div>
        </div>
      </div>
    </section>
  );
}

function ProfileRole({ role = null, snapshot = null, loading = false, error = "", regenerating = false, onRegenerate, showRegenerate = true }) {
  const skills = Array.isArray(role?.skills) ? role.skills.filter(Boolean) : [];
  return (
    <section style={{ paddingTop: 56 }}>
      <div className="tn-profile-role" style={{
        alignItems: "start",
        display: "grid",

        justifyContent: "space-between",
      }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ color: C.ink, fontSize: 26, fontWeight: 600, letterSpacing: "-0.015em", lineHeight: 1.22, margin: "0 0 14px", maxWidth: 720 }}>
            {loading ? "Loading public profile..." : role?.roleTitle || "Profile snapshot pending"}
          </h3>
          <div style={{ color: C.ink2, fontSize: 15.5, lineHeight: 1.62, marginBottom: 18, maxWidth: 720 }}>
            {role?.roleSummary || (error ? error : "Run a public profile snapshot after task rewards or NFT activity exists.")}
          </div>
          {skills.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: role?.usefulTo ? 18 : 0 }}>
              {skills.map((skill, index) => (
                <span
                  key={`${skill}-${index}`}
                  style={{
                    background: C.paper2,
                    border: `1px solid ${C.ruleSoft}`,
                    borderRadius: 999,
                    color: C.ink2,
                    display: "inline-flex",
                    fontSize: 12.5,
                    fontWeight: 500,
                    lineHeight: 1,
                    padding: "7px 10px",
                  }}
                >
                  {skill}
                </span>
              ))}
            </div>
          )}
          {role?.usefulTo && (
            <div style={{ borderLeft: `2px solid ${C.ruleSoft}`, color: C.ink3, fontSize: 13.5, lineHeight: 1.55, marginTop: 2, maxWidth: 700, paddingLeft: 12 }}>
              <span style={{ color: C.ink4, fontWeight: 600 }}>Best fit: </span>
              {role.usefulTo}
            </div>
          )}
          {role?.dataCaveat && (
            <div style={{ color: C.ink4, fontSize: 12.5, lineHeight: 1.5, marginTop: 12, maxWidth: 680 }}>
              {role.dataCaveat}
            </div>
          )}
        </div>

        <div style={{ minWidth: 0, paddingTop: 2, textAlign: "right" }}>
          <div className="tn-eyebrow" style={{ marginBottom: 6 }}>Archetype</div>
          <div style={{ color: C.ink2, fontSize: 13.5, fontWeight: 500 }}>{role?.archetype || "Not scored"}</div>
          {role?.archetypeContrast && <div style={{ color: C.ink4, fontSize: 12.5, marginTop: 2 }}>{role.archetypeContrast}</div>}
          {showRegenerate && (
            <button
              className="tn-btn"
              disabled={regenerating}
              onClick={onRegenerate}
              style={{ fontSize: 12.5, marginTop: 14, padding: 0 }}
              type="button"
            >
              {regenerating ? "Regenerating..." : snapshot?.completedAt ? "Refresh profile" : "Generate profile"}
            </button>
          )}
          {snapshot?.model && <div style={{ color: C.ink4, fontSize: 11.5, marginTop: 8 }}>{snapshot.model}</div>}
        </div>
      </div>
    </section>
  );
}

function CredentialStrip({ metrics = {}, loading = false }) {
  const alignment = metrics.alignmentScore0To100;
  const hasAlignment = alignment !== null && alignment !== undefined && Number.isFinite(Number(alignment));
  const items = [
    {
      label: "Alignment (7d)",
      max: "100",
      score: loading ? "—" : hasAlignment ? String(Math.round(Number(alignment))) : "—",
      status: hasAlignment ? "7-day airdrop share" : "Not scored yet",
      sub: hasAlignment
        ? `${fmtPft(metrics.actualAirdropPft7d)} of ${fmtPft(metrics.maxPossibleAirdropPft7d)} possible airdrop PFT over the last 7 days`
        : "Run a daily airdrop score to populate alignment.",
      tone: hasAlignment ? C.success : C.ink4,
    },
    {
      label: "Contribution level",
      score: loading ? "—" : contributionLevelLabel(metrics.contributionTierNumber),
      status: metrics.contributionTierBasis || "No contribution tier yet",
      sub: "Calculated from positive task rewards, not airdrops.",
      tone: Number(metrics.contributionTierNumber || 0) >= 2 ? C.warning : C.ink4,
      wide: true,
    },
  ];
  return (
    <section style={{ paddingTop: 64 }}>
      <div className="tn-profile-credentials" style={{ borderTop: `1px solid ${C.ruleSoft}`, display: "grid", paddingTop: 22 }}>
        {items.map((item) => (
          <div key={item.label}>
            <div className="tn-eyebrow">{item.label}</div>
            <div style={{ alignItems: "baseline", display: "flex", gap: 8, marginTop: 12 }}>
              <span
                className="tn-bigNum"
                style={{
                  color: C.ink,
                  fontSize: item.wide ? 30 : 42,
                  letterSpacing: item.wide ? 0 : undefined,
                  lineHeight: 1.05,
                }}
              >
                {item.score}
              </span>
              {item.max && <span style={{ color: C.ink5, fontSize: 14, fontWeight: 500 }}>/ {item.max}</span>}
            </div>
            <div style={{ color: item.tone, fontSize: 13, fontWeight: 500, marginTop: 10 }}>{item.status}</div>
            <div style={{ color: C.ink3, fontSize: 12.5, lineHeight: 1.45, marginTop: 6 }}>{item.sub}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function PublicNFTTile({ nft }) {
  const imageCandidates = useMemo(() => imageCandidatesForNft(nft), [nft]);
  const [imageIndex, setImageIndex] = useState(0);
  const imageSrc = imageCandidates[imageIndex] || "";
  const selected = nft.selected === true;

  useEffect(() => {
    setImageIndex(0);
  }, [imageCandidates]);

  return (
    <div className="tn-lift">
      <ExpandableProfileImage nft={nft} disabled={!imageSrc} style={{ width: "100%", aspectRatio: "1 / 1", background: C.paper2, borderRadius: 12, marginBottom: 10, overflow: "hidden", position: "relative" }}>
        {selected && (
          <div style={{
            background: "var(--tn-dark-inverse-surface, rgba(31, 27, 22, 0.78))",
            borderRadius: 999,
            color: C.paper3,
            fontSize: 11,
            fontWeight: 650,
            left: 10,
            lineHeight: 1,
            padding: "7px 9px",
            position: "absolute",
            top: 10,
            zIndex: 2,
          }}>
            Profile picture
          </div>
        )}
        {imageSrc ? (
          <img
            alt={nft.title || "Profile NFT"}
            decoding="async"
            loading="lazy"
            onError={() => setImageIndex((index) => index + 1)}
            src={imageSrc}
            style={{ display: "block", height: "100%", objectFit: "cover", width: "100%" }}
          />
        ) : (
          <div style={{
            alignItems: "center",
            border: `1px solid ${C.ruleSoft}`,
            color: C.ink4,
            display: "flex",
            fontSize: 12,
            height: "100%",
            justifyContent: "center",
          }}>
            Image unavailable
          </div>
        )}
      </ExpandableProfileImage>
      <div style={{ color: C.ink, fontSize: 13.5, fontWeight: 600, letterSpacing: "-0.005em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {nft.title || PROFILE_NFT_TITLE}
      </div>
      <div style={{ color: C.ink4, display: "flex", fontSize: 11.5, gap: 8, marginTop: 3 }}>
        <span>{nft.mintedAt ? fmtDate(new Date(nft.mintedAt)) : nft.generatedAt ? fmtDate(new Date(nft.generatedAt)) : "Generated"}</span>
        <span style={{ color: C.ink5 }}>·</span>
        <span>{nft.status || "generated"}</span>
      </div>
    </div>
  );
}

function PublicNFTGallery({ nfts = [], total = null }) {
  const [page, setPage] = useState(0);
  const mintedCount = nfts.filter((nft) => String(nft.status || "").toLowerCase() === "minted").length;
  const totalCount = Number.isFinite(Number(total)) ? Number(total) : nfts.length;
  const countLabel = totalCount > nfts.length ? `${nfts.length} of ${totalCount}` : `${totalCount}`;
  const pageCount = Math.max(1, Math.ceil(nfts.length / NFT_GALLERY_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const start = currentPage * NFT_GALLERY_PAGE_SIZE;
  const visibleNfts = nfts.slice(start, start + NFT_GALLERY_PAGE_SIZE);
  const showingStart = nfts.length ? start + 1 : 0;
  const showingEnd = Math.min(nfts.length, start + visibleNfts.length);

  useEffect(() => {
    setPage(0);
  }, [nfts.length]);

  useEffect(() => {
    if (page >= pageCount) setPage(pageCount - 1);
  }, [page, pageCount]);

  return (
    <section style={{ paddingTop: 64 }}>
      <SectionHead
        eyebrow="NFT gallery"
        sub={`${countLabel} profile NFTs · ${mintedCount} minted${nfts.length > NFT_GALLERY_PAGE_SIZE ? ` · showing ${showingStart}-${showingEnd}` : ""}`}
      />
      {nfts.length > 0 ? (
        <>
          <div style={{ display: "grid", gap: 32, gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}>
            {visibleNfts.map((nft) => <PublicNFTTile key={nft.id} nft={nft} />)}
          </div>
          {pageCount > 1 && (
            <div style={{ alignItems: "center", display: "flex", gap: 18, justifyContent: "space-between", marginTop: 24 }}>
              <div style={{ color: C.ink4, fontSize: 12.5 }}>
                Page {currentPage + 1} of {pageCount}
              </div>
              <div style={{ display: "flex", gap: 14 }}>
                <button
                  className="tn-tab"
                  disabled={currentPage === 0}
                  onClick={() => setPage((value) => Math.max(0, value - 1))}
                  style={{ fontSize: 12.5, opacity: currentPage === 0 ? 0.45 : 1 }}
                  type="button"
                >
                  Prev
                </button>
                <button
                  className="tn-tab"
                  disabled={currentPage >= pageCount - 1}
                  onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}
                  style={{ fontSize: 12.5, opacity: currentPage >= pageCount - 1 ? 0.45 : 1 }}
                  type="button"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        <div style={{ borderTop: `1px solid ${C.ruleSoft}`, color: C.ink3, fontSize: 13.5, lineHeight: 1.55, paddingTop: 18 }}>
          Your profile picture is generated automatically after three completed tasks.
        </div>
      )}
    </section>
  );
}

export function PublicProfile({ accountId = "", profilePublic = true, profileSource = "self" } = {}) {
  const [state, setState] = useState({
    loading: Boolean(accountId),
    error: "",
    profile: null,
    regenerating: false,
  });
  const memberProfile = profileSource === "member";
  const profilePath = memberProfile
    ? `/api/profile/member?accountId=${encodeURIComponent(accountId)}`
    : "/api/profile/public";

  const loadProfile = async () => {
    if (!accountId) {
      setState({ loading: false, error: "", profile: null, regenerating: false });
      return;
    }
    setState((current) => ({ ...current, loading: true, error: "" }));
    const result = await requestJson(profilePath);
    if (result.ok) {
      setState((current) => ({ ...current, loading: false, error: "", profile: result.body?.profile || null }));
      return;
    }
    setState((current) => ({
      ...current,
      loading: false,
      error: result.body?.message || result.body?.error || "Public profile could not be loaded.",
    }));
  };

  useEffect(() => {
    let cancelled = false;
    if (!accountId) {
      setState({ loading: false, error: "", profile: null, regenerating: false });
      return () => {
        cancelled = true;
      };
    }
    setState((current) => ({ ...current, loading: true, error: "" }));
    requestJson(profilePath).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setState((current) => ({ ...current, loading: false, error: "", profile: result.body?.profile || null }));
        return;
      }
      setState((current) => ({
        ...current,
        loading: false,
        error: result.body?.message || result.body?.error || "Public profile could not be loaded.",
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [accountId, profilePath]);

  const regenerate = async () => {
    if (!accountId || memberProfile || state.regenerating) return;
    setState((current) => ({ ...current, regenerating: true, error: "" }));
    const result = await requestJson("/api/profile/public/regenerate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    if (result.ok) {
      setState((current) => ({
        ...current,
        regenerating: false,
        profile: result.body?.profile || current.profile,
        error: "",
      }));
      await loadProfile();
      return;
    }
    setState((current) => ({
      ...current,
      regenerating: false,
      error: result.body?.message || result.body?.error || "Public profile regeneration failed.",
    }));
  };

  const profile = state.profile || null;
  const role = profile?.role || null;
  return (
    <div>
      <IdentityHero loading={state.loading} profile={profile} profilePublic={profilePublic} />
      <ProfileRole
        error={state.error}
        loading={state.loading}
        onRegenerate={regenerate}
        regenerating={state.regenerating}
        role={role}
        showRegenerate={!memberProfile}
        snapshot={profile?.snapshot || null}
      />
      <CredentialStrip loading={state.loading} metrics={profile?.metrics || {}} />
      <PublicNFTGallery nfts={profile?.nfts || []} total={profile?.nftTotal} />
    </div>
  );
}

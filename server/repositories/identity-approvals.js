import { createHash } from "node:crypto";
import { databaseEnabled, query, transaction } from "../db/pool.js";
import { networkBadgeDefinitions, networkBadgeProjectionForAccount } from "./network-badges.js";
import { getAccountIdentityProfile } from "./account-profiles.js";

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value = "") {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value), "utf8").digest("hex");
}

function stableId(prefix = "id", parts = []) {
  return `${prefix}_${digest(parts.join(":")).slice(0, 32)}`;
}

function defaultProviderForBadge(badgeId = "") {
  if (badgeId === "kol") return "x";
  if (badgeId === "core_contributor") return "github";
  if (badgeId === "qa_worker") return "discord";
  if (badgeId === "project_leader") return "hive";
  return "tasknode";
}

export function manualBadgeApprovalRecords({
  accountId = "",
  badgeId = "",
  provider = "",
  publicHandle = "",
  profileUrl = "",
  approvalLevel = "",
  approvalScope = "",
  approvedByAccountId = "",
  approvedByOperator = "operator_manual_approval",
  evidence = {},
  metrics = {},
  selectedDefault = false,
} = {}) {
  const normalizedAccountId = safeText(accountId, 180);
  const normalizedBadgeId = safeText(badgeId, 80);
  const normalizedProvider = safeText(provider || defaultProviderForBadge(normalizedBadgeId), 80).toLowerCase();
  const normalizedScope = safeText(approvalScope || `badge:${normalizedBadgeId}`, 180);
  const normalizedHandle = safeText(publicHandle, 180);
  const normalizedApprovalLevel = safeText(approvalLevel || approvalLevelForBadge(normalizedBadgeId), 80);
  const evidenceJson = {
    source: "operator_manual_approval",
    badgeId: normalizedBadgeId,
    approvalScope: normalizedScope,
    evidence: safeObject(evidence),
  };
  const metricsJson = safeObject(metrics);
  return {
    schema: "pf.task_node.manual_badge_approval_records.v1",
    accountId: normalizedAccountId,
    badgeId: normalizedBadgeId,
    identityApproval: {
      id: stableId("iap", [normalizedAccountId, normalizedProvider, normalizedScope]),
      accountId: normalizedAccountId,
      provider: normalizedProvider,
      providerUserIdHash: normalizedHandle ? `sha256:${digest(`${normalizedProvider}:${normalizedHandle.toLowerCase()}`)}` : "",
      publicHandle: normalizedHandle,
      profileUrl: safeText(profileUrl, 500),
      approvalLevel: normalizedApprovalLevel,
      approvalScope: normalizedScope,
      status: "active",
      approvedByAccountId: safeText(approvedByAccountId, 180),
      approvedByOperator: safeText(approvedByOperator, 120),
      evidenceJson,
      metricsJson,
    },
    accountBadge: {
      id: stableId("anb", [normalizedAccountId, normalizedBadgeId]),
      accountId: normalizedAccountId,
      badgeId: normalizedBadgeId,
      status: "verified",
      publicVisible: true,
      selectedDefault: selectedDefault === true,
      verifiedByAccountId: safeText(approvedByAccountId, 180),
      verifiedByOperator: safeText(approvedByOperator, 120),
      evidenceTaskId: safeText(safeObject(evidence).taskId || safeObject(evidence).task_id, 180),
      evidenceUrlOrRef: safeText(safeObject(evidence).url || safeObject(evidence).ref || safeObject(evidence).evidenceRef, 500),
      evidenceJson,
      validatedMetricsJson: metricsJson,
    },
  };
}

function approvalProviderForBadge(badgeId = "") {
  if (badgeId === "kol") return "x";
  if (badgeId === "core_contributor") return "github";
  if (badgeId === "project_leader") return "hive";
  return "tasknode";
}

function approvalLevelForBadge(badgeId = "") {
  if (badgeId === "project_leader") return "L4";
  return "L3";
}

function publicHandleForBadge(badge = {}) {
  const evidence = safeObject(badge.evidence);
  if (badge.badgeId === "expert") return safeText(evidence.topic, 160);
  return safeText(
    evidence.handle ||
      evidence.username ||
      evidence.matchedHandle ||
      evidence.publicHandle ||
      "",
    160
  );
}

function profileUrlForBadge(badge = {}) {
  const evidence = safeObject(badge.evidence);
  return safeText(evidence.profileUrl || evidence.profile_url || "", 500);
}

function metricsForBadge(badge = {}) {
  const evidence = safeObject(badge.evidence);
  const metrics = {};
  if (Number.isFinite(Number(evidence.followersCount))) {
    metrics.followersCount = Number(evidence.followersCount);
  }
  if (Number.isFinite(Number(evidence.score))) {
    metrics.score = Number(evidence.score);
  }
  if (Number.isFinite(Number(evidence.personalTaskCount))) {
    metrics.personalTaskCount = Number(evidence.personalTaskCount);
  }
  if (evidence.topic) metrics.topic = safeText(evidence.topic, 160);
  if (evidence.proofMethod) metrics.proofMethod = safeText(evidence.proofMethod, 160);
  return metrics;
}

export function approvalRecordsFromNetworkBadgeProjection({
  projection = {},
  verifiedByAccountId = "",
  verifiedByOperator = "runtime_projection_refresh",
  selectedDefaultBadgeId = "",
} = {}) {
  const accountId = safeText(projection.accountId, 180);
  const badges = safeArray(projection.verifiedBadges)
    .filter((badge) => networkBadgeDefinitions[safeText(badge.badgeId, 80)]);
  const preservedDefaultBadgeId = safeText(selectedDefaultBadgeId, 80);
  const identityApprovals = [];
  const accountBadges = [];
  badges.forEach((badge) => {
    const badgeId = safeText(badge.badgeId, 80);
    const provider = approvalProviderForBadge(badgeId);
    const approvalScope = `badge:${badgeId}`;
    const publicHandle = publicHandleForBadge(badge);
    if (badgeId === "kol" && !publicHandle) return;
    const evidence = {
      source: "runtime_projection_refresh",
      badgeId,
      catalogVersion: safeText(projection.catalogVersion, 80),
      projectionSource: safeText(projection.source, 80),
      evidence: safeObject(badge.evidence),
    };
    const metrics = metricsForBadge(badge);
    identityApprovals.push({
      id: stableId("iap", [accountId, provider, approvalScope]),
      accountId,
      provider,
      providerUserIdHash: publicHandle ? `sha256:${digest(`${provider}:${publicHandle.toLowerCase()}`)}` : "",
      publicHandle,
      profileUrl: profileUrlForBadge(badge),
      approvalLevel: approvalLevelForBadge(badgeId),
      approvalScope,
      status: "active",
      approvedByAccountId: safeText(verifiedByAccountId, 180),
      approvedByOperator: safeText(verifiedByOperator, 120),
      evidenceJson: evidence,
      metricsJson: metrics,
    });
    accountBadges.push({
      id: stableId("anb", [accountId, badgeId]),
      accountId,
      badgeId,
      status: "verified",
      publicVisible: true,
      // Keep the account's existing selection; only a first-ever materialization
      // picks a default, and then the first badge that actually materialized.
      selectedDefault: preservedDefaultBadgeId
        ? badgeId === preservedDefaultBadgeId
        : accountBadges.length === 0,
      verifiedByAccountId: safeText(verifiedByAccountId, 180),
      verifiedByOperator: safeText(verifiedByOperator, 120),
      evidenceTaskId: "",
      evidenceUrlOrRef: "",
      evidenceJson: evidence,
      validatedMetricsJson: metrics,
    });
  });
  return {
    schema: "pf.task_node.identity_approval_materialization.v1",
    accountId,
    badgeIds: accountBadges.map((badge) => badge.badgeId),
    identityApprovals,
    accountBadges,
  };
}

function ensureDatabase() {
  if (databaseEnabled()) return;
  const error = new Error("identity_approvals_database_not_configured");
  error.status = 503;
  throw error;
}

async function listIdentityApprovals({ accountId = "" } = {}) {
  const result = await query(
    `
      SELECT
        id,
        provider,
        public_handle,
        profile_url,
        approval_level,
        approval_scope,
        status,
        approved_by_operator,
        metrics_json,
        expires_at,
        revoked_at,
        revocation_reason,
        created_at,
        updated_at
      FROM account_identity_approvals
      WHERE account_id = $1
      ORDER BY status ASC, approval_level DESC, updated_at DESC, id ASC
      LIMIT 200
    `,
    [accountId]
  );
  return result.rows.map((row) => ({
    id: safeText(row.id, 180),
    provider: safeText(row.provider, 80),
    publicHandle: safeText(row.public_handle, 180),
    profileUrl: safeText(row.profile_url, 500),
    approvalLevel: safeText(row.approval_level, 80),
    approvalScope: safeText(row.approval_scope, 180),
    status: safeText(row.status, 80),
    approvedByOperator: safeText(row.approved_by_operator, 120),
    metrics: safeObject(row.metrics_json),
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revocationReason: safeText(row.revocation_reason, 500),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

async function listNetworkBadges({ accountId = "" } = {}) {
  const result = await query(
    `
      SELECT
        badge.id,
        badge.badge_id,
        badge.status,
        badge.public_visible,
        badge.selected_default,
        badge.verified_by_operator,
        badge.validated_metrics_json,
        badge.expires_at,
        badge.revoked_at,
        badge.revocation_reason,
        badge.updated_at,
        definition.label,
        definition.symbol_key,
        definition.max_payout_pft::text AS max_payout_pft,
        definition.allowed_work_types_json
      FROM account_network_badges badge
      LEFT JOIN network_badge_definitions definition
        ON definition.badge_id = badge.badge_id
      WHERE badge.account_id = $1
      ORDER BY badge.selected_default DESC, badge.status ASC, badge.updated_at DESC, badge.badge_id ASC
      LIMIT 100
    `,
    [accountId]
  );
  return result.rows.map((row) => ({
    id: safeText(row.id, 180),
    badgeId: safeText(row.badge_id, 80),
    label: safeText(row.label, 120),
    symbolKey: safeText(row.symbol_key, 80),
    status: safeText(row.status, 80),
    publicVisible: row.public_visible === true,
    selectedDefault: row.selected_default === true,
    verifiedByOperator: safeText(row.verified_by_operator, 120),
    maxPayoutPft: Number(row.max_payout_pft || 0),
    allowedWorkTypes: safeArray(row.allowed_work_types_json),
    metrics: safeObject(row.validated_metrics_json),
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revocationReason: safeText(row.revocation_reason, 500),
    updatedAt: row.updated_at,
  }));
}

export async function getIdentityApprovalState({ accountId = "" } = {}) {
  const normalizedAccountId = safeText(accountId, 180);
  if (!normalizedAccountId) {
    const error = new Error("identity_approvals_account_required");
    error.status = 400;
    throw error;
  }
  if (!databaseEnabled()) {
    return {
      schema: "pf.task_node.identity_approval_state.v1",
      accountId: normalizedAccountId,
      database: { enabled: false },
      identityProfile: await getAccountIdentityProfile({ accountId: normalizedAccountId }),
      approvals: [],
      badges: [],
    };
  }
  const [approvals, badges, identityProfile] = await Promise.all([
    listIdentityApprovals({ accountId: normalizedAccountId }),
    listNetworkBadges({ accountId: normalizedAccountId }),
    getAccountIdentityProfile({ accountId: normalizedAccountId }),
  ]);
  return {
    schema: "pf.task_node.identity_approval_state.v1",
    accountId: normalizedAccountId,
    database: { enabled: true },
    identityProfile,
    approvals,
    badges,
  };
}

export async function setDefaultNetworkBadge({
  accountId = "",
  badgeId = "",
} = {}) {
  ensureDatabase();
  const normalizedAccountId = safeText(accountId, 180);
  const normalizedBadgeId = safeText(badgeId, 80);
  if (!normalizedAccountId || !normalizedBadgeId) {
    const error = new Error("network_badge_default_required");
    error.status = 400;
    throw error;
  }
  await transaction(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`network_badge_default:${normalizedAccountId}`]
    );
    const existing = await client.query(
      `
        SELECT 1
        FROM account_network_badges
        WHERE account_id = $1
          AND badge_id = $2
          AND status = 'verified'
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())
        LIMIT 1
      `,
      [normalizedAccountId, normalizedBadgeId]
    );
    if (!existing.rows[0]) {
      const error = new Error("network_badge_default_not_verified");
      error.status = 404;
      throw error;
    }
    await client.query(
      `
        UPDATE account_network_badges
        SET selected_default = false,
            updated_at = now()
        WHERE account_id = $1
      `,
      [normalizedAccountId]
    );
    await client.query(
      `
        UPDATE account_network_badges
        SET selected_default = true,
            updated_at = now()
        WHERE account_id = $1
          AND badge_id = $2
      `,
      [normalizedAccountId, normalizedBadgeId]
    );
  });
  return {
    ok: true,
    state: await getIdentityApprovalState({ accountId: normalizedAccountId }),
  };
}

export async function approveNetworkBadge({
  accountId = "",
  badgeId = "",
  provider = "",
  publicHandle = "",
  profileUrl = "",
  approvalLevel = "",
  approvalScope = "",
  approvedByAccountId = "",
  approvedByOperator = "operator_manual_approval",
  evidence = {},
  metrics = {},
  selectedDefault = false,
} = {}) {
  ensureDatabase();
  const normalizedAccountId = safeText(accountId, 180);
  const normalizedBadgeId = safeText(badgeId, 80);
  if (!normalizedAccountId || !normalizedBadgeId) {
    const error = new Error("network_badge_approval_account_badge_required");
    error.status = 400;
    throw error;
  }
  const records = manualBadgeApprovalRecords({
    accountId: normalizedAccountId,
    badgeId: normalizedBadgeId,
    provider,
    publicHandle,
    profileUrl,
    approvalLevel,
    approvalScope: approvalScope || `badge:${normalizedBadgeId}`,
    approvedByAccountId,
    approvedByOperator,
    evidence: {
      ...safeObject(evidence),
    },
    metrics,
    selectedDefault,
  });
  await transaction(async (client) => {
    await client.query(
      `
        INSERT INTO account_identity_approvals (
          id,
          account_id,
          provider,
          provider_user_id_hash,
          public_handle,
          profile_url,
          approval_level,
          approval_scope,
          status,
          approved_by_account_id,
          approved_by_operator,
          evidence_json,
          metrics_json,
          expires_at,
          revoked_at,
          revocation_reason,
          created_at,
          updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, 'active', $9, $10, $11::jsonb, $12::jsonb,
          NULL, NULL, '', now(), now()
        )
        ON CONFLICT (id) DO UPDATE SET
          public_handle = EXCLUDED.public_handle,
          profile_url = EXCLUDED.profile_url,
          approval_level = EXCLUDED.approval_level,
          status = 'active',
          approved_by_account_id = EXCLUDED.approved_by_account_id,
          approved_by_operator = EXCLUDED.approved_by_operator,
          evidence_json = EXCLUDED.evidence_json,
          metrics_json = EXCLUDED.metrics_json,
          expires_at = NULL,
          revoked_at = NULL,
          revocation_reason = '',
          updated_at = now()
      `,
      [
        records.identityApproval.id,
        records.identityApproval.accountId,
        records.identityApproval.provider,
        records.identityApproval.providerUserIdHash,
        records.identityApproval.publicHandle,
        records.identityApproval.profileUrl,
        records.identityApproval.approvalLevel,
        records.identityApproval.approvalScope,
        records.identityApproval.approvedByAccountId,
        records.identityApproval.approvedByOperator,
        JSON.stringify(records.identityApproval.evidenceJson),
        JSON.stringify(records.identityApproval.metricsJson),
      ]
    );
    if (records.accountBadge.selectedDefault) {
      await client.query(
        `
          UPDATE account_network_badges
          SET selected_default = false,
              updated_at = now()
          WHERE account_id = $1
        `,
        [records.accountBadge.accountId]
      );
    }
    await client.query(
      `
        INSERT INTO account_network_badges (
          id,
          account_id,
          badge_id,
          status,
          public_visible,
          selected_default,
          verified_by_account_id,
          verified_by_operator,
          evidence_task_id,
          evidence_url_or_ref,
          evidence_json,
          validated_metrics_json,
          expires_at,
          revoked_at,
          revocation_reason,
          created_at,
          updated_at
        )
        VALUES (
          $1, $2, $3, 'verified', $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb,
          NULL, NULL, '', now(), now()
        )
        ON CONFLICT (account_id, badge_id) DO UPDATE SET
          status = 'verified',
          public_visible = EXCLUDED.public_visible,
          selected_default = EXCLUDED.selected_default OR account_network_badges.selected_default,
          verified_by_account_id = EXCLUDED.verified_by_account_id,
          verified_by_operator = EXCLUDED.verified_by_operator,
          evidence_task_id = EXCLUDED.evidence_task_id,
          evidence_url_or_ref = EXCLUDED.evidence_url_or_ref,
          evidence_json = EXCLUDED.evidence_json,
          validated_metrics_json = EXCLUDED.validated_metrics_json,
          expires_at = NULL,
          revoked_at = NULL,
          revocation_reason = '',
          updated_at = now()
      `,
      [
        records.accountBadge.id,
        records.accountBadge.accountId,
        records.accountBadge.badgeId,
        records.accountBadge.publicVisible,
        records.accountBadge.selectedDefault,
        records.accountBadge.verifiedByAccountId,
        records.accountBadge.verifiedByOperator,
        records.accountBadge.evidenceTaskId,
        records.accountBadge.evidenceUrlOrRef,
        JSON.stringify(records.accountBadge.evidenceJson),
        JSON.stringify(records.accountBadge.validatedMetricsJson),
      ]
    );
  });
  return {
    ok: true,
    records,
    state: await getIdentityApprovalState({ accountId: records.accountId }),
  };
}

export async function revokeNetworkBadge({
  accountId = "",
  badgeId = "",
  reason = "",
  revokedByOperator = "operator_manual_revocation",
} = {}) {
  ensureDatabase();
  const normalizedAccountId = safeText(accountId, 180);
  const normalizedBadgeId = safeText(badgeId, 80);
  const normalizedReason = safeText(reason || "operator_revoked", 500);
  if (!normalizedAccountId || !normalizedBadgeId) {
    const error = new Error("network_badge_revocation_required");
    error.status = 400;
    throw error;
  }
  const result = await query(
    `
      UPDATE account_network_badges
      SET status = 'revoked',
          selected_default = false,
          revoked_at = now(),
          revocation_reason = $3,
          evidence_json = COALESCE(evidence_json, '{}'::jsonb) || $4::jsonb,
          updated_at = now()
      WHERE account_id = $1
        AND badge_id = $2
        AND status <> 'revoked'
      RETURNING badge_id
    `,
    [
      normalizedAccountId,
      normalizedBadgeId,
      normalizedReason,
      JSON.stringify({
        revokedByOperator: safeText(revokedByOperator, 120),
        revokedAt: new Date().toISOString(),
      }),
    ]
  );
  await query(
    `
      UPDATE account_identity_approvals
      SET status = 'revoked',
          revoked_at = now(),
          revocation_reason = $3,
          updated_at = now()
      WHERE account_id = $1
        AND approval_scope = $2
        AND status = 'active'
    `,
    [normalizedAccountId, `badge:${normalizedBadgeId}`, normalizedReason]
  );
  if (!result.rows[0]) {
    const error = new Error("network_badge_not_found_or_already_revoked");
    error.status = 404;
    throw error;
  }
  return {
    ok: true,
    state: await getIdentityApprovalState({ accountId: normalizedAccountId }),
  };
}

export async function expireNetworkBadge({
  accountId = "",
  badgeId = "",
  reason = "",
  expiredByOperator = "operator_manual_expiry",
} = {}) {
  ensureDatabase();
  const normalizedAccountId = safeText(accountId, 180);
  const normalizedBadgeId = safeText(badgeId, 80);
  const normalizedReason = safeText(reason || "operator_expired", 500);
  if (!normalizedAccountId || !normalizedBadgeId) {
    const error = new Error("network_badge_expiry_required");
    error.status = 400;
    throw error;
  }
  const result = await query(
    `
      UPDATE account_network_badges
      SET status = 'expired',
          selected_default = false,
          expires_at = now(),
          revocation_reason = $3,
          evidence_json = COALESCE(evidence_json, '{}'::jsonb) || $4::jsonb,
          updated_at = now()
      WHERE account_id = $1
        AND badge_id = $2
        AND status = 'verified'
      RETURNING badge_id
    `,
    [
      normalizedAccountId,
      normalizedBadgeId,
      normalizedReason,
      JSON.stringify({
        expiredByOperator: safeText(expiredByOperator, 120),
        expiredAt: new Date().toISOString(),
      }),
    ]
  );
  await query(
    `
      UPDATE account_identity_approvals
      SET status = 'expired',
          expires_at = now(),
          revocation_reason = $3,
          updated_at = now()
      WHERE account_id = $1
        AND approval_scope = $2
        AND status = 'active'
    `,
    [normalizedAccountId, `badge:${normalizedBadgeId}`, normalizedReason]
  );
  if (!result.rows[0]) {
    const error = new Error("network_badge_not_found_or_not_verified");
    error.status = 404;
    throw error;
  }
  return {
    ok: true,
    state: await getIdentityApprovalState({ accountId: normalizedAccountId }),
  };
}

export async function refreshIdentityApprovalsFromProjection({
  accountId = "",
  walletAddress = "",
  verifiedByAccountId = "",
  verifiedByOperator = "runtime_projection_refresh",
} = {}) {
  ensureDatabase();
  const normalizedAccountId = safeText(accountId, 180);
  if (!normalizedAccountId) {
    const error = new Error("identity_approvals_account_required");
    error.status = 400;
    throw error;
  }
  const projection = await networkBadgeProjectionForAccount({
    accountId: normalizedAccountId,
    walletAddress,
    preferDurable: false,
  });
  const projectedBadgeIds = approvalRecordsFromNetworkBadgeProjection({
    projection,
    verifiedByAccountId,
    verifiedByOperator,
  }).badgeIds;
  const result = await transaction(async (client) => {
    // Share the account lock with explicit default selection, including accounts
    // whose first refresh has not created any badge rows yet.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`network_badge_default:${normalizedAccountId}`]
    );
    const existingDefault = await client.query(
      `
        SELECT badge_id
        FROM account_network_badges
        WHERE account_id = $1
          AND selected_default = true
          AND status = 'verified'
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > now())
          AND (
            badge_id = ANY($2::text[])
            OR COALESCE(evidence_json->>'source', '') <> 'runtime_projection_refresh'
          )
        ORDER BY updated_at DESC, badge_id ASC
        LIMIT 1
      `,
      [normalizedAccountId, projectedBadgeIds]
    );
    const materialized = approvalRecordsFromNetworkBadgeProjection({
      projection,
      verifiedByAccountId,
      verifiedByOperator,
      selectedDefaultBadgeId: safeText(existingDefault.rows[0]?.badge_id, 80),
    });
    for (const approval of materialized.identityApprovals) {
      await client.query(
        `
          INSERT INTO account_identity_approvals (
            id,
            account_id,
            provider,
            provider_user_id_hash,
            public_handle,
            profile_url,
            approval_level,
            approval_scope,
            status,
            approved_by_account_id,
            approved_by_operator,
            evidence_json,
            metrics_json,
            expires_at,
            revoked_at,
            revocation_reason,
            created_at,
            updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, 'active', $9, $10, $11::jsonb, $12::jsonb,
            NULL, NULL, '', now(), now()
          )
          ON CONFLICT (id) DO UPDATE SET
            public_handle = EXCLUDED.public_handle,
            profile_url = EXCLUDED.profile_url,
            approval_level = EXCLUDED.approval_level,
            status = 'active',
            approved_by_account_id = EXCLUDED.approved_by_account_id,
            approved_by_operator = EXCLUDED.approved_by_operator,
            evidence_json = EXCLUDED.evidence_json,
            metrics_json = EXCLUDED.metrics_json,
            expires_at = NULL,
            revoked_at = NULL,
            revocation_reason = '',
            updated_at = now()
        `,
        [
          approval.id,
          approval.accountId,
          approval.provider,
          approval.providerUserIdHash,
          approval.publicHandle,
          approval.profileUrl,
          approval.approvalLevel,
          approval.approvalScope,
          approval.approvedByAccountId,
          approval.approvedByOperator,
          JSON.stringify(approval.evidenceJson),
          JSON.stringify(approval.metricsJson),
        ]
      );
    }

    for (const badge of materialized.accountBadges) {
      await client.query(
        `
          INSERT INTO account_network_badges (
            id,
            account_id,
            badge_id,
            status,
            public_visible,
            selected_default,
            verified_by_account_id,
            verified_by_operator,
            evidence_task_id,
            evidence_url_or_ref,
            evidence_json,
            validated_metrics_json,
            expires_at,
            revoked_at,
            revocation_reason,
            created_at,
            updated_at
          )
          VALUES (
            $1, $2, $3, 'verified', $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb,
            NULL, NULL, '', now(), now()
          )
          ON CONFLICT (account_id, badge_id) DO UPDATE SET
            status = 'verified',
            public_visible = EXCLUDED.public_visible,
            selected_default = EXCLUDED.selected_default,
            verified_by_account_id = EXCLUDED.verified_by_account_id,
            verified_by_operator = EXCLUDED.verified_by_operator,
            evidence_task_id = EXCLUDED.evidence_task_id,
            evidence_url_or_ref = EXCLUDED.evidence_url_or_ref,
            evidence_json = EXCLUDED.evidence_json,
            validated_metrics_json = EXCLUDED.validated_metrics_json,
            expires_at = NULL,
            revoked_at = NULL,
            revocation_reason = '',
            updated_at = now()
        `,
        [
          badge.id,
          badge.accountId,
          badge.badgeId,
          badge.publicVisible,
          badge.selectedDefault,
          badge.verifiedByAccountId,
          badge.verifiedByOperator,
          badge.evidenceTaskId,
          badge.evidenceUrlOrRef,
          JSON.stringify(badge.evidenceJson),
          JSON.stringify(badge.validatedMetricsJson),
        ]
      );
    }

    await client.query(
      `
        UPDATE account_network_badges
        SET status = 'revoked',
            revoked_at = now(),
            revocation_reason = 'runtime_projection_no_longer_qualifies',
            selected_default = false,
            updated_at = now()
        WHERE account_id = $1
          AND status = 'verified'
          AND evidence_json->>'source' = 'runtime_projection_refresh'
          AND NOT (badge_id = ANY($2::text[]))
      `,
      [normalizedAccountId, materialized.badgeIds]
    );
    await client.query(
      `
        UPDATE account_identity_approvals
        SET status = 'revoked',
            revoked_at = now(),
            revocation_reason = 'runtime_projection_no_longer_qualifies',
            updated_at = now()
        WHERE account_id = $1
          AND status = 'active'
          AND evidence_json->>'source' = 'runtime_projection_refresh'
          AND NOT (approval_scope = ANY($2::text[]))
      `,
      [normalizedAccountId, materialized.badgeIds.map((badgeId) => `badge:${badgeId}`)]
    );
    return materialized;
  });

  return {
    ok: true,
    projection,
    materialized: result,
    state: await getIdentityApprovalState({ accountId: normalizedAccountId }),
  };
}

export async function refreshIdentityApprovalsAfterSignal({
  accountId = "",
  walletAddress = "",
  signal = "",
  verifiedByAccountId = "",
  metadata = {},
} = {}) {
  const normalizedAccountId = safeText(accountId, 180);
  const normalizedSignal = safeText(signal || "badge_signal", 80)
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "") || "badge_signal";
  if (!normalizedAccountId) {
    return {
      ok: false,
      skipped: true,
      reason: "identity_approvals_account_required",
      signal: normalizedSignal,
    };
  }
  if (!databaseEnabled()) {
    return {
      ok: false,
      skipped: true,
      reason: "network_badges_database_not_configured",
      signal: normalizedSignal,
    };
  }
  try {
    const result = await refreshIdentityApprovalsFromProjection({
      accountId: normalizedAccountId,
      walletAddress,
      verifiedByAccountId: verifiedByAccountId || normalizedAccountId,
      verifiedByOperator: `auto_${normalizedSignal}`.slice(0, 120),
    });
    return {
      ok: true,
      skipped: false,
      signal: normalizedSignal,
      materializedBadgeIds: result.materialized?.badgeIds || [],
      materializedBadgeCount: result.materialized?.badgeIds?.length || 0,
      metadataKeys: Object.keys(safeObject(metadata)).sort(),
    };
  } catch (error) {
    return {
      ok: false,
      skipped: true,
      reason: safeText(error?.message || "identity_approval_refresh_failed", 240),
      status: error?.status || 500,
      signal: normalizedSignal,
    };
  }
}

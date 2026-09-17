import { randomUUID } from "node:crypto";
import { getAccount } from "./repositories/accounts.js";
import { createAddAccountIntent } from "./repositories/auth-challenges.js";
import { createAccountSession, destroySession } from "./repositories/auth-sessions.js";
import {
  attachSessionToDeviceAccountSet,
  ensureDeviceAccountSet,
  listDeviceAccounts,
  removeDeviceAccount,
  revokeDeviceAccountSet,
  selectDeviceAccount,
} from "./repositories/device-account-sets.js";
import { getLinkedWallet } from "./repositories/account-wallets.js";
import { recordUserObservabilityEvent } from "./repositories/user-observability.js";
import { prewarmAppState } from "./app-state.js";

function result(status, body = {}, extra = {}) {
  return { status, body: { ok: status < 400, ...body }, ...extra };
}

async function record(eventType, accountId, resultStatus, reasonCode = "", metadata = {}) {
  await recordUserObservabilityEvent({
    eventType,
    accountId,
    sourceSurface: "profile_menu",
    sourceRoute: "server/account-switching.js",
    resultStatus,
    reasonCode,
    metadata,
  }).catch(() => null);
}

export async function registerAuthenticatedAccountSet({
  accountId = "",
  accountSetToken = "",
  sessionId = "",
  metadata = {},
} = {}) {
  if (!accountId || !sessionId) return null;
  const ensured = await ensureDeviceAccountSet({ token: accountSetToken, accountId, metadata });
  if (!ensured.ok) return null;
  await attachSessionToDeviceAccountSet({ sessionId, setId: ensured.setId });
  if (ensured.added) {
    await record("user.account.added", accountId, "retained", "independent_authentication");
  }
  return ensured;
}

export async function accountList({ accountSetToken = "", session = null, sessionId = "" } = {}) {
  if (!session?.accountId) return result(401, { error: "account_switch_login_required", message: "Sign in to view retained accounts." });
  const ensured = await registerAuthenticatedAccountSet({
    accountId: session.accountId,
    accountSetToken,
    sessionId,
  });
  if (!ensured) return result(503, { error: "account_switch_unavailable", message: "Retained accounts are unavailable." });
  const listed = await listDeviceAccounts({ token: ensured.token, selectedAccountId: session.accountId });
  const enriched = await Promise.all((listed.accounts || []).map(async (entry) => {
    if (entry.displayName) return entry;
    const [account, wallet] = await Promise.all([
      getAccount(entry.accountId),
      getLinkedWallet({ accountId: entry.accountId }),
    ]);
    return {
      ...entry,
      displayName: account?.publicDisplayName || account?.displayName || "Member",
      hiveHandle: account?.hiveHandle || "",
      maskedEmail: account?.primaryEmailCanonical
        ? `${account.primaryEmailCanonical.slice(0, 1)}***${account.primaryEmailCanonical.slice(account.primaryEmailCanonical.lastIndexOf("@"))}`
        : "",
      walletAddress: wallet?.status === "linked" ? wallet.address || "" : "",
    };
  }));
  return result(200, { accounts: enriched, selectedAccountId: session.accountId }, { accountSetToken: ensured.token });
}

export async function accountAddStart({ accountSetToken = "", session = null, sessionId = "" } = {}) {
  if (!session?.accountId) return result(401, { error: "account_switch_login_required", message: "Sign in before adding another account." });
  const ensured = await registerAuthenticatedAccountSet({ accountId: session.accountId, accountSetToken, sessionId });
  if (!ensured) return result(503, { error: "account_switch_unavailable", message: "Another account cannot be added right now." });
  const intent = await createAddAccountIntent({ accountId: session.accountId, setId: ensured.setId });
  return result(200, {
    intent: "add_account",
    expiresAt: intent.expiresAt,
    message: "Authenticate the account you want to add.",
  }, { accountSetToken: ensured.token, accountAddIntentId: intent.id });
}

export async function accountSwitch({ accountSetToken = "", payload = {}, session = null, sessionId = "" } = {}) {
  if (!session?.accountId) return result(401, { error: "account_switch_login_required", message: "Sign in before switching accounts." });
  const targetAccountId = String(payload?.targetAccountId || "").trim();
  const selected = await selectDeviceAccount({ token: accountSetToken, accountId: targetAccountId });
  if (!selected.ok) return result(403, { error: "account_switch_membership_required", message: "Authenticate that account on this browser before switching to it." });
  const account = await getAccount(targetAccountId);
  if (!account?.id) return result(404, { error: "account_switch_target_missing", message: "That retained account is unavailable." });
  const created = await createAccountSession(account, {
    provider: "account_switch",
    assurance: account.assurance || "low",
    deviceAccountSetId: selected.setId,
  });
  await destroySession(sessionId);
  await record("user.account.selected", targetAccountId, "selected", "profile_switch", { previousAccountId: session.accountId });
  // Pre-warm the target account's app-state so the post-switch reload hits a
  // fresh cache entry instead of paying the full compute on the critical path.
  prewarmAppState(created.session);
  return result(200, {
    selectedAccountId: targetAccountId,
    accountGeneration: randomUUID(),
    session: created.session,
    message: "Account selected.",
  }, { sessionId: created.sessionId, accountSetToken: selected.token });
}

export async function accountRemove({ accountSetToken = "", payload = {}, session = null } = {}) {
  if (!session?.accountId) return result(401, { error: "account_switch_login_required", message: "Sign in before removing a retained account." });
  const targetAccountId = String(payload?.targetAccountId || "").trim();
  if (!targetAccountId || targetAccountId === session.accountId) {
    return result(409, { error: "account_remove_selected_forbidden", message: "Use Log out this account for the selected account." });
  }
  const removed = await removeDeviceAccount({ token: accountSetToken, accountId: targetAccountId });
  if (!removed.ok) return result(403, { error: removed.error, message: "That account is not retained on this browser." });
  await record("user.account.removed", targetAccountId, "removed", "profile_remove", { selectedAccountId: session.accountId });
  return result(200, { removedAccountId: targetAccountId, message: "Account removed from this browser." });
}

export async function accountLogoutAll({ accountSetToken = "", session = null, sessionId = "" } = {}) {
  await revokeDeviceAccountSet({ token: accountSetToken });
  await destroySession(sessionId);
  await record("user.account.logout_all", session?.accountId || "", "revoked", "profile_logout_all");
  return result(200, { message: "All retained accounts were logged out." });
}

export async function accountLogoutCurrent({ accountSetToken = "", session = null, sessionId = "" } = {}) {
  if (!session?.accountId) {
    await destroySession(sessionId);
    return result(200, { message: "Signed out.", signedOut: true });
  }
  await removeDeviceAccount({ token: accountSetToken, accountId: session.accountId });
  await destroySession(sessionId);
  const remaining = await listDeviceAccounts({ token: accountSetToken, selectedAccountId: "" });
  const targetAccountId = remaining.ok ? remaining.accounts?.[0]?.accountId || "" : "";
  if (!targetAccountId) {
    await revokeDeviceAccountSet({ token: accountSetToken });
    await record("user.account.logout", session.accountId, "revoked", "profile_logout_current");
    return result(200, { message: "Signed out.", signedOut: true });
  }
  const selected = await selectDeviceAccount({ token: accountSetToken, accountId: targetAccountId });
  const account = selected.ok ? await getAccount(targetAccountId) : null;
  if (!account?.id) {
    await revokeDeviceAccountSet({ token: accountSetToken });
    return result(200, { message: "Signed out.", signedOut: true });
  }
  const created = await createAccountSession(account, {
    provider: "account_switch",
    assurance: account.assurance || "low",
    deviceAccountSetId: selected.setId,
  });
  await record("user.account.logout", session.accountId, "revoked", "profile_logout_current", { nextAccountId: targetAccountId });
  return result(200, {
    message: "Account logged out. Another retained account was selected.",
    selectedAccountId: targetAccountId,
    accountGeneration: randomUUID(),
    session: created.session,
  }, { sessionId: created.sessionId, accountSetToken: selected.token });
}

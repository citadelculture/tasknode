import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, BookOpen, Check, ChevronRight, CreditCard, FileText, LifeBuoy, ListTodo, Lock, LogOut, MoreHorizontal, Network, PanelLeft, Pencil, Search, Settings as SettingsIcon, Share, SquarePen, Store, Unlock, User as UserIcon, Wallet, Wand2, X } from "lucide-react";
import { fetchRuntimeConfig, requestJson } from "../api";
import { ChatSearchModal } from "../features/chat/ChatSearchModal";
import { ChatSurface } from "../features/chat/ChatSurface.jsx";
import { ChatItemActionMenu, DeleteChatModal, ProfileAvatar, RenameChatModal, profileAvatarText, profileDisplayName, profileSessionText } from "../features/chat/AppChatDialogs.jsx";
import { buildRecentChats, chatActionMenuPosition, formatUnreadCount } from "../features/chat/chat-surface-state.js";
import "../features/hive/hive-navigation.css";
import { useHiveGroupStatus } from "../features/hive/use-hive-group-status.js";
import { extractHydratedContext } from "../features/context/context-view-state.js";
import { publishContextToPft } from "../features/context/context-publish";
import { IdentityHandleDialog } from "../features/identity/IdentityControls.jsx";
import { PostFiatLogo, SidebarButton, ToolMenuRow } from "../features/shell/ShellControls";
import { TaskDetailModal } from "../features/tasks/TaskDetailModal.jsx";
import { TasksView } from "../features/tasks/TasksView.jsx";
import { appendTaskActionReceipt, loadTaskActionReceipts, saveTaskActionReceipts } from "../features/tasks/task-action-receipts.js";
import { findTaskById, mergeTaskStateWithActionReceipts, reconcileTaskVisibleState } from "../features/tasks/task-visible-state.js";
import { mergeAppStateWithMonotonicTasks } from "../features/tasks/task-app-state-refresh.js";
import { LoginDialog, SettingsModal, TelegramProfileMenuRow, accountLinkProvider, linkedProviderById } from "../features/settings/AppDialogs.jsx";
import { useAppearance } from "../theme/use-appearance.js";
import { ProfileAccountSwitcher } from "../features/settings/ProfileAccountSwitcher.jsx";
import { createAccountSwitcherActions } from "../features/settings/account-switch-client.js";
import { acceptAccountBoundaryResponse, accountBoundaryCaptureIsCurrent, beginAccountBoundaryTransition, cancelAccountBoundaryTransition, initialAccountBoundary } from "../features/settings/account-transition-boundary.js";
import { applyWalletBalanceError, applyWalletBalanceResult, formatPftBalance, markWalletBalanceChecking, mergeAppStateWithClientWalletBalance, walletVaultDisplayState } from "../features/wallet/wallet-state";
import { clearAllUnlockedWalletSessions, clearOtherUnlockedWalletSessions, clearUnlockedWalletSession, readUnlockedWalletSession, saveUnlockedWalletSession, touchWalletUnlockActivity, walletUnlockIdleLockMs, walletUnlockIdleRemainingMs } from "../features/wallet/wallet-unlocked-session.js";
import { WalletUnlockModal } from "../features/wallet/WalletUnlockModal";
import { formatCreditUsd } from "../formatters";
import { isSignedInSession } from "../session";
import { appExtensionRegistry, ExtensionSurface } from "../extensions/index.js";
import { APP_VIEWS, EMPTY_TASKS, EMPTY_WALLET_VAULT_STATUS, MORE_EXTENSION_VIEWS, RouteErrorBoundary, StatusBanner, TASK_ACTION_RECEIPTS_STORAGE_KEY, WALLET_ACTIVITY_EVENT_NAME, WALLET_BALANCE_REFRESH_MS, WALLET_REALTIME_BALANCE_REFRESH_DELAY_MS, fallbackConfig, fetchAppStateWithSessionRetry, initialSidebarOpen, isMobileViewport, memberProfileAccountIdFromLocation, profileNftImageCandidates, taskIdFromLocation, taskLifecycleDirectOffchain, taskSelectionFingerprint, viewFromLocation, writeAuthSessionHint, writeTaskLocation, writeViewLocation } from "./app-shell-shared.jsx";

const ContextView = lazy(() => import("../features/context/ContextView.jsx").then((module) => ({ default: module.ContextView })));
const WalletView = lazy(() => import("../features/wallet/WalletView").then((module) => ({ default: module.WalletView })));
const HelpView = lazy(() => import("../features/docs/DocsView").then((module) => ({ default: module.DocsView })));
const DocsLibraryView = lazy(() => import("../features/docs-library/DocsLibraryView").then((module) => ({ default: module.DocsLibraryView })));
const HiveView = lazy(() => import("../features/hive/HiveView").then((module) => ({ default: module.HiveView })));
const TASKS_VIEW_FRESH_STATE_MS = 2000;
const ProfilePage = lazy(() => import("../features/profile/ProfileView").then((module) => ({ default: module.ProfileView })));
const MemberProfilePage = lazy(() => import("../features/profile/ProfileView").then((module) => ({ default: module.MemberProfileView })));
const DirectoryView = lazy(() => import("../features/directory/DirectoryView").then((module) => ({ default: module.DirectoryView })));

export function App() {
  const [view, setView] = useState(() => viewFromLocation());
  const [sidebarOpen, setSidebarOpen] = useState(initialSidebarOpen);
  const [loginOpen, setLoginOpen] = useState(false);
  const [addingAccount, setAddingAccount] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [retainedAccounts, setRetainedAccounts] = useState([]);
  const [accountMenuPending, setAccountMenuPending] = useState("");
  const [accountTransitioning, setAccountTransitioning] = useState(false);
  const [managingAccounts, setManagingAccounts] = useState(false);
  const [logoutConfirming, setLogoutConfirming] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [identityPromptDismissed, setIdentityPromptDismissed] = useState(false);
  const [profileAuthMessage, setProfileAuthMessage] = useState("");
  const [profilePendingProvider, setProfilePendingProvider] = useState("");
  const { preference: theme, setPreference: setTheme, sessionOnly: themeSessionOnly } = useAppearance();
  const [profileTab, setProfileTab] = useState("private");
  const [profilePublic, setProfilePublic] = useState(true);
  const [locationHash, setLocationHash] = useState(() => (typeof window === "undefined" ? "" : window.location.hash));
  const [selectedTask, setSelectedTask] = useState(null);
  const [activeChat, setActiveChat] = useState(null);
  const [chatResetKey, setChatResetKey] = useState(0);
  const [chatSelectionKey, setChatSelectionKey] = useState(0);
  const [chatShareRequestKey, setChatShareRequestKey] = useState(0);
  const [contextRefinePending, setContextRefinePending] = useState(false);
  const [contextRewritePending, setContextRewritePending] = useState(false);
  const [chatActionMenu, setChatActionMenu] = useState(null);
  const [chatRenameTarget, setChatRenameTarget] = useState(null);
  const [chatDeleteTarget, setChatDeleteTarget] = useState(null);
  const [chatSearchOpen, setChatSearchOpen] = useState(false);
  const [walletUnlockOpen, setWalletUnlockOpen] = useState(false);
  const [runtimeConfig, setRuntimeConfig] = useState(fallbackConfig);
  const [appState, setAppState] = useState(null);
  const [taskActionReceipts, setTaskActionReceipts] = useState(() =>
    loadTaskActionReceipts(typeof window === "undefined" ? null : window.sessionStorage, TASK_ACTION_RECEIPTS_STORAGE_KEY)
  );
  const [profileAvatarNft, setProfileAvatarNft] = useState(null);
  const [messagesPromptDismissed, setMessagesPromptDismissed] = useState("");
  const [walletVaultStatus, setWalletVaultStatus] = useState(EMPTY_WALLET_VAULT_STATUS);
  const [loadError, setLoadError] = useState("");
  const profileRef = useRef(null);
  const moreRef = useRef(null);
  const chatActionRef = useRef(null);
  const walletSecretRef = useRef(null);
  const refreshAppStateRef = useRef(null);
  const taskRefreshSequenceRef = useRef({ applied: 0, started: 0 });
  const accountBoundaryRef = useRef(initialAccountBoundary());
  const appStateFetchedAtRef = useRef(0);
  useEffect(() => {
    let active = true;
    const accountCapture = { ...accountBoundaryRef.current };
    Promise.all([fetchRuntimeConfig(), fetchAppStateWithSessionRetry()])
      .then(([config, state]) => {
        if (!active) return;
        setRuntimeConfig(config);
        applyFetchedAppState(state, accountCapture);
      })
      .catch((error) => {
        if (active) setLoadError(error?.message || "Failed to load app state");
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (view !== "tasks") return undefined;
    // Landing on the tasks view right after bootstrap (cold load or account
    // switch) already has fresh task state; forcing a projection refresh here
    // paid a second full app-state compute on the critical path.
    if (Date.now() - appStateFetchedAtRef.current < TASKS_VIEW_FRESH_STATE_MS) return undefined;
    refreshAppStateRef.current?.({ errorMessage: "Failed to load task state", taskProjectionRefresh: true })
      .then(() => null)
      .catch(() => null);
    return undefined;
  }, [view]);
  useEffect(() => {
    function closeMenus(event) {
      if (profileRef.current && !profileRef.current.contains(event.target)) {
        setProfileMenuOpen(false);
      }
      if (moreRef.current && !moreRef.current.contains(event.target)) {
        setMoreMenuOpen(false);
      }
      if (chatActionRef.current && !chatActionRef.current.contains(event.target)) {
        setChatActionMenu(null);
      }
    }
    document.addEventListener("mousedown", closeMenus);
    return () => document.removeEventListener("mousedown", closeMenus);
  }, []);
  useEffect(() => {
    if (!profileMenuOpen) setLogoutConfirming(false);
  }, [profileMenuOpen]);
  useEffect(() => {
    if (!settingsOpen && !selectedTask && !chatActionMenu && !walletUnlockOpen) return undefined;
    function closeModal(event) {
      if (event.key === "Escape") {
        if (walletUnlockOpen) {
          setWalletUnlockOpen(false);
          return;
        }
        setChatActionMenu(null);
        setSettingsOpen(false);
        setSelectedTask(null);
      }
    }
    document.addEventListener("keydown", closeModal);
    return () => document.removeEventListener("keydown", closeModal);
  }, [settingsOpen, selectedTask, chatActionMenu, walletUnlockOpen]);
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const query = window.matchMedia("(max-width: 760px)");
    const syncSidebarForViewport = (event = query) => {
      setSidebarOpen(!event.matches);
      setMoreMenuOpen(false);
      setProfileMenuOpen(false);
      setChatActionMenu(null);
    };
    syncSidebarForViewport(query);
    query.addEventListener("change", syncSidebarForViewport);
    return () => query.removeEventListener("change", syncSidebarForViewport);
  }, []);
  const recentChats = buildRecentChats(appState?.chat?.recents || []);
  const activeChatId = activeChat?.conversationId || activeChat?.id || "";
  const pftBalance = formatPftBalance(appState?.wallet);
  const chatCredit = formatCreditUsd(appState?.usage?.availableCreditUsd || 0);
  const appStateLoading = !appState && !loadError;
  const canRenderWorkspaceContent = Boolean(appState);
  const session = appState?.session;
  const signedIn = canRenderWorkspaceContent && isSignedInSession(session);
  const [hiveGroupStatus, setHiveGroupStatus] = useHiveGroupStatus({ accountId: session?.accountId, signedIn, activeChatKind: activeChat?.kind, activeChatId, view });
  const hiveUnreadCount = hiveGroupStatus?.accountId === appState?.session?.accountId ? Number(hiveGroupStatus?.unreadCount || 0) : 0;
  const profileName = appStateLoading ? "Checking session" : profileDisplayName(session);
  const profileInitials = appStateLoading ? "TN" : profileAvatarText(session);
  const profileAvatarImages = profileNftImageCandidates(profileAvatarNft);
  const profileSubtext = appStateLoading ? "Loading account" : profileSessionText(session);
  const walletAccountId = signedIn ? session?.accountId || "" : "";
  const linkedWallet =
    signedIn && appState?.wallet?.pftWallet?.status === "linked"
      ? appState.wallet.pftWallet
      : null;
  const linkedWalletAddress = linkedWallet?.address || "";
  const directOffchainTaskLifecycle = taskLifecycleDirectOffchain(runtimeConfig);
  const memberProfileAccountId = view === "profile" ? memberProfileAccountIdFromLocation(locationHash) : "";
  const taskVisibleState = useMemo(() => reconcileTaskVisibleState({
    accountId: walletAccountId,
    linkedWalletAddress,
    receipts: taskActionReceipts,
    tasks: appState?.tasks || EMPTY_TASKS,
  }), [appState?.tasks, linkedWalletAddress, taskActionReceipts, walletAccountId]);
  const visibleTasks = taskVisibleState.tasks;
  const selectedTaskId = selectedTask?.taskId || selectedTask?.fullId || selectedTask?.id || "";
  const selectedVisibleTask = selectedTaskId ? findTaskById(visibleTasks, selectedTaskId) : null;
  const selectedTaskForModal = selectedVisibleTask || selectedTask;
  const walletVaultAvailable = Boolean(walletVaultStatus?.available && walletVaultStatus?.address === linkedWalletAddress);
  const walletVaultUnlocked = Boolean(walletVaultAvailable && walletVaultStatus?.unlocked);
  const vaultDisplay = walletVaultDisplayState(walletVaultStatus, linkedWalletAddress);
  const identityHandleRequired = signedIn && session?.identityProfile?.handleRequired === true;
  const telegramProvider = accountLinkProvider(session, "telegram");
  const linkedTelegramProvider = linkedProviderById(session, "telegram");
  const loadRetainedAccounts = useCallback(async () => {
    if (!signedIn) {
      setRetainedAccounts([]);
      return [];
    }
    const accountCapture = { ...accountBoundaryRef.current };
    const result = await requestJson("/api/auth/accounts");
    if (!accountBoundaryCaptureIsCurrent(accountBoundaryRef.current, accountCapture)) return [];
    const accounts = result.ok && Array.isArray(result.body?.accounts) ? result.body.accounts : [];
    setRetainedAccounts(accounts);
    return accounts;
  }, [signedIn]);
  useEffect(() => {
    loadRetainedAccounts().catch(() => setRetainedAccounts([]));
  }, [loadRetainedAccounts, session?.accountId]);
  useEffect(() => {
    if (view !== "tasks") return;
    const taskId = taskIdFromLocation();
    if (!taskId) return;
    const task = findTaskById(visibleTasks, taskId);
    if (task) {
      setSelectedTask((current) => (
        taskSelectionFingerprint(current) === taskSelectionFingerprint(task) ? current : task
      ));
    }
  }, [view, visibleTasks]);
  useEffect(() => {
    if (!appState?.tasks) return;
    setTaskActionReceipts((current) => {
      const pruned = reconcileTaskVisibleState({
        accountId: walletAccountId,
        linkedWalletAddress,
        receipts: current,
        tasks: appState.tasks,
      }).prunedReceipts;
      if (pruned.length === current.length) return current;
      saveTaskActionReceipts(
        typeof window === "undefined" ? null : window.sessionStorage,
        pruned,
        TASK_ACTION_RECEIPTS_STORAGE_KEY
      );
      return pruned;
    });
  }, [appState?.tasks, linkedWalletAddress, walletAccountId]);
  useEffect(() => {
    setIdentityPromptDismissed(false);
  }, [session?.accountId]);
  const lockWalletVault = useCallback(() => {
    walletSecretRef.current = null;
    clearAllUnlockedWalletSessions();
    setWalletVaultStatus((current) => ({
      ...current,
      unlocked: false,
      lastUnlockedAt: null,
    }));
  }, []);
  const refreshWalletVaultStatus = useCallback(
    async ({ preserveUnlock = false, accountId = "" } = {}) => {
      const accountCapture = { ...accountBoundaryRef.current };
      const effectiveAccountId = accountId || walletAccountId;
      if (!effectiveAccountId) {
        walletSecretRef.current = null;
        setWalletVaultStatus(EMPTY_WALLET_VAULT_STATUS);
        return EMPTY_WALLET_VAULT_STATUS;
      }
      try {
        // Any persisted unlock entry that does not belong to the current
        // account is stale by definition; sweep them on every refresh so a
        // prior account's session can never linger after an account switch.
        clearOtherUnlockedWalletSessions({ keepAccountId: effectiveAccountId });
        if (!preserveUnlock) clearUnlockedWalletSession({ accountId: effectiveAccountId });
        const walletCore = await import("../wallet-core");
        const nextStatus = typeof walletCore.localWalletVaultStatusAsync === "function"
          ? await walletCore.localWalletVaultStatusAsync({ accountId: effectiveAccountId })
          : walletCore.localWalletVaultStatus({ accountId: effectiveAccountId });
        const persistence = typeof walletCore.walletVaultPersistence === "function"
          ? await walletCore.walletVaultPersistence()
          : nextStatus?.persistence || "unknown";
        const nextStatusWithPersistence = {
          ...nextStatus,
          persistence: nextStatus?.persistence && nextStatus.persistence !== "unknown" ? nextStatus.persistence : persistence,
        };
        if (!accountBoundaryCaptureIsCurrent(accountBoundaryRef.current, accountCapture)) return null;
        const currentSecret = walletSecretRef.current;
        const canRestoreUnlock = Boolean(preserveUnlock && nextStatusWithPersistence?.available && nextStatusWithPersistence?.address);
        const inMemorySecretMatches =
          canRestoreUnlock &&
          currentSecret?.accountId === effectiveAccountId &&
          currentSecret?.address === nextStatusWithPersistence.address &&
          currentSecret?.mnemonic;
        const sessionSecret = inMemorySecretMatches
          ? null
          : canRestoreUnlock
            ? await readUnlockedWalletSession({
              accountId: effectiveAccountId,
              expectedAddress: nextStatusWithPersistence.address,
            })
            : null;
        const activeSecret = inMemorySecretMatches ? currentSecret : sessionSecret;
        if (activeSecret) {
          walletSecretRef.current = activeSecret;
        } else {
          walletSecretRef.current = null;
          clearUnlockedWalletSession({ accountId: effectiveAccountId });
        }
        setWalletVaultStatus((current) => ({
          ...nextStatusWithPersistence,
          unlocked: Boolean(activeSecret),
          lastUnlockedAt: activeSecret ? activeSecret.unlockedAt || current.lastUnlockedAt : null,
        }));
        return nextStatusWithPersistence;
      } catch {
        if (!accountBoundaryCaptureIsCurrent(accountBoundaryRef.current, accountCapture)) return null;
        walletSecretRef.current = null;
        clearUnlockedWalletSession({ accountId: effectiveAccountId });
        setWalletVaultStatus({
          ...EMPTY_WALLET_VAULT_STATUS,
          accountId: effectiveAccountId,
        });
        return null;
      }
    },
    [walletAccountId]
  );
  const handleWalletVaultUnlocked = useCallback(
    (unlock) => {
      if (!walletAccountId || !unlock?.mnemonic || !unlock?.address) return;
      walletSecretRef.current = {
        accountId: walletAccountId,
        address: unlock.address,
        publicKey: unlock.publicKey || null,
        derivationPath: unlock.derivationPath || null,
        mnemonic: unlock.mnemonic,
        unlockedAt: unlock.unlockedAt || new Date().toISOString(),
      };
      void saveUnlockedWalletSession(walletSecretRef.current);
      touchWalletUnlockActivity();
      setWalletVaultStatus((current) => ({
        ...current,
        available: true,
        accountId: walletAccountId,
        address: unlock.address,
        publicKey: unlock.publicKey || current.publicKey || null,
        derivationPath: unlock.derivationPath || current.derivationPath || null,
        unlocked: true,
        lastUnlockedAt: unlock.unlockedAt || new Date().toISOString(),
      }));
    },
    [walletAccountId]
  );
  useEffect(() => {
    if (!walletVaultStatus?.unlocked) return undefined;
    const idleLockMs = walletUnlockIdleLockMs();
    let lastTouchMs = 0;
    const onActivity = () => {
      const nowMs = Date.now();
      if (nowMs - lastTouchMs < 5000) return;
      lastTouchMs = nowMs;
      touchWalletUnlockActivity();
    };
    const lockIfIdle = () => {
      const remaining = walletUnlockIdleRemainingMs({ idleLockMs });
      if (remaining !== null && remaining <= 0) lockWalletVault();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") lockIfIdle();
    };
    const activityEvents = ["pointerdown", "keydown", "wheel", "touchstart"];
    activityEvents.forEach((eventName) => window.addEventListener(eventName, onActivity, { passive: true }));
    document.addEventListener("visibilitychange", onVisibilityChange);
    onActivity();
    const interval = window.setInterval(lockIfIdle, 30_000);
    return () => {
      activityEvents.forEach((eventName) => window.removeEventListener(eventName, onActivity));
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.clearInterval(interval);
    };
  }, [walletVaultStatus?.unlocked, lockWalletVault]);
  const hydrateContextPointer = useCallback(
    async (pointer) => {
      const secret = walletSecretRef.current;
      if (!walletAccountId || !secret?.mnemonic || secret.accountId !== walletAccountId) {
        const error = new Error("Unlock the local seed vault first.");
        error.code = "wallet_vault_locked";
        throw error;
      }
      const cid = String(pointer?.cid || "").trim();
      if (!cid) {
        const error = new Error("No context CID is selected.");
        error.code = "context_cid_missing";
        throw error;
      }
      const fetched = await requestJson(`/api/context/history/ipfs/${encodeURIComponent(cid)}`);
      if (!fetched.ok || !fetched.body?.payload) {
        const error = new Error(fetched.body?.message || "Context CID could not be fetched.");
        error.code = fetched.body?.error || "context_cid_fetch_failed";
        throw error;
      }
      const walletCore = await import("../wallet-core");
      const hydrated = await walletCore.hydrateTaskNodeFetchedPayload({
        payload: fetched.body.payload,
        mnemonic: secret.mnemonic,
      });
      const extracted = extractHydratedContext(hydrated.payload, hydrated.plaintext);
      return {
        ...extracted,
        cid,
        pointer,
        decrypted: hydrated.decrypted,
        gateway: fetched.body.gateway || "",
        fetchedAt: new Date().toISOString(),
      };
    },
    [walletAccountId]
  );
  async function publishContextPointer({
    title = "Task Node Context",
    body = "",
    revision = 0,
    wordCount = 0,
    path = "/api/context/manifest/ink",
  } = {}) {
    return publishContextToPft({
      accountId: walletAccountId,
      linkedWalletAddress,
      walletSecret: walletSecretRef.current,
      path,
      context: { title, body, revision, wordCount },
      onPublished: refreshAppState,
    });
  }
  const navigateToView = useCallback((nextView, options = {}) => {
    const normalizedView = APP_VIEWS.has(nextView) ? nextView : "chat";
    setView(normalizedView);
    setChatActionMenu(null);
    setMoreMenuOpen(false);
    setProfileMenuOpen(false);
    setSettingsOpen(false);
    setSelectedTask(null);
    setLoginOpen(false);
    setWalletUnlockOpen(false);
    if (isMobileViewport()) {
      setSidebarOpen(false);
    }
    writeViewLocation(normalizedView, { replace: options.replace === true });
    if (typeof window !== "undefined") setLocationHash(window.location.hash);
  }, []);
  const openTaskDetail = useCallback((task) => {
    const taskId = task?.taskId || task?.fullId || task?.id || "";
    setSelectedTask(task);
    setView("tasks");
    if (taskId) writeTaskLocation(taskId);
  }, []);
  const closeTaskDetail = useCallback(() => {
    setSelectedTask(null);
    if (view === "tasks" && taskIdFromLocation()) {
      writeViewLocation("tasks", { replace: true });
    }
    if (view === "tasks") {
      void refreshAppStateRef.current?.({ taskProjectionRefresh: true });
    }
  }, [view]);
  const openWalletVaultControl = useCallback(() => {
    setProfileMenuOpen(false);
    setMoreMenuOpen(false);
    if (!signedIn) {
      setLoginOpen(true);
      return;
    }
    if (!linkedWalletAddress) {
      navigateToView("wallet");
      return;
    }
    if (walletVaultUnlocked) {
      navigateToView("wallet");
      return;
    }
    if (walletVaultAvailable) {
      setWalletUnlockOpen(true);
      return;
    }
    navigateToView("wallet");
  }, [
    linkedWalletAddress,
    navigateToView,
    signedIn,
    walletVaultAvailable,
    walletVaultUnlocked,
  ]);
  const openWalletSummary = useCallback(() => {
    if (walletVaultAvailable && !walletVaultUnlocked) {
      openWalletVaultControl();
      return;
    }
    navigateToView("wallet");
  }, [navigateToView, openWalletVaultControl, walletVaultAvailable, walletVaultUnlocked]);
  const startNewChat = useCallback(() => {
    setActiveChat(null);
    setChatActionMenu(null);
    setChatResetKey((key) => key + 1);
    navigateToView("chat");
  }, [navigateToView]);
  const openRecentChat = useCallback(
    (chat) => {
      if (chat?.kind === "hive") { setChatActionMenu(null); navigateToView("hive-chat"); return; }
      setActiveChat(chat);
      setChatActionMenu(null);
      setChatSelectionKey((key) => key + 1);
      navigateToView("chat");
    },
    [navigateToView]
  );
  const openContextRefine = useCallback(() => {
    setMoreMenuOpen(false);
    if (!signedIn) {
      setLoginOpen(true);
      return;
    }
    setContextRefinePending(true);
    navigateToView("chat");
  }, [navigateToView, signedIn]);
  const openContextRewrite = useCallback(() => {
    setMoreMenuOpen(false);
    if (!signedIn) {
      setLoginOpen(true);
      return;
    }
    setContextRewritePending(true);
    navigateToView("chat");
  }, [navigateToView, signedIn]);
  useEffect(() => {
    const initialTaskId = taskIdFromLocation();
    if (initialTaskId) {
      writeTaskLocation(initialTaskId, { replace: true });
    } else {
      writeViewLocation(viewFromLocation(), { replace: true });
    }
    setLocationHash(window.location.hash);
    function syncViewFromLocation() {
      setLocationHash(window.location.hash);
      setView(viewFromLocation());
      setMoreMenuOpen(false);
      setProfileMenuOpen(false);
      setSettingsOpen(false);
      setSelectedTask(null);
      setLoginOpen(false);
      setWalletUnlockOpen(false);
      setChatSearchOpen(false);
    }
    window.addEventListener("popstate", syncViewFromLocation);
    window.addEventListener("hashchange", syncViewFromLocation);
    return () => {
      window.removeEventListener("popstate", syncViewFromLocation);
      window.removeEventListener("hashchange", syncViewFromLocation);
    };
  }, []);
  useEffect(() => {
    refreshWalletVaultStatus({ preserveUnlock: true });
  }, [refreshWalletVaultStatus]);
  const refreshWalletBalance = useCallback(
    async ({ force = false, address = linkedWalletAddress } = {}) => {
      if (!signedIn || !address) return null;
      const accountCapture = { ...accountBoundaryRef.current };
      setAppState((current) => markWalletBalanceChecking(current, address));
      try {
        const result = await requestJson(`/api/wallet/balance${force ? "?force=1" : ""}`);
        if (!accountBoundaryCaptureIsCurrent(accountBoundaryRef.current, accountCapture)) return null;
        setAppState((current) => applyWalletBalanceResult(current, address, result));
        return result;
      } catch (error) {
        if (!accountBoundaryCaptureIsCurrent(accountBoundaryRef.current, accountCapture)) return null;
        setAppState((current) =>
          applyWalletBalanceError(current, address, error?.message || "Balance read failed.")
        );
        return null;
      }
    },
    [linkedWalletAddress, signedIn]
  );
  useEffect(() => {
    if (!signedIn || !linkedWalletAddress) return undefined;
    refreshWalletBalance({ force: true, address: linkedWalletAddress });
    const timer = window.setInterval(
      () => refreshWalletBalance({ force: true, address: linkedWalletAddress }),
      WALLET_BALANCE_REFRESH_MS
    );
    return () => {
      window.clearInterval(timer);
    };
  }, [signedIn, linkedWalletAddress, refreshWalletBalance]);
  useEffect(() => {
    if (!signedIn || !linkedWalletAddress || typeof window === "undefined" || !window.EventSource) {
      return undefined;
    }
    const events = new window.EventSource("/api/events");
    let refreshTimer = null;
    function scheduleWalletRefresh(payload = {}) {
      const walletAddress = String(payload.walletAddress || "").trim();
      if (walletAddress && walletAddress !== linkedWalletAddress) return;
      window.dispatchEvent(new CustomEvent(WALLET_ACTIVITY_EVENT_NAME, { detail: payload }));
      window.clearTimeout(refreshTimer);
      if (WALLET_REALTIME_BALANCE_REFRESH_DELAY_MS <= 0) {
        refreshWalletBalance({ force: true, address: linkedWalletAddress });
        return;
      }
      refreshTimer = window.setTimeout(() => {
        refreshWalletBalance({ force: true, address: linkedWalletAddress });
      }, WALLET_REALTIME_BALANCE_REFRESH_DELAY_MS);
    }
    function handleWalletActivity(event) {
      try {
        scheduleWalletRefresh(JSON.parse(event.data || "{}"));
      } catch {
        scheduleWalletRefresh({});
      }
    }
    events.addEventListener("wallet_activity", handleWalletActivity);
    return () => {
      window.clearTimeout(refreshTimer);
      events.removeEventListener("wallet_activity", handleWalletActivity);
      events.close();
    };
  }, [signedIn, linkedWalletAddress, refreshWalletBalance]);

  useEffect(() => {
    let active = true;
    if (!signedIn || !walletAccountId) {
      setProfileAvatarNft(null);
      return () => {
        active = false;
      };
    }
    requestJson("/api/profile/public")
      .then((result) => {
        if (!active) return;
        if (result.ok && result.body?.ok) {
          setProfileAvatarNft(result.body.profile?.heroNft || null);
        }
      })
      .catch(() => {
        if (active) setProfileAvatarNft(null);
      });
    return () => {
      active = false;
    };
  }, [signedIn, walletAccountId]);
  async function refreshAppState({
    allowSignedOutSession = false,
    errorMessage = "Failed to load app state",
    taskProjectionRefresh = false,
  } = {}) {
    const accountCapture = { ...accountBoundaryRef.current };
    const taskRefreshSequence = taskProjectionRefresh
      ? taskRefreshSequenceRef.current.started + 1
      : 0;
    if (taskProjectionRefresh) {
      taskRefreshSequenceRef.current.started = taskRefreshSequence;
    }
    try {
      const state = await fetchAppStateWithSessionRetry({ taskProjectionRefresh });
      if (
        !allowSignedOutSession &&
        isSignedInSession(appState?.session) &&
        !isSignedInSession(state?.session)
      ) {
        setLoadError("");
        return appState;
      }
      if (
        taskProjectionRefresh &&
        taskRefreshSequence < taskRefreshSequenceRef.current.applied
      ) {
        return state;
      }
      if (!applyFetchedAppState(state, accountCapture)) return state;
      if (taskProjectionRefresh) {
        taskRefreshSequenceRef.current.applied = Math.max(
          taskRefreshSequenceRef.current.applied,
          taskRefreshSequence
        );
      }
      const nextAccountId = isSignedInSession(state?.session) ? state.session.accountId || "" : "";
      await refreshWalletVaultStatus({ preserveUnlock: true, accountId: nextAccountId });
      setLoadError("");
      return state;
    } catch (error) {
      setLoadError(error?.message || errorMessage);
      return null;
    }
  }
  refreshAppStateRef.current = refreshAppState;
  function applyFetchedAppState(state, accountCapture = { ...accountBoundaryRef.current }) {
    const nextAccountId = isSignedInSession(state?.session) ? state.session.accountId || "" : "";
    const accepted = acceptAccountBoundaryResponse(accountBoundaryRef.current, accountCapture, nextAccountId);
    if (!accepted.ok) return false;
    accountBoundaryRef.current = accepted.boundary;
    const storage = typeof window === "undefined" ? null : window.sessionStorage;
    if (isSignedInSession(state?.session)) {
      writeAuthSessionHint(storage, state.session);
    }
    appStateFetchedAtRef.current = Date.now();
    setAppState((current) =>
      mergeAppStateWithMonotonicTasks(current, state, {
        mergeBase: mergeAppStateWithClientWalletBalance,
      })
    );
    return true;
  }
  const recordTaskActionReceipt = useCallback((receipt) => {
    if (!receipt?.taskId || !receipt?.expectedStatusKey) return;
    // A duplicate receipt returns the same array reference; skip both state
    // updates and the session-storage write so observed-receipt emissions from
    // task detail polling cannot re-render the app at network round-trip rate.
    if (appendTaskActionReceipt(taskActionReceipts, receipt) === taskActionReceipts) return;
    setTaskActionReceipts((current) => {
      const next = appendTaskActionReceipt(current, receipt);
      if (next === current) return current;
      saveTaskActionReceipts(
        typeof window === "undefined" ? null : window.sessionStorage,
        next,
        TASK_ACTION_RECEIPTS_STORAGE_KEY
      );
      return next;
    });
    setAppState((current) => {
      if (!current?.tasks) return current;
      return {
        ...current,
        tasks: mergeTaskStateWithActionReceipts(current.tasks, [receipt], {
          accountId: receipt.accountId || walletAccountId,
          walletAddress: receipt.walletAddress || linkedWalletAddress,
        }),
      };
    });
  }, [linkedWalletAddress, taskActionReceipts, walletAccountId]);
  const { addAccount, closeAccountLogin, logOut, logOutAllAccounts, removeRetainedAccount, switchAccount } = createAccountSwitcherActions({
    addingAccount,
    loadRetainedAccounts,
    lockWalletVault,
    onAddLoginClose: () => { setLoginOpen(false); setAddingAccount(false); },
    onAddLoginOpen: () => { setAddingAccount(true); setLoginOpen(true); setProfileMenuOpen(false); },
    onMessage: setProfileAuthMessage,
    onPendingChange: setAccountMenuPending,
    onTransitionChange: (transitioning) => {
      accountBoundaryRef.current = transitioning
        ? beginAccountBoundaryTransition(accountBoundaryRef.current)
        : cancelAccountBoundaryTransition(accountBoundaryRef.current);
      setAccountTransitioning(transitioning);
    },
    prepareTransition: () => { setSettingsOpen(false); setSelectedTask(null); setChatActionMenu(null); },
    selectedAccountId: session?.accountId || "",
  });
  async function startTelegramLinkFromProfileMenu() {
    if (!signedIn) {
      setLoginOpen(true);
      setProfileMenuOpen(false);
      return;
    }
    if (linkedTelegramProvider) {
      setProfileAuthMessage("Telegram is linked. Open Telegram and message the Task Node bot.");
      return;
    }
    if (!telegramProvider?.enabled) {
      setProfileAuthMessage(
        telegramProvider?.actionRequired ||
          telegramProvider?.message ||
          "Telegram linking is not available in this environment."
      );
      return;
    }
    setProfilePendingProvider("telegram");
    setProfileAuthMessage("");
    try {
      const result = await requestJson(`${telegramProvider.startPath}?redirect=/`);
      if (result.ok && result.body?.redirectUrl) {
        window.location.assign(result.body.redirectUrl);
        return;
      }
      setProfileAuthMessage(
        result.body?.message ||
          result.body?.actionRequired ||
          `Telegram returned HTTP ${result.status}.`
      );
    } catch (error) {
      setProfileAuthMessage(error?.message || "Telegram linking is unavailable.");
    } finally {
      setProfilePendingProvider("");
    }
  }
  async function renameRecentChat(chat, title) {
    const conversationId = chat?.conversationId || chat?.id || "";
    const result = await requestJson("/api/chat/conversation", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId, title }),
    });
    if (!result.ok || !result.body?.ok) {
      throw new Error(result.body?.error || result.body?.message || "Could not rename this chat.");
    }
    const nextTitle = result.body.conversation?.title || title;
    setActiveChat((current) =>
      current && (current.conversationId || current.id) === conversationId
        ? { ...current, title: nextTitle }
        : current
    );
    setChatRenameTarget(null);
    setChatActionMenu(null);
    await refreshAppState();
  }
  async function deleteRecentChat(chat) {
    const conversationId = chat?.conversationId || chat?.id || "";
    const result = await requestJson("/api/chat/conversation", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId }),
    });
    if (!result.ok || !result.body?.ok) {
      throw new Error(result.body?.error || result.body?.message || "Could not delete this chat.");
    }
    if (activeChatId === conversationId) {
      setActiveChat(null);
      setChatResetKey((key) => key + 1);
      navigateToView("chat");
    }
    setChatDeleteTarget(null);
    setChatActionMenu(null);
    await refreshAppState();
  }
  function toggleSidebar() {
    setSidebarOpen((open) => {
      if (open) {
        setChatActionMenu(null);
        setMoreMenuOpen(false);
        setProfileMenuOpen(false);
      }
      return !open;
    });
  }
  const extensionContext = {
    accountId: walletAccountId,
    appState,
    navigateToView,
    onWalletUnlock: openWalletVaultControl,
    runtimeConfig,
    walletSecret: walletSecretRef.current,
    onOpenMessages: () => navigateToView("messages"),
    onLoginRequired: () => setLoginOpen(true),
    onHiveUnreadChange: (unreadCount) => setHiveGroupStatus(current => ({ ...current, accountId: walletAccountId, unreadCount })),
  };
  const collaborationExtensions = appExtensionRegistry.menu("more", "collaboration", extensionContext);
  const insightExtensions = appExtensionRegistry.menu("more", "insight", extensionContext);
  const activeExtension = appExtensionRegistry.forView(view);
  return (
    <main className={`app-shell view-${view} ${sidebarOpen ? "" : "sidebar-collapsed"}`}>
      {sidebarOpen && (
        <button
          aria-label="Close navigation"
          className="mobile-sidebar-scrim"
          onClick={() => setSidebarOpen(false)}
          type="button"
        />
      )}
      <aside className="sidebar" aria-label="Primary">
        <div className="sidebar-header">
          {sidebarOpen && (
            <button
              className="sidebar-brand"
              onClick={() => navigateToView("chat")}
              type="button"
            >
              <PostFiatLogo />
              <span>Task Node</span>
            </button>
          )}
          <button
            aria-label={sidebarOpen ? "Collapse sidebar" : "Open sidebar"}
            className="icon-button sidebar-toggle"
            data-tooltip={sidebarOpen ? "Collapse sidebar" : "Open sidebar"}
            onClick={toggleSidebar}
            type="button"
          >
            {sidebarOpen ? (
              <>
                <PanelLeft className="desktop-sidebar-toggle-icon" size={18} strokeWidth={1.75} />
                <X className="mobile-sidebar-close-icon" size={20} strokeWidth={1.9} />
              </>
            ) : (
              <PostFiatLogo />
            )}
          </button>
        </div>
        <nav className="nav-list">
          <SidebarButton
            active={view === "chat" && !activeChat}
            icon={SquarePen}
            label="New chat"
            onClick={startNewChat}
            sidebarOpen={sidebarOpen}
          />
          <SidebarButton
            icon={Search}
            label="Search chats"
            onClick={() => setChatSearchOpen(true)}
            sidebarOpen={sidebarOpen}
          />
          <SidebarButton
            active={view === "tasks"}
            badge={appState?.tasks?.outstanding?.length}
            icon={ListTodo}
            label="Tasks"
            onClick={() => navigateToView("tasks")}
            sidebarOpen={sidebarOpen}
          />
          <SidebarButton
            active={view === "hive"}
            icon={Activity}
            label="Hive"
            onClick={() => navigateToView("hive")}
            sidebarOpen={sidebarOpen}
            trailing={sidebarOpen ? <small className="nav-live-state">live</small> : null}
          />
          <SidebarButton active={view === "hive-chat"} icon={Network} label="Hive chat"
            badge={hiveUnreadCount > 0 ? formatUnreadCount(hiveUnreadCount) : undefined}
            onClick={() => navigateToView("hive-chat")} sidebarOpen={sidebarOpen} />
          {runtimeConfig?.collaboration?.docsEnabled && (
            <SidebarButton
              active={view === "docs"}
              icon={FileText}
              label="Docs"
              onClick={() => {
                navigateToView("docs");
                if (!signedIn) setLoginOpen(true);
              }}
              sidebarOpen={sidebarOpen}
            />
          )}
          <SidebarButton
            active={view === "wallet"}
            icon={Wallet}
            label="Wallet"
            onClick={openWalletSummary}
            sidebarOpen={sidebarOpen}
            tooltip={`Wallet · ${vaultDisplay.label}`}
            trailing={
              <small className={`nav-vault-state is-${vaultDisplay.tone}`} title={vaultDisplay.detail}>
                {vaultDisplay.tone === "unlocked" ? <Unlock size={10} strokeWidth={2} /> : <Lock size={10} strokeWidth={2} />}
                {vaultDisplay.label}
              </small>
            }
          />
          <SidebarButton
            active={view === "context"}
            icon={BookOpen}
            label="Context"
            onClick={() => navigateToView("context")}
            sidebarOpen={sidebarOpen}
          />
          <div className="sidebar-menu-anchor" ref={moreRef}>
            <SidebarButton
              active={moreMenuOpen || MORE_EXTENSION_VIEWS.has(view)}
              icon={MoreHorizontal}
              label="More"
              onClick={() => {
                if (!sidebarOpen) {
                  setSidebarOpen(true);
                  return;
                }
                setMoreMenuOpen((open) => !open);
              }}
              sidebarOpen={sidebarOpen}
            />
            {moreMenuOpen && sidebarOpen && (
              <div className="sidebar-popout">
                {collaborationExtensions.map((extension) => (
                  <ToolMenuRow
                    icon={extension.icon}
                    key={extension.id}
                    label={extension.label}
                    onClick={() => {
                      navigateToView(extension.id);
                      if (extension.requiresAuth && !signedIn) setLoginOpen(true);
                    }}
                  />
                ))}
                {collaborationExtensions.length > 0 && <div className="menu-divider" />}
                <ToolMenuRow icon={Wand2} label="Context Refine" onClick={openContextRefine} />
                <ToolMenuRow icon={FileText} label="Context Rewrite" onClick={openContextRewrite} />
                <div className="menu-divider" />
                {insightExtensions.map((extension) => (
                  <ToolMenuRow
                    icon={extension.icon}
                    key={extension.id}
                    label={extension.label}
                    onClick={() => {
                      navigateToView(extension.id);
                      if (extension.requiresAuth && !signedIn) setLoginOpen(true);
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </nav>
        {sidebarOpen && (
          <section className="recents" aria-label="Recent chats" onScroll={() => setChatActionMenu(null)}>
            <div className="section-label">Recents</div>
            {recentChats.length > 0 ? (
              recentChats.map((item) => {
                const itemId = item.conversationId || item.id;
                const menuOpen = chatActionMenu?.id === item.id;
                const rowClassName = [
                  "recent-chat-row",
                  activeChatId === itemId ? "active" : "",
                  item.kind === "hive" ? "is-hive" : "",
                  item.unread ? "has-unread" : "",
                ].filter(Boolean).join(" ");
                return (
                  <div
                    className={rowClassName}
                    key={item.id}
                  >
                    <button
                      className="recent-chat-open"
                      onClick={() => openRecentChat(item)}
                      title={item.title}
                      type="button"
                    >
                      {item.kind === "hive" && <Network size={13} strokeWidth={1.8} />}
                      <span>{item.title}</span>
                      {item.unread && (
                        <small
                          aria-label={`${item.unreadCount || 1} unread Hive message${(item.unreadCount || 1) === 1 ? "" : "s"}`}
                          className="recent-chat-unread-badge"
                        >
                          {formatUnreadCount(item.unreadCount || 1)}
                        </small>
                      )}
                    </button>
                    {!item.readOnly && (
                      <button
                        aria-label={`Chat actions for ${item.title}`}
                        className="recent-chat-more"
                        onClick={(event) => {
                          event.stopPropagation();
                          setChatActionMenu(
                            menuOpen
                              ? null
                              : {
                                  ...item,
                                  menuPosition: chatActionMenuPosition(event.currentTarget),
                                }
                          );
                        }}
                        title="Chat actions"
                        type="button"
                      >
                        <MoreHorizontal size={16} strokeWidth={1.75} />
                      </button>
                    )}
                  </div>
                );
              })
            ) : (
              <div className="sidebar-note">No chats yet</div>
            )}
          </section>
        )}
        <div className="sidebar-footer">
          {sidebarOpen && (
            <button className="balance-pill" onClick={openWalletSummary} type="button">
              <span className="balance-stack">
                <span className="balance-row">
                  <Wallet size={14} strokeWidth={1.75} />
                  <strong>{pftBalance}</strong>
                  <span>PFT</span>
                </span>
                <span className="balance-row">
                  <CreditCard size={14} strokeWidth={1.75} />
                  <strong>{chatCredit}</strong>
                  <span>chat</span>
                </span>
                <span className={`balance-vault-state is-${vaultDisplay.tone}`} title={vaultDisplay.detail}>
                  {vaultDisplay.tone === "unlocked" ? <Unlock size={11} strokeWidth={2} /> : <Lock size={11} strokeWidth={2} />}
                  <span>{vaultDisplay.label}</span>
                </span>
              </span>
              <ChevronRight size={14} strokeWidth={1.75} />
            </button>
          )}
          {sidebarOpen && (
            <div className="profile-anchor" ref={profileRef}>
              <button
                className="profile-button"
                aria-label={signedIn ? `${profileName}, ${profileSubtext}` : "Log in or sign up"}
                disabled={appStateLoading}
                onClick={() => {
                  if (appStateLoading) return;
                  setProfileMenuOpen((open) => !open);
                  if (!profileMenuOpen && signedIn) loadRetainedAccounts().catch(() => null);
                }}
                type="button"
              >
                <ProfileAvatar imageCandidates={profileAvatarImages} initials={profileInitials} signedIn={signedIn} seed={session?.accountId} />
                <>
                  <span className="profile-copy">
                    <strong>{profileName}</strong>
                    <small>{profileSubtext}</small>
                  </span>
                  {signedIn ? (
                    <Check className="profile-state-icon" size={14} strokeWidth={2} />
                  ) : (
                    <Store size={14} strokeWidth={1.75} />
                  )}
                </>
              </button>
              {profileMenuOpen && (
                <div className="profile-menu">
                  <button
                    className="profile-menu-header"
                    onClick={() => {
                      if (signedIn) {
                        navigateToView("profile");
                      } else {
                        setLoginOpen(true);
                      }
                      setProfileMenuOpen(false);
                    }}
                    type="button"
                  >
                    <ProfileAvatar imageCandidates={profileAvatarImages} initials={profileInitials} signedIn={signedIn} seed={session?.accountId} />
                    <span className="profile-copy">
                      <strong>{profileName}</strong>
                      <small>{profileSubtext}</small>
                    </span>
                    <ChevronRight size={16} strokeWidth={1.75} />
                  </button>
                  {signedIn && (
                    <div className="profile-session-state">
                      <Check size={13} strokeWidth={2} />
                      <span>Signed in</span>
                    </div>
                  )}
                  {signedIn && (
                    <ProfileAccountSwitcher
                      accounts={retainedAccounts}
                      managing={managingAccounts}
                      onAdd={addAccount}
                      onManagingChange={setManagingAccounts}
                      onRemove={removeRetainedAccount}
                      onSwitch={switchAccount}
                      pending={accountMenuPending}
                      selectedAccountId={session?.accountId || ""}
                    />
                  )}
                  {signedIn && linkedWalletAddress && (
                    <ToolMenuRow
                      icon={vaultDisplay.tone === "unlocked" ? Unlock : Lock}
                      label={`Wallet ${vaultDisplay.label}`}
                      onClick={openWalletVaultControl}
                      trailing={<ChevronRight size={14} strokeWidth={1.75} />}
                    />
                  )}
                  <div className="menu-divider" />
                  {signedIn ? (
                    <>
                      <ToolMenuRow
                        icon={Network}
                        label="Directory"
                        onClick={() => {
                          navigateToView("directory");
                          setProfileMenuOpen(false);
                        }}
                        trailing={<ChevronRight size={14} strokeWidth={1.75} />}
                      />
                      <TelegramProfileMenuRow
                        linkedProvider={linkedTelegramProvider}
                        onClick={startTelegramLinkFromProfileMenu}
                        pending={profilePendingProvider === "telegram"}
                        provider={telegramProvider}
                        signedIn={signedIn}
                      />
                      {profileAuthMessage && <div className="profile-menu-message">{profileAuthMessage}</div>}
                      <ToolMenuRow
                        icon={SettingsIcon}
                        label="Settings"
                        onClick={() => {
                          setSettingsOpen(true);
                          setProfileMenuOpen(false);
                        }}
                      />
                      <ToolMenuRow
                        icon={UserIcon}
                        label="Profile"
                        onClick={() => {
                          navigateToView("profile");
                        }}
                      />
                      <ToolMenuRow icon={LifeBuoy} label="Help" onClick={() => navigateToView("help")} trailing={<ChevronRight size={14} />} />
                      <div className="menu-divider" />
                      {logoutConfirming ? (
                        <div className="profile-menu-logout-confirm">
                          <span>Log out? Your wallet vault will lock.</span>
                          <div>
                            <button className="pill-button" onClick={() => setLogoutConfirming(false)} type="button">
                              Cancel
                            </button>
                            <button className="pill-button dark" onClick={logOut} type="button">
                              Log out this account
                            </button>
                          </div>
                        </div>
                      ) : (
                        <ToolMenuRow icon={LogOut} label="Log out this account" onClick={() => setLogoutConfirming(true)} />
                      )}
                      <ToolMenuRow icon={LogOut} label="Log out all accounts" onClick={logOutAllAccounts} />
                    </>
                  ) : (
                    <>
                      <ToolMenuRow
                        icon={Store}
                        label="Log in or sign up"
                        onClick={() => {
                          setLoginOpen(true);
                          setProfileMenuOpen(false);
                        }}
                        trailing={<ChevronRight size={14} />}
                      />
                      <ToolMenuRow icon={LifeBuoy} label="Help" onClick={() => navigateToView("help")} trailing={<ChevronRight size={14} />} />
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </aside>
      <section className="workspace">
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-button topbar-new-chat" onClick={startNewChat} title="New chat" type="button">
              <SquarePen size={18} strokeWidth={1.75} />
            </button>
            <button
              className="mobile-brand-button"
              onClick={() => {
                setSidebarOpen(true);
                setMoreMenuOpen(false);
                setProfileMenuOpen(false);
                setChatActionMenu(null);
              }}
              type="button"
            >
              <PostFiatLogo />
              <span>Task Node</span>
            </button>
          </div>
          {view === "chat" && activeChat && (
            <div className="thread-actions">
              <button aria-label="Share chat" onClick={() => setChatShareRequestKey((key) => key + 1)} title="Share" type="button">
                <Share size={14} strokeWidth={1.75} />
                <span>Share</span>
              </button>
            </div>
          )}
          {signedIn && view !== "chat" && (
            <button className="mobile-topbar-action" onClick={startNewChat} title="New chat" type="button">
              <Pencil size={22} strokeWidth={1.75} />
            </button>
          )}
        </header>
        {loadError && <StatusBanner tone="error">{loadError}</StatusBanner>}
        {appStateLoading && <StatusBanner>Loading product state</StatusBanner>}
        {signedIn && hiveGroupStatus?.accountId === session?.accountId && hiveGroupStatus?.messaging && !hiveGroupStatus.messaging.binding && messagesPromptDismissed !== session.accountId && !["messages", "hive-chat"].includes(view) && (
          <div className="hive-messages-setup"><span>Join Hive chat with your Task Node handle.</span><button onClick={() => navigateToView("messages")} type="button">Set up Messages</button><button aria-label="Dismiss Messages setup" onClick={() => setMessagesPromptDismissed(session.accountId)} type="button"><X size={14} /></button></div>
        )}
        {canRenderWorkspaceContent && !accountTransitioning && (
        <RouteErrorBoundary resetKey={view}>
          {view === "chat" && (
            <ChatSurface
              accountId={walletAccountId}
              activeChat={activeChat}
              chatResetKey={chatResetKey}
              chatSelectionKey={chatSelectionKey}
              chatShareRequestKey={chatShareRequestKey}
              chat={appState?.chat}
              contextRefinePending={contextRefinePending}
              contextRewritePending={contextRewritePending}
              directOffchainTaskLifecycle={directOffchainTaskLifecycle}
              linkedWalletAddress={linkedWalletAddress}
              onActiveChatChange={setActiveChat}
              onChatSettled={refreshAppState}
              onContextRefineHandled={() => setContextRefinePending(false)}
              onContextRewriteHandled={() => setContextRewritePending(false)}
              onWalletUnlock={openWalletVaultControl}
              usage={appState?.usage}
              walletSecret={walletSecretRef.current}
              walletUnlockPending={walletUnlockOpen}
              walletVault={walletVaultStatus}
            />
          )}
          {view === "tasks" && (
            <TasksView
              accountId={walletAccountId}
              directOffchainTaskLifecycle={directOffchainTaskLifecycle}
              linkedWalletAddress={linkedWalletAddress}
              onRequestSettled={refreshAppState}
              onSelectTask={openTaskDetail}
              onWalletUnlock={openWalletVaultControl}
              tasks={visibleTasks}
              walletSecret={walletSecretRef.current}
              walletUnlockPending={walletUnlockOpen}
              walletVault={walletVaultStatus}
            />
          )}
          {view === "hive" && (
            <Suspense fallback={<StatusBanner>Loading hive</StatusBanner>}>
              <HiveView pftlExplorerUrl={runtimeConfig?.pftlExplorerUrl || ""} onOpenChat={() => navigateToView("hive-chat")} />
            </Suspense>
          )}
          {view === "directory" && (
            <Suspense fallback={<StatusBanner>Loading directory</StatusBanner>}>
              <DirectoryView />
            </Suspense>
          )}
          {view === "wallet" && (
            <Suspense fallback={<StatusBanner>Loading wallet</StatusBanner>}>
              <WalletView
                onAppStateChange={refreshAppState}
                onWalletBalanceRefresh={() => refreshWalletBalance({ force: true })}
                onLoginRequired={() => setLoginOpen(true)}
                onWalletVaultChange={() => refreshWalletVaultStatus({ preserveUnlock: true })}
                onWalletVaultLock={lockWalletVault}
                onWalletVaultUnlocked={handleWalletVaultUnlocked}
                session={appState?.session}
                wallet={appState?.wallet}
                walletSecret={walletSecretRef.current}
                walletVault={walletVaultStatus}
                usage={appState?.usage}
              />
            </Suspense>
          )}
          {view === "context" && (
            <Suspense fallback={<StatusBanner>Loading context</StatusBanner>}>
              <ContextView
                context={appState?.context}
                linkedWalletAddress={linkedWalletAddress}
                onContextChange={refreshAppState}
                onHydrateContext={hydrateContextPointer}
                onPublishContext={publishContextPointer}
                walletVault={walletVaultStatus}
              />
            </Suspense>
          )}
          {view === "profile" && memberProfileAccountId && (
            <Suspense fallback={<StatusBanner>Loading profile</StatusBanner>}>
              <MemberProfilePage
                accountId={memberProfileAccountId}
                onBack={() => navigateToView("directory")}
              />
            </Suspense>
          )}
          {view === "profile" && !memberProfileAccountId && (
            <Suspense fallback={<StatusBanner>Loading profile</StatusBanner>}>
              <ProfilePage
                accountId={walletAccountId}
                linkedWalletAddress={linkedWalletAddress}
                onProfileAvatarChange={setProfileAvatarNft}
                onProfileIdentityChange={refreshAppState}
                onWalletUnlock={openWalletVaultControl}
                pftlExplorerUrl={runtimeConfig?.pftlExplorerUrl || ""}
                profilePublic={profilePublic}
                profileTab={profileTab}
                session={appState?.session}
                setProfilePublic={setProfilePublic}
                setProfileTab={setProfileTab}
                walletSecret={walletSecretRef.current}
                walletVault={walletVaultStatus}
              />
            </Suspense>
          )}
          {view === "docs" && (
            <Suspense fallback={<StatusBanner>Loading docs</StatusBanner>}>
              <DocsLibraryView
                collaboration={runtimeConfig?.collaboration}
                onLogin={() => setLoginOpen(true)}
                onWalletUnlock={openWalletVaultControl}
                signedIn={signedIn}
                tasks={visibleTasks}
                walletSecret={walletSecretRef.current}
                walletVault={walletVaultStatus}
              />
            </Suspense>
          )}
          {activeExtension && <ExtensionSurface context={extensionContext} extension={activeExtension} />}
          {view === "help" && (
            <Suspense fallback={<StatusBanner>Loading help</StatusBanner>}>
              <HelpView />
            </Suspense>
          )}
        </RouteErrorBoundary>
        )}
      </section>
      {accountTransitioning && <div className="account-transition-overlay" role="status">Switching accounts securely…</div>}
      {loginOpen && (
        <LoginDialog
          authLoading={appStateLoading}
          onSessionChange={refreshAppState}
          session={session}
          reloadOnSuccess={addingAccount}
          onClose={closeAccountLogin}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          chat={appState?.chat} linkedWallet={linkedWallet}
          onAppStateChange={refreshAppState}
          onClose={() => setSettingsOpen(false)} onWalletUnlock={openWalletVaultControl}
          session={session}
          setTheme={setTheme}
          theme={theme} themeSessionOnly={themeSessionOnly} walletSecret={walletSecretRef.current} walletVault={walletVaultStatus}
        />
      )}
      {identityHandleRequired && !identityPromptDismissed && !loginOpen && (
        <IdentityHandleDialog
          onClose={() => setIdentityPromptDismissed(true)}
          onSaved={refreshAppState}
          session={session}
        />
      )}
      {selectedTaskForModal && (
        <TaskDetailModal
          accountId={walletAccountId}
          escapeDisabled={walletUnlockOpen}
          linkedWalletAddress={linkedWalletAddress}
          onClose={closeTaskDetail}
          onTaskActionReceipt={recordTaskActionReceipt}
          onTaskChanged={refreshAppState}
          onWalletUnlock={openWalletVaultControl}
          task={selectedTaskForModal}
          directOffchainTaskLifecycle={directOffchainTaskLifecycle}
          walletSecret={walletSecretRef.current}
          walletUnlockPending={walletUnlockOpen}
          walletVault={walletVaultStatus}
          pftlExplorerUrl={runtimeConfig?.pftlExplorerUrl || ""}
        />
      )}
      {chatSearchOpen && (
        <ChatSearchModal
          onClose={() => setChatSearchOpen(false)}
          onOpenChat={(item) => {
            setChatSearchOpen(false);
            openRecentChat(item);
          }}
          recentChats={recentChats}
          signedIn={signedIn}
        />
      )}
      {walletUnlockOpen && linkedWallet && (
        <WalletUnlockModal
          linkedWallet={linkedWallet}
          onClose={() => setWalletUnlockOpen(false)}
          onWalletVaultChange={() => refreshWalletVaultStatus({ preserveUnlock: false })}
          onWalletVaultUnlocked={handleWalletVaultUnlocked}
          session={session}
        />
      )}
      {chatActionMenu && sidebarOpen && (
        <ChatItemActionMenu
          chat={chatActionMenu}
          menuRef={chatActionRef}
          onDelete={() => {
            setChatDeleteTarget(chatActionMenu);
            setChatActionMenu(null);
          }}
          onRename={() => {
            setChatRenameTarget(chatActionMenu);
            setChatActionMenu(null);
          }}
          style={chatActionMenu.menuPosition}
        />
      )}
      {chatRenameTarget && (
        <RenameChatModal
          chat={chatRenameTarget}
          onClose={() => setChatRenameTarget(null)}
          onSave={(title) => renameRecentChat(chatRenameTarget, title)}
        />
      )}
      {chatDeleteTarget && (
        <DeleteChatModal
          chat={chatDeleteTarget}
          onClose={() => setChatDeleteTarget(null)}
          onDelete={() => deleteRecentChat(chatDeleteTarget)}
        />
      )}
    </main>
  );
}

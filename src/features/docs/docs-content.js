// Every Markdown loader in this module must also appear in
// docs/public-help-manifest.json. `npm run public-help-check` enforces the
// boundary so private operations, verification evidence, plans, and prompts do
// not silently become production browser assets.
const HELP_MARKDOWN_LOADERS = {
  start: () => import("../../../docs/wiki/index.md?raw").then((module) => module.default),
  agents: () => import("../../../docs/wiki/surfaces/agents.md?raw").then((module) => module.default),
  chat: () => import("../../../docs/wiki/surfaces/chat.md?raw").then((module) => module.default),
  context: () => import("../../../docs/wiki/surfaces/context.md?raw").then((module) => module.default),
  contextRewrite: () => import("../../../docs/wiki/surfaces/context-rewrite.md?raw").then((module) => module.default),
  dailyAirdrop: () => import("../../../docs/wiki/surfaces/daily-airdrop.md?raw").then((module) => module.default),
  directory: () => import("../../../docs/wiki/surfaces/directory.md?raw").then((module) => module.default),
  docs: () => import("../../../docs/wiki/surfaces/docs.md?raw").then((module) => module.default),
  hive: () => import("../../../docs/wiki/surfaces/hive.md?raw").then((module) => module.default),
  memory: () => import("../../../docs/wiki/surfaces/memory.md?raw").then((module) => module.default),
  messages: () => import("../../../docs/wiki/surfaces/messages.md?raw").then((module) => module.default),
  profile: () => import("../../../docs/wiki/surfaces/profile.md?raw").then((module) => module.default),
  refineContext: () => import("../../../docs/wiki/surfaces/refine-context.md?raw").then((module) => module.default),
  search: () => import("../../../docs/wiki/surfaces/search.md?raw").then((module) => module.default),
  tasks: () => import("../../../docs/wiki/surfaces/tasks.md?raw").then((module) => module.default),
  team: () => import("../../../docs/wiki/surfaces/team.md?raw").then((module) => module.default),
  userGuide: () => import("../../../docs/wiki/surfaces/user-guide.md?raw").then((module) => module.default),
  wallet: () => import("../../../docs/wiki/surfaces/wallet.md?raw").then((module) => module.default),
  aiProviders: () => import("../../../docs/wiki/architecture/ai-providers.md?raw").then((module) => module.default),
  authAndConnectedAccounts: () => import("../../../docs/wiki/architecture/auth-and-connected-accounts.md?raw").then((module) => module.default),
  authWalletBoundary: () => import("../../../docs/wiki/architecture/auth-wallet-boundary.md?raw").then((module) => module.default),
  bootup: () => import("../../../docs/wiki/architecture/bootup.md?raw").then((module) => module.default),
  currentSystem: () => import("../../../docs/wiki/architecture/current-system.md?raw").then((module) => module.default),
  defectRepairRule: () => import("../../../docs/wiki/architecture/defect-repair-rule.md?raw").then((module) => module.default),
  encryption: () => import("../../../docs/wiki/architecture/encryption.md?raw").then((module) => module.default),
  styleGuide: () => import("../../../docs/wiki/architecture/style-guide.md?raw").then((module) => module.default),
};

function docBody(markdown = "") {
  return String(markdown || "")
    .replace(/^# .*(?:\r?\n)+/, "")
    .trim();
}

function docSection(title, markdown) {
  const body = docBody(markdown);
  return [`## ${title}`, body].filter(Boolean).join("\n\n");
}

function movedDoc(title, canonicalSlug, canonicalTitle) {
  return [
    `# ${title}`,
    `This old Help location is no longer part of the public documentation set. See [${canonicalTitle}](#docs/${canonicalSlug}).`,
  ].join("\n\n");
}

async function loadIdentityAndWallets() {
  const [authAndConnectedAccounts, authWalletBoundary] = await Promise.all([
    HELP_MARKDOWN_LOADERS.authAndConnectedAccounts(),
    HELP_MARKDOWN_LOADERS.authWalletBoundary(),
  ]);
  return [
    "# Identity & Wallets",
    "Account login, retained-account selection, connected providers, wallet proof, local vault unlock, and custody are separate security states.",
    docSection("Login, Account Switching, And Corbanu Linking", authAndConnectedAccounts),
    docSection("Wallet Proof And Local Vault", authWalletBoundary),
  ].join("\n\n");
}

const systemStatusIntro = [
  "# System Status",
  "This page renders live status returned by Task Node. A healthy web process does not prove that background workers, queues, providers, protocol endpoints, or dependent services are healthy.",
  "Inference uses Vercel AI Gateway first, with Ambient as backup. Provider configuration and live availability are distinct states.",
  "Status links lead only to the public product and architecture documentation allowlist.",
].join("\n\n");

export const SYSTEM_STATUS_DOC_LINKS = {
  board_manager: { slug: "hive", label: "Docs: Hive" },
  board_manager_secretary_packets: { slug: "hive", label: "Docs: Hive" },
  hive_group_chat: { slug: "hive", label: "Docs: Hive group chat" },
  hive_secretary: { slug: "hive", label: "Docs: Hive" },
  hive_active_projects: { slug: "hive", label: "Docs: Hive" },
  network_task_generation: { slug: "tasks", label: "Docs: Tasks" },
  task_generation: { slug: "tasks", label: "Docs: Tasks" },
  task_review: { slug: "tasks", label: "Docs: Tasks" },
  pftl_hot_sync: { slug: "wallet", label: "Docs: Wallet" },
  pftl_archive_sync: { slug: "current-system", label: "Docs: Current System" },
  pftl_wss_watcher: { slug: "current-system", label: "Docs: Current System" },
  pftl_cache_reducer: { slug: "current-system", label: "Docs: Current System" },
  pftl_cache_retention: { slug: "current-system", label: "Docs: Current System" },
  pftl_current_rpc: { slug: "wallet", label: "Docs: Wallet" },
  pftl_history_rpc: { slug: "current-system", label: "Docs: Current System" },
  ethereum_deposit_rpc: { slug: "wallet", label: "Docs: Wallet" },
  jobs_pgvector_corpus: { slug: "chat", label: "Docs: Chat" },
  chat_turn_memory: { slug: "memory", label: "Docs: Memory" },
  rewarded_task_memory: { slug: "memory", label: "Docs: Memory" },
  deep_memory: { slug: "memory", label: "Docs: Memory" },
  network_task_profile: { slug: "profile", label: "Docs: Profile" },
  daily_airdrop_worker: { slug: "daily-airdrop", label: "Docs: Daily Airdrop" },
  agent_activity: { slug: "agents", label: "Docs: Agents" },
  orc_agents: { slug: "agents", label: "Docs: Agents" },
  orc_activity: { slug: "agents", label: "Docs: Agents" },
  orc_runtime_directives: { slug: "agents", label: "Docs: Agents" },
  orc_review_queue: { slug: "agents", label: "Docs: Agents" },
  orc_task_review_queue: { slug: "agents", label: "Docs: Agents" },
  sybil_review_flags: { slug: "agents", label: "Docs: Agents" },
  sybil_detection: { slug: "agents", label: "Docs: Agents" },
};

export const DOC_GROUPS = [
  {
    title: "Start",
    pages: [
      {
        slug: "system-status-home",
        title: "System Status",
        summary: "Live worker, queue, provider, and protocol status.",
        markdown: systemStatusIntro,
        component: "system-status",
      },
      {
        slug: "user-guide",
        title: "User Guide",
        summary: "Guide to Task Node, including Settings → General → Appearance (System, Light, Dark).",
        loadMarkdown: HELP_MARKDOWN_LOADERS.userGuide,
      },
      {
        slug: "start",
        title: "Start Here",
        summary: "Product map, trust boundaries, and documentation authority.",
        loadMarkdown: HELP_MARKDOWN_LOADERS.start,
      },
    ],
  },
  {
    title: "Product",
    pages: [
      { slug: "chat", title: "Chat", summary: "Model selection, API-rate chat billing, persistence, and recovery.", loadMarkdown: HELP_MARKDOWN_LOADERS.chat },
      { slug: "tasks", title: "Tasks", summary: "Personal and network tasks, submission requirements, request progress, retry and dismissal.", loadMarkdown: HELP_MARKDOWN_LOADERS.tasks },
      { slug: "hive", title: "Hive", summary: "Public Nostr group chat, shared handles, periodic GLM participation and Kimi board escalation.", loadMarkdown: HELP_MARKDOWN_LOADERS.hive },
      { slug: "docs", title: "Docs", summary: "Encrypted documents, spreadsheets, folders, and chat with Coach and ODV.", loadMarkdown: HELP_MARKDOWN_LOADERS.docs },
      { slug: "team", title: "Team", summary: "Shared task history and Team Context in the app and Corbanu Terminal.", loadMarkdown: HELP_MARKDOWN_LOADERS.team },
      { slug: "messages", title: "Messages", summary: "Activate your shared Messages and Hive identity; send private NIP-17 messages.", loadMarkdown: HELP_MARKDOWN_LOADERS.messages },
      { slug: "wallet", title: "Wallet", summary: "Identity, balances, activity, custody, and signing.", loadMarkdown: HELP_MARKDOWN_LOADERS.wallet },
      { slug: "context", title: "Context", summary: "Durable account working context.", loadMarkdown: HELP_MARKDOWN_LOADERS.context },
      { slug: "memory", title: "Memory", summary: "Inspectable chat and work compression.", loadMarkdown: HELP_MARKDOWN_LOADERS.memory },
      { slug: "profile", title: "Profile", summary: "Named Profile Pic NFTs, full-size artwork viewing, three-task eligibility, and private Kimi ZDR generation.", loadMarkdown: HELP_MARKDOWN_LOADERS.profile },
      { slug: "directory", title: "Directory", summary: "Discoverable public member profiles.", loadMarkdown: HELP_MARKDOWN_LOADERS.directory },
      { slug: "search", title: "Search", summary: "Account-scoped chat retrieval.", loadMarkdown: HELP_MARKDOWN_LOADERS.search },
      { slug: "daily-airdrop", title: "Daily Airdrop", summary: "Contributor scoring and issuance state.", loadMarkdown: HELP_MARKDOWN_LOADERS.dailyAirdrop },
      { slug: "refine-context", title: "Refine Context", summary: "Targeted Context editing.", loadMarkdown: HELP_MARKDOWN_LOADERS.refineContext },
      { slug: "context-rewrite", title: "Context Rewrite", summary: "Asynchronous full-document rewrite.", loadMarkdown: HELP_MARKDOWN_LOADERS.contextRewrite },
      { slug: "agents", title: "Agents", summary: "External wallet-native workers.", loadMarkdown: HELP_MARKDOWN_LOADERS.agents },
    ],
  },
  {
    title: "Security & Architecture",
    pages: [
      {
        slug: "identity-wallets",
        title: "Identity & Wallets",
        summary: "Password login, account switching, provider linkage, wallet proof, vault, and custody boundaries.",
        loadMarkdown: loadIdentityAndWallets,
      },
      {
        slug: "current-system",
        title: "Current System",
        summary: "Implemented trust, process, persistence, and privacy boundaries.",
        loadMarkdown: HELP_MARKDOWN_LOADERS.currentSystem,
      },
      {
        slug: "encryption",
        title: "Encryption",
        summary: "Encryption formats and browser/server responsibilities.",
        loadMarkdown: HELP_MARKDOWN_LOADERS.encryption,
      },
      {
        slug: "ai-providers",
        title: "AI Providers",
        summary: "Inference-provider and isolated image-renderer boundaries.",
        loadMarkdown: HELP_MARKDOWN_LOADERS.aiProviders,
      },
    ],
  },
  {
    title: "Contributing",
    pages: [
      {
        slug: "bootup",
        title: "Local Bootup",
        summary: "Safe local startup and focused verification.",
        loadMarkdown: HELP_MARKDOWN_LOADERS.bootup,
      },
      {
        slug: "defect-repair-rule",
        title: "Defect Repair Rule",
        summary: "Fix failed boundaries rather than literal examples.",
        loadMarkdown: HELP_MARKDOWN_LOADERS.defectRepairRule,
      },
      {
        slug: "style-guide",
        title: "Style Guide",
        summary: "Visual system and interaction rules.",
        loadMarkdown: HELP_MARKDOWN_LOADERS.styleGuide,
      },
    ],
  },
];

const LEGACY_REDIRECTS = [
  ["deployment", "Deployment", "current-system", "Current System"],
  ["pftl", "PFTL", "wallet", "Wallet"],
  ["ethereum-deposit-rpc", "Ethereum Deposits", "wallet", "Wallet"],
  ["task-generation", "Task Generation", "tasks", "Tasks"],
  ["hive-operations", "Hive Operations", "hive", "Hive"],
  ["orc-operator-runtime", "Agent Operations", "agents", "Agents"],
  ["jobs-pgvector-corpus", "Jobs Corpus", "chat", "Chat"],
  ["telegram-bot-chat", "Telegram Chat", "identity-wallets", "Identity & Wallets"],
  ["system-status", "System Status", "system-status-home", "System Status"],
].map(([slug, title, canonicalSlug, canonicalTitle]) => ({
  slug,
  title,
  summary: `Legacy location. See ${canonicalTitle}.`,
  markdown: movedDoc(title, canonicalSlug, canonicalTitle),
  group: "Legacy Redirects",
}));

export const DOC_PAGES = [
  ...DOC_GROUPS.flatMap((group) => group.pages.map((page) => ({ ...page, group: group.title }))),
  ...LEGACY_REDIRECTS,
];

const markdownCache = new Map();

export async function loadDocMarkdown(pageOrSlug) {
  const page = typeof pageOrSlug === "string"
    ? DOC_PAGES.find((candidate) => candidate.slug === pageOrSlug)
    : pageOrSlug;
  if (!page) throw new Error("Unknown Help page.");
  if (typeof page.markdown === "string") return page.markdown;
  if (typeof page.loadMarkdown !== "function") return "";
  if (markdownCache.has(page.slug)) return markdownCache.get(page.slug);

  const pending = Promise.resolve(page.loadMarkdown())
    .then((markdown) => String(markdown || ""))
    .catch((error) => {
      markdownCache.delete(page.slug);
      throw error;
    });
  markdownCache.set(page.slug, pending);
  return pending;
}

export async function loadDocSearchIndex() {
  const entries = await Promise.all(DOC_PAGES.map(async (page) => [page.slug, await loadDocMarkdown(page)]));
  return Object.fromEntries(entries);
}

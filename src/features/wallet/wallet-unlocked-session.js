const UNLOCKED_SESSION_PREFIX = "tasknode:wallet-unlocked-session:v2:";
const LEGACY_UNLOCKED_SESSION_PREFIXES = ["tasknode:wallet-unlocked-session:v1:"];
const LAST_ACTIVE_KEY = "tasknode:wallet-unlocked-session:last-active";
const SESSION_CRYPTO_KEY_STORAGE_KEY = "tasknode:wallet-unlocked-session:aes-key";

export const DEFAULT_WALLET_UNLOCK_IDLE_LOCK_MINUTES = 30;

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

export function walletUnlockIdleLockMs(rawMinutes) {
  const configured = rawMinutes !== undefined
    ? rawMinutes
    : globalThis.__TASKNODE_CONFIG__?.walletUnlockIdleLockMinutes;
  // Explicit 0 / "0" disables the idle auto-lock entirely (set
  // TASKNODE_WALLET_UNLOCK_IDLE_LOCK_MINUTES=0 to turn it off).
  if (configured === 0 || configured === "0") return 0;
  const minutes = Number(configured || DEFAULT_WALLET_UNLOCK_IDLE_LOCK_MINUTES);
  const bounded = Number.isFinite(minutes) && minutes > 0
    ? Math.min(Math.max(minutes, 1), 24 * 60)
    : DEFAULT_WALLET_UNLOCK_IDLE_LOCK_MINUTES;
  return Math.round(bounded * 60_000);
}

export function walletUnlockIdleLockMinutes(rawMinutes) {
  return Math.round(walletUnlockIdleLockMs(rawMinutes) / 60_000);
}

function browserSessionStorage() {
  try {
    return typeof globalThis !== "undefined" && globalThis.sessionStorage
      ? globalThis.sessionStorage
      : null;
  } catch {
    return null;
  }
}

function sessionKey(accountId = "") {
  const normalized = safeText(accountId, 180);
  return normalized ? `${UNLOCKED_SESSION_PREFIX}${normalized}` : "";
}

function normalizeUnlockedWalletSession(value = {}) {
  const accountId = safeText(value.accountId, 180);
  const address = safeText(value.address, 120);
  const mnemonic = safeText(value.mnemonic, 400);
  if (!accountId || !address || !mnemonic) return null;
  return {
    accountId,
    address,
    publicKey: safeText(value.publicKey, 180) || null,
    derivationPath: safeText(value.derivationPath, 120) || null,
    mnemonic,
    unlockedAt: safeText(value.unlockedAt, 80) || new Date().toISOString(),
  };
}

function listStorageKeys(storage) {
  const keys = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key) keys.push(key);
    }
  } catch {
    return [];
  }
  return keys;
}

function isUnlockedSessionKey(key = "") {
  return (
    key.startsWith(UNLOCKED_SESSION_PREFIX) ||
    LEGACY_UNLOCKED_SESSION_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return globalThis.btoa(binary);
}

function base64ToBytes(text = "") {
  const binary = globalThis.atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

// The AES-GCM key is co-located with the encrypted envelope in the SAME
// sessionStorage, so a reload restores both together. The previous design kept
// the key in IndexedDB and the envelope in sessionStorage; on browsers that
// partition or evict IndexedDB on reload (Windows Edge Tracking Prevention,
// Chrome storage partitioning, InPrivate/incognito, some corporate policies)
// the key was lost while the envelope survived, so every reload failed to
// decrypt and forced a full seed re-entry. sessionStorage persists across
// reloads within the tab, so the unlock now survives a reload within the idle
// window. The key is exportable only so it can be serialized next to the
// envelope; both are already reachable by any script with sessionStorage
// access, so this does not lower the threat model versus the prior split-store
// design (the real boundaries are the per-tab sessionStorage lifecycle and the
// idle auto-lock).
export function createSessionStorageKeyStore(storage, cryptoObj = globalThis.crypto) {
  const subtle = cryptoObj?.subtle || null;
  const memoryKey = { current: null };
  let generation = 0;

  async function importFromBytes(bytes) {
    if (!subtle) return null;
    return subtle.importKey("raw", bytes, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
  }

  function readStored() {
    try {
      return storage ? storage.getItem(SESSION_CRYPTO_KEY_STORAGE_KEY) : null;
    } catch {
      return null;
    }
  }

  function writeStored(value) {
    try {
      if (storage) storage.setItem(SESSION_CRYPTO_KEY_STORAGE_KEY, value);
    } catch {
      /* ignore quota / disabled storage */
    }
  }

  return {
    get: async () => {
      if (!subtle) return memoryKey.current;
      const stored = readStored();
      if (stored) {
        try {
          return await importFromBytes(base64ToBytes(stored));
        } catch {
          /* fall through to in-memory key */
        }
      }
      return memoryKey.current;
    },
    set: async (key) => {
      const started = generation;
      if (!subtle) {
        memoryKey.current = key;
        return;
      }
      try {
        const raw = await subtle.exportKey("raw", key);
        if (started !== generation) return;
        writeStored(bytesToBase64(new Uint8Array(raw)));
      } catch {
        if (started !== generation) return;
        memoryKey.current = key;
      }
    },
    clear: () => {
      generation += 1;
      memoryKey.current = null;
      try {
        if (storage) storage.removeItem(SESSION_CRYPTO_KEY_STORAGE_KEY);
      } catch {
        /* ignore */
      }
    },
  };
}

export function createUnlockedWalletSessionStore({
  storage = browserSessionStorage(),
  cryptoObj = globalThis.crypto,
  keyStore = null,
  now = () => Date.now(),
} = {}) {
  const keys = keyStore || createSessionStorageKeyStore(storage, cryptoObj);
  const subtle = cryptoObj?.subtle || null;
  let keyPromise = null;
  let generation = 0;

  async function sessionCryptoKey() {
    const started = generation;
    if (!subtle) return null;
    if (!keyPromise) {
      keyPromise = (async () => {
        const existing = await keys.get().catch(() => null);
        if (started !== generation) return null;
        if (existing) return existing;
        // Extractable so the key can be serialized into sessionStorage next to
        // the envelope (see createSessionStorageKeyStore).
        const generated = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
          "encrypt",
          "decrypt",
        ]);
        if (started !== generation) return null;
        await keys.set(generated).catch(() => null);
        return started === generation ? generated : null;
      })().catch(() => null);
    }
    return keyPromise;
  }

  function touchActivity() {
    if (!storage) return false;
    try {
      storage.setItem(LAST_ACTIVE_KEY, String(now()));
      return true;
    } catch {
      return false;
    }
  }

  function idleRemainingMs({ idleLockMs = walletUnlockIdleLockMs() } = {}) {
    if (!storage || !(idleLockMs > 0)) return null;
    const lastActive = Number(storage.getItem(LAST_ACTIVE_KEY) || 0);
    if (!Number.isFinite(lastActive) || lastActive <= 0) return null;
    return Math.max(0, idleLockMs - (now() - lastActive));
  }

  function clearAll() {
    generation += 1;
    if (!storage) return false;
    for (const key of listStorageKeys(storage)) {
      if (isUnlockedSessionKey(key)) storage.removeItem(key);
    }
    storage.removeItem(LAST_ACTIVE_KEY);
    keys.clear?.();
    // Drop the cached key handle too: keys.clear() wiped the AES key from
    // storage, so the next unlock must regenerate AND re-persist it. Leaving
    // keyPromise set would re-encrypt the new envelope with a key that no
    // longer exists in storage, and the next reload would fail to decrypt and
    // force a full seed re-entry (the regression this module fixes).
    keyPromise = null;
    return true;
  }

  function clear({ accountId = "" } = {}) {
    if (!storage) return false;
    const normalized = safeText(accountId, 180);
    if (!normalized) return false;
    storage.removeItem(sessionKey(normalized));
    for (const prefix of LEGACY_UNLOCKED_SESSION_PREFIXES) {
      storage.removeItem(`${prefix}${normalized}`);
    }
    return true;
  }

  function clearOthers({ keepAccountId = "" } = {}) {
    if (!storage) return false;
    const keepKey = sessionKey(keepAccountId);
    for (const key of listStorageKeys(storage)) {
      if (!isUnlockedSessionKey(key)) continue;
      // Legacy v1 entries are plaintext and are always purged.
      if (key !== keepKey) storage.removeItem(key);
    }
    return true;
  }

  async function save(unlock = {}) {
    const started = generation;
    const session = normalizeUnlockedWalletSession(unlock);
    const key = sessionKey(session?.accountId);
    if (!storage || !session || !key) return false;
    const cryptoKey = await sessionCryptoKey();
    if (!cryptoKey || started !== generation) return false;
    try {
      const iv = cryptoObj.getRandomValues(new Uint8Array(12));
      const plaintext = new TextEncoder().encode(JSON.stringify(session));
      const ciphertext = await subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, plaintext);
      if (started !== generation) return false;
      storage.setItem(
        key,
        JSON.stringify({ v: 2, iv: bytesToBase64(iv), ct: bytesToBase64(new Uint8Array(ciphertext)) })
      );
      for (const prefix of LEGACY_UNLOCKED_SESSION_PREFIXES) {
        storage.removeItem(`${prefix}${session.accountId}`);
      }
      touchActivity();
      return true;
    } catch {
      return false;
    }
  }

  async function read({
    accountId = "",
    expectedAddress = "",
    idleLockMs = walletUnlockIdleLockMs(),
  } = {}) {
    const key = sessionKey(accountId);
    if (!storage || !key) return null;
    for (const prefix of LEGACY_UNLOCKED_SESSION_PREFIXES) {
      storage.removeItem(`${prefix}${safeText(accountId, 180)}`);
    }
    const remaining = idleRemainingMs({ idleLockMs });
    if (remaining !== null && remaining <= 0) {
      clearAll();
      return null;
    }
    try {
      const envelope = JSON.parse(storage.getItem(key) || "null");
      if (!envelope || envelope.v !== 2 || !envelope.iv || !envelope.ct) {
        storage.removeItem(key);
        return null;
      }
      const cryptoKey = await sessionCryptoKey();
      if (!cryptoKey) return null;
      const plaintext = await subtle.decrypt(
        { name: "AES-GCM", iv: base64ToBytes(envelope.iv) },
        cryptoKey,
        base64ToBytes(envelope.ct)
      );
      const session = normalizeUnlockedWalletSession(JSON.parse(new TextDecoder().decode(plaintext)));
      if (!session) {
        storage.removeItem(key);
        return null;
      }
      const expected = safeText(expectedAddress, 120);
      if (expected && session.address !== expected) {
        storage.removeItem(key);
        return null;
      }
      return session;
    } catch {
      storage.removeItem(key);
      return null;
    }
  }

  return { save, read, clear, clearOthers, clearAll, touchActivity, idleRemainingMs };
}

let defaultStore = null;

function store() {
  if (!defaultStore) defaultStore = createUnlockedWalletSessionStore();
  return defaultStore;
}

export function saveUnlockedWalletSession(unlock = {}) {
  return store().save(unlock);
}

export function readUnlockedWalletSession(options = {}) {
  return store().read(options);
}

export function clearUnlockedWalletSession(options = {}) {
  return store().clear(options);
}

export function clearOtherUnlockedWalletSessions(options = {}) {
  return store().clearOthers(options);
}

export function clearAllUnlockedWalletSessions() {
  return store().clearAll();
}

export function touchWalletUnlockActivity() {
  return store().touchActivity();
}

export function walletUnlockIdleRemainingMs(options = {}) {
  return store().idleRemainingMs(options);
}

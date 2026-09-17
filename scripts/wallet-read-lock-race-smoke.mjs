import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const root = process.env.SOURCE_ROOT || fileURLToPath(new URL("../", import.meta.url));
const { createUnlockedWalletSessionStore } = await import(pathToFileURL(`${root}/src/features/wallet/wallet-unlocked-session.js`));
const synthetic = { accountId: "acct_synthetic_read", address: "rSyntheticNeverFunded", mnemonic: "synthetic placeholder never used for a wallet", unlockedAt: "2026-09-17T00:00:00.000Z" };
function setup() {
  const values = new Map();
  const storage = { get length() { return values.size; }, key: i => [...values.keys()][i] ?? null, getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,String(v)), removeItem: k => values.delete(k) };
  let release, reached, armed = false;
  const gate = new Promise(r => release = r), entered = new Promise(r => reached = r);
  const subtle = {};
  for (const name of ["importKey", "exportKey", "generateKey", "encrypt", "decrypt"]) subtle[name] = async (...args) => {
    const result = await webcrypto.subtle[name](...args);
    if (armed && name === "decrypt") { armed = false; reached(); await gate; }
    return result;
  };
  const store = createUnlockedWalletSessionStore({ storage, cryptoObj: { subtle, getRandomValues: a => webcrypto.getRandomValues(a) } });
  return { store, values, entered, release, arm() { armed = true; } };
}
const test = setup();
assert.equal(await test.store.save(synthetic), true);
test.arm();
const pending = test.store.read({ accountId: synthetic.accountId });
await test.entered;
test.store.clearAll();
assert.equal(test.values.size, 0);
test.release();
const stale = await pending;
console.log(JSON.stringify({ scenario: "store-decrypt-after-lock", pendingReadReturnedSecret: !!stale, freshReadReturnsNull: (await test.store.read({ accountId: synthetic.accountId })) === null, storageEntries: test.values.size }));
assert.equal(await test.store.save(synthetic), true);
assert.equal((await test.store.read({ accountId: synthetic.accountId })).mnemonic, synthetic.mnemonic, "new unlock after cancellation still works");
if (process.env.CALLER_MODE === "1") {
  const ts = createRequire(`${process.env.AST_DEPENDENCIES_ROOT || root}/package.json`)("typescript");
  const source = ts.createSourceFile("App.jsx", readFileSync(`${root}/src/app/App.jsx`, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
  function callback(name, dependencies) {
    let target;
    function visit(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) target = node.initializer.arguments[0];
      ts.forEachChild(node, visit);
    }
    visit(source); assert.ok(target && ts.isArrowFunction(target));
    let importCount = 0;
    const transformed = ts.transform(target, [context => node => {
      function change(current) {
        if (ts.isCallExpression(current) && current.expression.kind === ts.SyntaxKind.ImportKeyword) {
          assert.equal(current.arguments[0].text, "../wallet-core"); importCount += 1;
          return ts.factory.createCallExpression(ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier("Promise"), "resolve"), undefined, [ts.factory.createIdentifier("syntheticWalletCore")]);
        }
        return ts.visitEachChild(current, change, context);
      }
      return ts.visitNode(node, change);
    }]);
    const text = ts.createPrinter().printNode(ts.EmitHint.Expression, transformed.transformed[0], source);
    assert.equal(importCount, name === "refreshWalletVaultStatus" ? 1 : 0);
    return new Function(...Object.keys(dependencies), `return (${text});`)(...Object.values(dependencies));
  }
  const caller = setup(); await caller.store.save(synthetic);
  const secretRef = { current: null }, boundaryRef = { current: { accountId: synthetic.accountId } };
  let state = { unlocked: false };
  const dependencies = {
    walletAccountId: synthetic.accountId, accountBoundaryRef: boundaryRef, walletSecretRef: secretRef,
    syntheticWalletCore: { localWalletVaultStatus: () => ({ available: true, address: synthetic.address, persistence: "synthetic" }) },
    accountBoundaryCaptureIsCurrent: (current, capture) => current.accountId === capture.accountId,
    readUnlockedWalletSession: options => caller.store.read(options),
    clearAllUnlockedWalletSessions: () => caller.store.clearAll(),
    clearOtherUnlockedWalletSessions: options => caller.store.clearOthers(options),
    clearUnlockedWalletSession: options => caller.store.clear(options),
    setWalletVaultStatus: update => { state = typeof update === "function" ? update(state) : update; },
    EMPTY_WALLET_VAULT_STATUS: {},
  };
  const refresh = callback("refreshWalletVaultStatus", dependencies), lock = callback("lockWalletVault", dependencies);
  caller.arm(); const updating = refresh({ preserveUnlock: true });
  await caller.entered; lock(); assert.equal(state.unlocked, false);
  caller.release(); await updating;
  console.log(JSON.stringify({ scenario: "actual-App-callback", pendingReadReturnedSecret: !!secretRef.current, unlockedStateAfterLock: state.unlocked, storageEntries: caller.values.size, boundary: "AST-extracted actual callbacks; synthetic vault/status setters; no mounted browser UI or account-switch proof" }));
  assert.equal(secretRef.current, null); assert.equal(state.unlocked, false);
}
assert.equal(stale, null, "pending read invalidated by lock must return null");
console.log("PASS: pending read cancelled after lock, fresh reads locked, subsequent unlock works");

import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createUnlockedWalletSessionStore} from '../src/features/wallet/wallet-unlocked-session.js';
const values=new Map();
const storage={get length(){return values.size},key:i=>[...values.keys()][i]??null,getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k)};
const scenario=process.env.RACE_CASE||'encrypt';
let release, reached;
const gate=new Promise(r=>release=r), entered=new Promise(r=>reached=r);
let armed=true;
const subtle={};
for(const name of ['importKey','exportKey','generateKey','encrypt','decrypt']) subtle[name]=async(...args)=>{
 const result=await webcrypto.subtle[name](...args);
 if(armed && name===(scenario==='export'?'exportKey':'encrypt')){armed=false;reached();await gate}
 return result;
};
const cryptoObj={subtle,getRandomValues:a=>webcrypto.getRandomValues(a)};
const store=createUnlockedWalletSessionStore({storage,cryptoObj});
const synthetic={accountId:'acct_synthetic_race',address:'rSyntheticNeverFunded',mnemonic:'synthetic test words never used for any wallet',unlockedAt:'2026-09-17T00:00:00.000Z'};
const pending=store.save(synthetic);
await entered;
store.clearAll();
assert.equal(values.size,0,'lock synchronously clears session storage');
// A newly constructed store represents reload after the lock. Release the old
// operation only after this boundary; same-tab continuation is the reachable
// race, while constructing the new store checks persisted state after reload.
const reload=createUnlockedWalletSessionStore({storage,cryptoObj:webcrypto});
release();
const saved=await pending;
const envelope=storage.getItem('tasknode:wallet-unlocked-session:v2:acct_synthetic_race');
const key=storage.getItem('tasknode:wallet-unlocked-session:aes-key');
const activity=storage.getItem('tasknode:wallet-unlocked-session:last-active');
const recovered=await reload.read({accountId:synthetic.accountId,expectedAddress:synthetic.address});
console.log(JSON.stringify({scenario,saved,envelopePresent:!!envelope,keyPresent:!!key,activityPresent:!!activity,recovered:!!recovered}));
assert.equal(saved,false,'save invalidated by lock must fail');
assert.equal(envelope,null,'late save must not revive encrypted envelope');
assert.equal(key,null,'late key export must not revive persisted key');
assert.equal(activity,null,'late save must not revive activity timestamp');
assert.equal(recovered,null,'reload must remain locked');
// A fresh unlock after cancellation must still work.
assert.equal(await store.save(synthetic),true);
const freshReload=createUnlockedWalletSessionStore({storage,cryptoObj:webcrypto});
assert.equal((await freshReload.read({accountId:synthetic.accountId})).mnemonic,synthetic.mnemonic);
console.log('PASS '+scenario+' cancellation and subsequent fresh save/reload');

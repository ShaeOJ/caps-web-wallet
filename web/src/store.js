// store.js — encrypted-vault persistence in IndexedDB. Only ciphertext is
// stored; the plaintext mnemonic is never written to disk.

const DB = 'caps-wallet';
const STORE = 'vault';
const KEY = 'default';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const r = fn(store);
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
  });
}

export async function saveVault(vault) {
  await tx('readwrite', (s) => s.put(vault, KEY));
}

export async function loadVault() {
  return tx('readonly', (s) => s.get(KEY));
}

export async function clearVault() {
  await tx('readwrite', (s) => s.delete(KEY));
}

export async function hasVault() {
  return !!(await loadVault());
}

// Address book — saved recipient addresses with user labels. Addresses are
// public data, so this is stored as plaintext (unlike the vault) in the same
// object store under its own key. Shape: [{ address, label, created }].
const ABOOK_KEY = 'addressbook';

export async function loadAddressBook() {
  return (await tx('readonly', (s) => s.get(ABOOK_KEY))) || [];
}

export async function saveAddressBook(list) {
  await tx('readwrite', (s) => s.put(list, ABOOK_KEY));
}

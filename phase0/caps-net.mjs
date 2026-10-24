// CAPS network params for @scure/btc-signer — derived from src/kernel/chainparams.cpp
export const CAPS_MAIN = {
  bech32: 'caps',
  pubKeyHash: 0x1c, // 'C'
  scriptHash: 0x1d,
  wif: 0x9c,
};
export const CAPS_REGTEST = {
  bech32: 'capsrt',
  pubKeyHash: 0x6f, // 111
  scriptHash: 0xc4, // 196
  wif: 0xef,        // 239
};
// BIP84 path. Node is agnostic to derivation path; this is the wallet's internal convention.
export const CAPS_COINTYPE = 0; // MVP convention; keep stable for restore compatibility

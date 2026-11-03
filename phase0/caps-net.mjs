// CAPS network params for @scure/btc-signer — derived from src/kernel/chainparams.cpp
export const CAPS_MAIN = {
  bech32: 'btlcap',
  pubKeyHash: 0x19, // 'B'
  scriptHash: 0x32, // 'M'
  wif: 0x99,
};
export const CAPS_REGTEST = {
  bech32: 'btlcaprt',
  pubKeyHash: 0x6f, // 111
  scriptHash: 0xc4, // 196
  wif: 0xef,        // 239
};
// BIP84 path. Node is agnostic to derivation path; this is the wallet's internal convention.
export const CAPS_COINTYPE = 0; // MVP convention; keep stable for restore compatibility

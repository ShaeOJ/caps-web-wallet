// CAPS network params for @scure/btc-signer — from src/kernel/chainparams.cpp.
// Single source of truth shared by derivation, signing and address validation.

export const NETWORKS = {
  main: {
    name: 'main',
    bech32: 'btlcap',
    pubKeyHash: 0x19, // 'B'
    scriptHash: 0x32, // 'M'
    wif: 0x99,
  },
  regtest: {
    name: 'regtest',
    bech32: 'btlcaprt',
    pubKeyHash: 0x6f, // 111
    scriptHash: 0xc4, // 196
    wif: 0xef, // 239
  },
};

// BIP84 (native segwit) path. The node is agnostic to the derivation path;
// this is the wallet's own convention and must stay stable for restores.
export const COINTYPE = 0;
export const PURPOSE = 84;

export function pathFor(chain, index) {
  // chain: 0 = external (receive), 1 = internal (change)
  return `m/${PURPOSE}'/${COINTYPE}'/0'/${chain}/${index}`;
}

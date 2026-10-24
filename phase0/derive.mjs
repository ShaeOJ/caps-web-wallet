import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import * as btc from '@scure/btc-signer';
import { bytesToHex } from '@noble/hashes/utils.js';
import { CAPS_REGTEST, CAPS_COINTYPE } from './caps-net.mjs';

// Fixed test mnemonic for reproducible validation
const MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const net = CAPS_REGTEST;

const seed = bip39.mnemonicToSeedSync(MNEMONIC);
const root = HDKey.fromMasterSeed(seed);
const path = `m/84'/${CAPS_COINTYPE}'/0'/0/0`;
const node = root.derive(path);
const pub = node.publicKey;         // compressed 33-byte
const priv = node.privateKey;

const p2 = btc.p2wpkh(pub, net);
const wif = btc.WIF(net).encode(priv);

console.log(JSON.stringify({
  path,
  pubkey: bytesToHex(pub),
  address: p2.address,
  wif,
}));

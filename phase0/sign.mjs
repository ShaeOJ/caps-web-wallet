import * as bip39 from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import * as btc from '@scure/btc-signer';
import { CAPS_REGTEST, CAPS_COINTYPE } from './caps-net.mjs';

const MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const net = CAPS_REGTEST;
const seed = bip39.mnemonicToSeedSync(MNEMONIC);
const kn = HDKey.fromMasterSeed(seed).derive(`m/84'/${CAPS_COINTYPE}'/0'/0/0`);
const priv = kn.privateKey, pub = kn.publicKey;
const self = btc.p2wpkh(pub, net);

const { TXID, VOUT, VALUE_SATS, DEST, SEND_SATS, FEE_SATS } = process.env;
const inVal = BigInt(VALUE_SATS);
const sendVal = BigInt(SEND_SATS);
const change = inVal - sendVal - BigInt(FEE_SATS);
if (change < 0n) throw new Error('insufficient after fee');

const tx = new btc.Transaction();
tx.addInput({
  txid: TXID,
  index: Number(VOUT),
  witnessUtxo: { script: self.script, amount: inVal },
});
tx.addOutputAddress(DEST, sendVal, net);
if (change > 0n) tx.addOutputAddress(self.address, change, net); // change to self
tx.sign(priv);
tx.finalize();
console.log(tx.hex);

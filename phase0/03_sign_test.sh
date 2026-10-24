set -e
cd /root/caps-wallet/phase0
CLI="/root/caps-core/src/caps-cli -datadir=/root/.caps-regtest -rpcport=13667 -rpcuser=rt -rpcpassword=rt"
W="$CLI -rpcwallet=fund"
JSADDR=$(node derive.mjs | jq -r .address)
echo "JS wallet addr: $JSADDR"

# 1) Fund the JS address with 10 CAPS, confirm
FTX=$($W sendtoaddress "$JSADDR" 10)
$W generatetoaddress 1 "$($W getnewaddress)" >/dev/null
echo "funded txid: $FTX"

# 2) Discover UTXO client-side via scantxoutset (no address index needed)
SCAN=$($CLI scantxoutset start "[\"addr($JSADDR)\"]")
echo "$SCAN" | jq -c '{total_amount, n: (.unspents|length)}'
TXID=$(echo "$SCAN" | jq -r '.unspents[0].txid')
VOUT=$(echo "$SCAN" | jq -r '.unspents[0].vout')
AMT=$(echo "$SCAN" | jq -r '.unspents[0].amount')
VALUE_SATS=$(printf '%.0f' "$(echo "$AMT*100000000" | bc -l)")
echo "spending utxo $TXID:$VOUT value=$AMT ($VALUE_SATS sats)"

# 3) Build+sign 100% in JS: send 4 CAPS to a fresh node addr, fee 0.0002, change to self
DEST=$($W getnewaddress "" bech32)
export TXID VOUT VALUE_SATS DEST SEND_SATS=400000000 FEE_SATS=20000
RAW=$(node sign.mjs)
echo "signed raw len: ${#RAW}"

# 4) Broadcast + mine
SENT=$($CLI sendrawtransaction "$RAW")
echo "BROADCAST txid: $SENT"
$W generatetoaddress 1 "$($W getnewaddress)" >/dev/null

# 5) Confirm it landed + dest received 4
CONF=$($CLI getrawtransaction "$SENT" true | jq -r '.confirmations')
DESTBAL=$($CLI scantxoutset start "[\"addr($DEST)\"]" | jq -r '.total_amount')
echo "tx confirmations: $CONF"
echo "dest received: $DESTBAL"
if [ "$CONF" -ge 1 ] && [ "$DESTBAL" = "4.00000000" ]; then echo "RESULT: SIGNING OK ✅"; else echo "RESULT: FAIL ❌"; fi

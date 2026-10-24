pkill -f 'caps-regtest' 2>/dev/null; sleep 2
D=/root/.caps-regtest
rm -rf "$D"; mkdir -p "$D"
cat > "$D/caps.conf" <<EOF
regtest=1
server=1
txindex=1
fallbackfee=0.0002
[regtest]
rpcport=13667
port=13766
rpcuser=rt
rpcpassword=rt
EOF
/root/caps-core/src/capsd -datadir="$D" -daemon
sleep 5
CLI="/root/caps-core/src/caps-cli -datadir=$D -rpcport=13667 -rpcuser=rt -rpcpassword=rt"
$CLI createwallet fund >/dev/null
ADDR=$($CLI -rpcwallet=fund getnewaddress "" bech32)
echo "FUND_ADDR=$ADDR"
$CLI generatetoaddress 101 "$ADDR" >/dev/null
echo "BLOCKS=$($CLI getblockcount)"
echo "BAL=$($CLI -rpcwallet=fund getbalance)"

package contractstest

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"math/big"
	"testing"
	"time"

	arklib "github.com/arkade-os/arkd/pkg/ark-lib"
	scriptlib "github.com/arkade-os/arkd/pkg/ark-lib/script"
	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/btcec/v2/schnorr"
	"github.com/btcsuite/btcd/txscript/v2"
	"github.com/btcsuite/btcd/wire/v2"
)

const (
	testStrike         int64 = 9_700_000
	testCollateral     int64 = 100_000
	testStake          int64 = 50_000
	testVoidAfter      int64 = 86_400
	testFallbackDelay  int64 = 22_016
	testFinalExitDelay int64 = 108_032
	testExitDelay      int64 = 2_048
)

type predictDiaSample struct {
	expiry       int64
	rawPrice     string
	cents        int64
	sampleTime   int64
	nonce        string
	intentExpiry int64
	sigHex       string
}

// Real Lasernet BTC/USD OracleUpdate print signed by the pinned DIA key on a 5-minute close.
var predictRecordedDia = predictDiaSample{
	expiry:       1795593000,
	rawPrice:     "58728258984125017358336",
	cents:        5872826,
	sampleTime:   1795593002,
	nonce:        "1793790301274586439",
	intentExpiry: 1795596602,
	sigHex:       "7980c73f7210211fd2887cc55bd0df6e049ccb57771131a81ed1bb655a6b52887fa15bb26be0e35f0de52badce56190ec3df541814e8652d0f9314a088c26280",
}

func predictMustBigInt(s string) *big.Int {
	v, ok := new(big.Int).SetString(s, 10)
	if !ok {
		panic(s)
	}
	return v
}

func predictMustHex(s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return b
}

func predictFixDigest(expiry, cents, sampleTime int64) []byte {
	h := sha256.New()
	h.Write([]byte("BTCUSD-FIX"))
	h.Write([]byte("fix"))
	var b [8]byte
	binary.LittleEndian.PutUint64(b[:], uint64(expiry))
	h.Write(b[:])
	binary.LittleEndian.PutUint64(b[:], uint64(cents))
	h.Write(b[:])
	binary.LittleEndian.PutUint64(b[:], uint64(sampleTime))
	h.Write(b[:])
	return h.Sum(nil)
}

func defaultVtxoPkScript(owner, server *btcec.PublicKey, exitSec int64) []byte {
	vtxo := scriptlib.NewDefaultVtxoScript(owner, server, arklib.RelativeLocktime{
		Type:  arklib.LocktimeTypeSecond,
		Value: uint32(exitSec),
	})
	tapKey, _, err := vtxo.TapTree()
	if err != nil {
		panic(err)
	}
	return p2trScript(schnorr.SerializePubKey(tapKey))
}

func predictVaultArgs(
	kind int64,
	writerPk, holderPk, oraclePk, backupPk *btcec.PublicKey,
	writerScript, holderScript []byte,
	strike, expiry int64,
) map[string][]byte {
	return map[string][]byte{
		"kind":                 int64Bytes(kind),
		"writerPk":             schnorr.SerializePubKey(writerPk),
		"holderPk":             schnorr.SerializePubKey(holderPk),
		"writerScript.program": writerScript[2:],
		"writerScript.version": int64Bytes(1),
		"holderScript.program": holderScript[2:],
		"holderScript.version": int64Bytes(1),
		"strike":               int64Bytes(strike),
		"collateral":           int64Bytes(testCollateral),
		"stake":                int64Bytes(testStake),
		"expiry":               int64Bytes(expiry),
		"oraclePk":             schnorr.SerializePubKey(oraclePk),
		"backupPk":             schnorr.SerializePubKey(backupPk),
		"voidAfter":            int64Bytes(testVoidAfter),
		"fallbackDelay":        int64Bytes(exitSequence(testFallbackDelay)),
		"finalExitDelay":       int64Bytes(exitSequence(testFinalExitDelay)),
	}
}

func optionIntentArgs(
	userPk *btcec.PublicKey,
	userScript, solverScript, optionScript []byte,
	deadline int64,
) map[string][]byte {
	return map[string][]byte{
		"userPk":               schnorr.SerializePubKey(userPk),
		"userScript.program":   userScript[2:],
		"userScript.version":   int64Bytes(1),
		"solverScript.program": solverScript[2:],
		"solverScript.version": int64Bytes(1),
		"optionScript.program": optionScript[2:],
		"optionScript.version": int64Bytes(1),
		"side":                 int64Bytes(1),
		"collateral":           int64Bytes(testCollateral),
		"premium":              int64Bytes(testStake),
		"deadline":             int64Bytes(deadline),
		"exit":                 int64Bytes(exitSequence(testExitDelay)),
	}
}

func TestPredictVaultAndOptionIntentScriptParityWithTS(t *testing.T) {
	writer := privKeyFromByte(1)
	holder := privKeyFromByte(2)
	backup := privKeyFromByte(3)
	oracle := privKeyFromByte(4)
	server := privKeyFromByte(8)
	emulator := privKeyFromByte(9)
	keys := contractKeys{serverKey: server.PubKey(), emulatorKey: emulator.PubKey()}

	writerScript := defaultVtxoPkScript(writer.PubKey(), server.PubKey(), testExitDelay)
	holderScript := p2trScript(xOnlyPub(holder))
	if got, want := hex.EncodeToString(writerScript), "51200f9cab3dda6d21f7bd8b7911351bce3c9f5add512fbfbf2274f0f913f613b7fa"; got != want {
		t.Fatalf("writerScript mismatch: got %s want %s", got, want)
	}
	if got, want := hex.EncodeToString(holderScript), "5120c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"; got != want {
		t.Fatalf("holderScript mismatch: got %s want %s", got, want)
	}

	predictArt := loadArtifact(t, "predict_vault.artifact.json")
	intentArt := loadArtifact(t, "option_intent.artifact.json")

	vault2 := compileArtifact(t, predictArt, predictVaultArgs(2, writer.PubKey(), holder.PubKey(), oracle.PubKey(), backup.PubKey(), writerScript, holderScript, testStrike, 1_790_000_100), keys)
	vault3 := compileArtifact(t, predictArt, predictVaultArgs(3, writer.PubKey(), holder.PubKey(), oracle.PubKey(), backup.PubKey(), writerScript, holderScript, testStrike, 1_790_000_100), keys)
	intent2 := compileArtifact(t, intentArt, optionIntentArgs(holder.PubKey(), holderScript, writerScript, vault2.pkScript, 1_790_000_000), keys)

	if got, want := hex.EncodeToString(vault2.pkScript), "51207080739b0da2e1988fabe0d1154f587c2d9b8fdcd8715a56353886612bf852f4"; got != want {
		t.Fatalf("kind 2 vault pkScript mismatch:\ngot  %s\nwant %s", got, want)
	}
	if got, want := hex.EncodeToString(intent2.pkScript), "5120d824e6af40acd5bc5d08a1beb67791d963c5d5c76c067c9d76c9a0484353a956"; got != want {
		t.Fatalf("kind 2 intent pkScript mismatch:\ngot  %s\nwant %s", got, want)
	}
	if got, want := hex.EncodeToString(vault3.pkScript), "512079343dc80acbcf969871961b1bd516a75f763d0512bb563773770d8114187703"; got != want {
		t.Fatalf("kind 3 vault pkScript mismatch:\ngot  %s\nwant %s", got, want)
	}
	// Verify unilateral 2-of-2 tapscript leaf carries both writer and holder x-only keys.
	unilateralHex := hex.EncodeToString(vault2.leafScripts["unilateral"])
	if !containsHex(unilateralHex, hex.EncodeToString(xOnlyPub(writer))) || !containsHex(unilateralHex, hex.EncodeToString(xOnlyPub(holder))) {
		t.Fatalf("unilateral leaf missing party pubkeys: %s", unilateralHex)
	}
}

func containsHex(haystack, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i += 2 {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}

func TestPredictVaultSettleDirectSignature(t *testing.T) {
	writer := privKeyFromByte(11)
	holder := privKeyFromByte(12)
	backup := privKeyFromByte(13)
	oracle := privKeyFromByte(14)
	stranger := privKeyFromByte(15)
	server := privKeyFromByte(16)
	emulator := privKeyFromByte(17)
	keys := contractKeys{serverKey: server.PubKey(), emulatorKey: emulator.PubKey()}

	writerScript := p2trScript(xOnlyPub(writer))
	holderScript := p2trScript(xOnlyPub(holder))
	art := loadArtifact(t, "predict_vault.artifact.json")

	d := predictRecordedDia
	rawPrice := predictMustBigInt(d.rawPrice)
	diaSig := predictMustHex(d.sigHex)
	nonce := predictMustBigInt(d.nonce)

	signOracle := func(signer *btcec.PrivateKey, expiry, cents, sampleTime int64) []byte {
		sig, err := schnorr.Sign(signer, predictFixDigest(expiry, cents, sampleTime))
		if err != nil {
			t.Fatalf("sign oracle: %v", err)
		}
		return sig.Serialize()
	}

	buildSettle := func(
		vault compiledContract,
		locked int64,
		payScript []byte,
		payAmt int64,
		price *big.Int,
		sampleTime int64,
		sampleNonce *big.Int,
		intentExpiry int64,
		dia []byte,
		oracleSig []byte,
	) (*wire.MsgTx, *mockPrevOuts, wire.TxWitness) {
		op0 := dummyOutPoint(1, 0)
		tx := wire.NewMsgTx(3)
		tx.AddTxIn(wire.NewTxIn(&op0, nil, nil))
		tx.AddTxOut(wire.NewTxOut(payAmt, payScript))
		prev := &mockPrevOuts{
			outputs: map[wire.OutPoint]*wire.TxOut{
				op0: {Value: locked, PkScript: vault.pkScript},
			},
		}
		// Witness order matches settle(price, time, nonce, intentExpiry, sig, oracleSig) reversed on stack.
		witness := wire.TxWitness{
			oracleSig,
			dia,
			int64Bytes(intentExpiry),
			scriptNumBytes(sampleNonce),
			int64Bytes(sampleTime),
			scriptNumBytes(price),
		}
		return tx, prev, witness
	}

	goodOracleSig := signOracle(oracle, d.expiry, d.cents, d.sampleTime)

	// Kind 2 above strike pays holder full collateral (0 read fee); paying writer fails.
	vault2Win := compileArtifact(t, art, predictVaultArgs(2, writer.PubKey(), holder.PubKey(), oracle.PubKey(), backup.PubKey(), writerScript, holderScript, d.cents-1, d.expiry), keys)
	txWin, prevWin, wWin := buildSettle(vault2Win, testCollateral, holderScript, testCollateral, rawPrice, d.sampleTime, nonce, d.intentExpiry, diaSig, goodOracleSig)
	if err := execArkadeLeaf(t, vault2Win, "settle", "settle", emulator.PubKey(), txWin, 0, prevWin, wWin); err != nil {
		t.Fatalf("kind 2 direct-sig win should succeed: %v", err)
	}
	txWrong, prevWrong, wWrong := buildSettle(vault2Win, testCollateral, writerScript, testCollateral, rawPrice, d.sampleTime, nonce, d.intentExpiry, diaSig, goodOracleSig)
	if err := execArkadeLeaf(t, vault2Win, "settle", "settle", emulator.PubKey(), txWrong, 0, prevWrong, wWrong); err == nil {
		t.Fatal("kind 2 win paying writer must fail")
	}

	// Kind 2 exact strike pays writer; paying holder fails.
	vault2Eq := compileArtifact(t, art, predictVaultArgs(2, writer.PubKey(), holder.PubKey(), oracle.PubKey(), backup.PubKey(), writerScript, holderScript, d.cents, d.expiry), keys)
	txEq, prevEq, wEq := buildSettle(vault2Eq, testCollateral, writerScript, testCollateral, rawPrice, d.sampleTime, nonce, d.intentExpiry, diaSig, goodOracleSig)
	if err := execArkadeLeaf(t, vault2Eq, "settle", "settle", emulator.PubKey(), txEq, 0, prevEq, wEq); err != nil {
		t.Fatalf("kind 2 exact strike paying writer should succeed: %v", err)
	}
	txEqHolder, prevEqHolder, wEqHolder := buildSettle(vault2Eq, testCollateral, holderScript, testCollateral, rawPrice, d.sampleTime, nonce, d.intentExpiry, diaSig, goodOracleSig)
	if err := execArkadeLeaf(t, vault2Eq, "settle", "settle", emulator.PubKey(), txEqHolder, 0, prevEqHolder, wEqHolder); err == nil {
		t.Fatal("kind 2 exact strike paying holder must fail")
	}

	// Kind 3 below strike pays holder; exact strike pays writer.
	vault3Win := compileArtifact(t, art, predictVaultArgs(3, writer.PubKey(), holder.PubKey(), oracle.PubKey(), backup.PubKey(), writerScript, holderScript, d.cents+1, d.expiry), keys)
	txLow, prevLow, wLow := buildSettle(vault3Win, testCollateral, holderScript, testCollateral, rawPrice, d.sampleTime, nonce, d.intentExpiry, diaSig, goodOracleSig)
	if err := execArkadeLeaf(t, vault3Win, "settle", "settle", emulator.PubKey(), txLow, 0, prevLow, wLow); err != nil {
		t.Fatalf("kind 3 direct-sig win should succeed: %v", err)
	}
	vault3Eq := compileArtifact(t, art, predictVaultArgs(3, writer.PubKey(), holder.PubKey(), oracle.PubKey(), backup.PubKey(), writerScript, holderScript, d.cents, d.expiry), keys)
	txLowEq, prevLowEq, wLowEq := buildSettle(vault3Eq, testCollateral, writerScript, testCollateral, rawPrice, d.sampleTime, nonce, d.intentExpiry, diaSig, goodOracleSig)
	if err := execArkadeLeaf(t, vault3Eq, "settle", "settle", emulator.PubKey(), txLowEq, 0, prevLowEq, wLowEq); err != nil {
		t.Fatalf("kind 3 exact strike paying writer should succeed: %v", err)
	}

	// Adversarial signature & payload rejections.
	strangerOracleSig := signOracle(stranger, d.expiry, d.cents, d.sampleTime)
	txBadOracle, prevBadOracle, wBadOracle := buildSettle(vault2Win, testCollateral, holderScript, testCollateral, rawPrice, d.sampleTime, nonce, d.intentExpiry, diaSig, strangerOracleSig)
	if err := execArkadeLeaf(t, vault2Win, "settle", "settle", emulator.PubKey(), txBadOracle, 0, prevBadOracle, wBadOracle); err == nil {
		t.Fatal("stranger oracleSig must fail")
	}

	wrongExpiryOracleSig := signOracle(oracle, d.expiry+300, d.cents, d.sampleTime)
	txWrongExpSig, prevWrongExpSig, wWrongExpSig := buildSettle(vault2Win, testCollateral, holderScript, testCollateral, rawPrice, d.sampleTime, nonce, d.intentExpiry, diaSig, wrongExpiryOracleSig)
	if err := execArkadeLeaf(t, vault2Win, "settle", "settle", emulator.PubKey(), txWrongExpSig, 0, prevWrongExpSig, wWrongExpSig); err == nil {
		t.Fatal("oracleSig for different expiry must fail")
	}

	badDiaSig := append([]byte(nil), diaSig...)
	badDiaSig[0] ^= 0xff
	txBadDia, prevBadDia, wBadDia := buildSettle(vault2Win, testCollateral, holderScript, testCollateral, rawPrice, d.sampleTime, nonce, d.intentExpiry, badDiaSig, goodOracleSig)
	if err := execArkadeLeaf(t, vault2Win, "settle", "settle", emulator.PubKey(), txBadDia, 0, prevBadDia, wBadDia); err == nil {
		t.Fatal("corrupted DIA signature must fail")
	}

	tamperedPrice := new(big.Int).Add(rawPrice, big.NewInt(1))
	txTamperPrice, prevTamperPrice, wTamperPrice := buildSettle(vault2Win, testCollateral, holderScript, testCollateral, tamperedPrice, d.sampleTime, nonce, d.intentExpiry, diaSig, goodOracleSig)
	if err := execArkadeLeaf(t, vault2Win, "settle", "settle", emulator.PubKey(), txTamperPrice, 0, prevTamperPrice, wTamperPrice); err == nil {
		t.Fatal("tampered DIA price must fail")
	}

	tamperedTimeSig := signOracle(oracle, d.expiry, d.cents, d.sampleTime+1)
	txTamperTime, prevTamperTime, wTamperTime := buildSettle(vault2Win, testCollateral, holderScript, testCollateral, rawPrice, d.sampleTime+1, nonce, d.intentExpiry, diaSig, tamperedTimeSig)
	if err := execArkadeLeaf(t, vault2Win, "settle", "settle", emulator.PubKey(), txTamperTime, 0, prevTamperTime, wTamperTime); err == nil {
		t.Fatal("tampered DIA time must fail")
	}

	// Sample outside [expiry, expiry+60] must fail even with matching oracleSig.
	laterExpiry := d.expiry + 300
	vaultEarlySample := compileArtifact(t, art, predictVaultArgs(2, writer.PubKey(), holder.PubKey(), oracle.PubKey(), backup.PubKey(), writerScript, holderScript, d.cents-1, laterExpiry), keys)
	earlySig := signOracle(oracle, laterExpiry, d.cents, d.sampleTime)
	txEarlySample, prevEarlySample, wEarlySample := buildSettle(vaultEarlySample, testCollateral, holderScript, testCollateral, rawPrice, d.sampleTime, nonce, d.intentExpiry, diaSig, earlySig)
	if err := execArkadeLeaf(t, vaultEarlySample, "settle", "settle", emulator.PubKey(), txEarlySample, 0, prevEarlySample, wEarlySample); err == nil {
		t.Fatal("sample before expiry must fail")
	}

	earlierExpiry := d.expiry - 300
	vaultLateSample := compileArtifact(t, art, predictVaultArgs(2, writer.PubKey(), holder.PubKey(), oracle.PubKey(), backup.PubKey(), writerScript, holderScript, d.cents-1, earlierExpiry), keys)
	lateSig := signOracle(oracle, earlierExpiry, d.cents, d.sampleTime)
	txLateSample, prevLateSample, wLateSample := buildSettle(vaultLateSample, testCollateral, holderScript, testCollateral, rawPrice, d.sampleTime, nonce, d.intentExpiry, diaSig, lateSig)
	if err := execArkadeLeaf(t, vaultLateSample, "settle", "settle", emulator.PubKey(), txLateSample, 0, prevLateSample, wLateSample); err == nil {
		t.Fatal("sample after expiry+60 must fail")
	}

	// Input count, active input index, payout amount, underfunding, and OP_CHECKTIME rejections.
	op0 := dummyOutPoint(1, 0)
	op1 := dummyOutPoint(2, 0)
	txTwoIn := wire.NewMsgTx(3)
	txTwoIn.AddTxIn(wire.NewTxIn(&op0, nil, nil))
	txTwoIn.AddTxIn(wire.NewTxIn(&op1, nil, nil))
	txTwoIn.AddTxOut(wire.NewTxOut(testCollateral, holderScript))
	prevTwoIn := &mockPrevOuts{
		outputs: map[wire.OutPoint]*wire.TxOut{
			op0: {Value: testCollateral, PkScript: vault2Win.pkScript},
			op1: {Value: 1_000, PkScript: writerScript},
		},
	}
	if err := execArkadeLeaf(t, vault2Win, "settle", "settle", emulator.PubKey(), txTwoIn, 0, prevTwoIn, wWin); err == nil {
		t.Fatal("settle with tx.numInputs == 2 must fail")
	}
	prevIdx1 := &mockPrevOuts{
		outputs: map[wire.OutPoint]*wire.TxOut{
			op0: {Value: 1_000, PkScript: writerScript},
			op1: {Value: testCollateral, PkScript: vault2Win.pkScript},
		},
	}
	if err := execArkadeLeaf(t, vault2Win, "settle", "settle", emulator.PubKey(), txTwoIn, 1, prevIdx1, wWin); err == nil {
		t.Fatal("settle with activeInputIndex == 1 must fail")
	}

	txShort, prevShort, wShort := buildSettle(vault2Win, testCollateral, holderScript, testCollateral-1, rawPrice, d.sampleTime, nonce, d.intentExpiry, diaSig, goodOracleSig)
	if err := execArkadeLeaf(t, vault2Win, "settle", "settle", emulator.PubKey(), txShort, 0, prevShort, wShort); err == nil {
		t.Fatal("short payout must fail")
	}
	txUnder, prevUnder, wUnder := buildSettle(vault2Win, testCollateral-1, holderScript, testCollateral-1, rawPrice, d.sampleTime, nonce, d.intentExpiry, diaSig, goodOracleSig)
	if err := execArkadeLeaf(t, vault2Win, "settle", "settle", emulator.PubKey(), txUnder, 0, prevUnder, wUnder); err == nil {
		t.Fatal("underfunded vault must fail")
	}

	futureExpiry := ((time.Now().Unix() + 3_600) / 300) * 300
	vaultFuture := compileArtifact(t, art, predictVaultArgs(2, writer.PubKey(), holder.PubKey(), oracle.PubKey(), backup.PubKey(), writerScript, holderScript, d.cents-1, futureExpiry), keys)
	futureSig := signOracle(oracle, futureExpiry, d.cents, futureExpiry+5)
	txFut, prevFut, wFut := buildSettle(vaultFuture, testCollateral, holderScript, testCollateral, rawPrice, futureExpiry+5, nonce, d.intentExpiry, diaSig, futureSig)
	if err := execArkadeLeaf(t, vaultFuture, "settle", "settle", emulator.PubKey(), txFut, 0, prevFut, wFut); err == nil {
		t.Fatal("settle before expiry+60 must fail OP_CHECKTIME")
	}
}

func TestPredictVaultRefundAndBackup(t *testing.T) {
	writer := privKeyFromByte(21)
	holder := privKeyFromByte(22)
	backup := privKeyFromByte(23)
	oracle := privKeyFromByte(24)
	server := privKeyFromByte(25)
	emulator := privKeyFromByte(26)
	keys := contractKeys{serverKey: server.PubKey(), emulatorKey: emulator.PubKey()}

	writerScript := p2trScript(xOnlyPub(writer))
	holderScript := p2trScript(xOnlyPub(holder))
	now := time.Now().Unix()
	art := loadArtifact(t, "predict_vault.artifact.json")

	voidable := compileArtifact(t, art, predictVaultArgs(2, writer.PubKey(), holder.PubKey(), oracle.PubKey(), backup.PubKey(), writerScript, holderScript, testStrike, now-testVoidAfter-60), keys)

	op0 := dummyOutPoint(3, 0)
	op1 := dummyOutPoint(9, 0)
	tx := wire.NewMsgTx(3)
	tx.AddTxIn(wire.NewTxIn(&op0, nil, nil))
	tx.AddTxOut(wire.NewTxOut(testStake, holderScript))
	tx.AddTxOut(wire.NewTxOut(testCollateral-testStake, writerScript))
	prev := &mockPrevOuts{outputs: map[wire.OutPoint]*wire.TxOut{op0: {Value: testCollateral, PkScript: voidable.pkScript}}}

	if err := execArkadeLeaf(t, voidable, "refund", "refund", emulator.PubKey(), tx, 0, prev, nil); err != nil {
		t.Fatalf("refund after voidAfter should succeed: %v", err)
	}
	if err := execArkadeLeaf(t, voidable, "refund", "refundBackup", backup.PubKey(), tx, 0, prev, nil); err != nil {
		t.Fatalf("refundBackup with backup key should succeed: %v", err)
	}
	if err := execArkadeLeaf(t, voidable, "refund", "refundBackup", emulator.PubKey(), tx, 0, prev, nil); err == nil {
		t.Fatal("refundBackup must reject non-backup signer key")
	}

	// L1 refundBackup with an extra fee-sponsor input at index 1 must succeed.
	txSponsored := wire.NewMsgTx(3)
	txSponsored.AddTxIn(wire.NewTxIn(&op0, nil, nil))
	txSponsored.AddTxIn(wire.NewTxIn(&op1, nil, nil))
	txSponsored.AddTxOut(wire.NewTxOut(testStake, holderScript))
	txSponsored.AddTxOut(wire.NewTxOut(testCollateral-testStake, writerScript))
	prevSponsored := &mockPrevOuts{
		outputs: map[wire.OutPoint]*wire.TxOut{
			op0: {Value: testCollateral, PkScript: voidable.pkScript},
			op1: {Value: 10_000, PkScript: holderScript},
		},
	}
	if err := execArkadeLeaf(t, voidable, "refund", "refundBackup", backup.PubKey(), txSponsored, 0, prevSponsored, nil); err != nil {
		t.Fatalf("refundBackup with L1 fee-sponsor input should succeed: %v", err)
	}

	// Dust remainder folds full locked value into holder output 0.
	dustLocked := testStake + 330
	txDust := wire.NewMsgTx(3)
	txDust.AddTxIn(wire.NewTxIn(&op0, nil, nil))
	txDust.AddTxOut(wire.NewTxOut(dustLocked, holderScript))
	prevDust := &mockPrevOuts{outputs: map[wire.OutPoint]*wire.TxOut{op0: {Value: dustLocked, PkScript: voidable.pkScript}}}
	if err := execArkadeLeaf(t, voidable, "refund", "refund", emulator.PubKey(), txDust, 0, prevDust, nil); err != nil {
		t.Fatalf("dust-folded refund should succeed: %v", err)
	}

	// Short house share must fail.
	txShortHouse := wire.NewMsgTx(3)
	txShortHouse.AddTxIn(wire.NewTxIn(&op0, nil, nil))
	txShortHouse.AddTxOut(wire.NewTxOut(testStake, holderScript))
	txShortHouse.AddTxOut(wire.NewTxOut(testCollateral-testStake-1, writerScript))
	if err := execArkadeLeaf(t, voidable, "refund", "refund", emulator.PubKey(), txShortHouse, 0, prev, nil); err == nil {
		t.Fatal("refund shorting writer share must fail")
	}

	// Before expiry + voidAfter must fail.
	early := compileArtifact(t, art, predictVaultArgs(2, writer.PubKey(), holder.PubKey(), oracle.PubKey(), backup.PubKey(), writerScript, holderScript, testStrike, now-testVoidAfter+120), keys)
	prevEarly := &mockPrevOuts{outputs: map[wire.OutPoint]*wire.TxOut{op0: {Value: testCollateral, PkScript: early.pkScript}}}
	if err := execArkadeLeaf(t, early, "refund", "refund", emulator.PubKey(), tx, 0, prevEarly, nil); err == nil {
		t.Fatal("refund before expiry+voidAfter must fail")
	}
}

func TestPredictVaultReboardIntentGuards(t *testing.T) {
	writer := privKeyFromByte(31)
	holder := privKeyFromByte(32)
	backup := privKeyFromByte(33)
	oracle := privKeyFromByte(34)
	server := privKeyFromByte(35)
	emulator := privKeyFromByte(36)
	keys := contractKeys{serverKey: server.PubKey(), emulatorKey: emulator.PubKey()}

	writerScript := p2trScript(xOnlyPub(writer))
	holderScript := p2trScript(xOnlyPub(holder))
	art := loadArtifact(t, "predict_vault.artifact.json")
	vault := compileArtifact(t, art, predictVaultArgs(2, writer.PubKey(), holder.PubKey(), oracle.PubKey(), backup.PubKey(), writerScript, holderScript, testStrike, time.Now().Unix()+3600), keys)

	buildIntentTx := func(version int32, outScript []byte, outValue int64) (*wire.MsgTx, *mockPrevOuts) {
		op0 := dummyOutPoint(4, 0)
		op1 := dummyOutPoint(5, 0)
		tx := wire.NewMsgTx(version)
		tx.AddTxIn(wire.NewTxIn(&op0, nil, nil))
		tx.AddTxIn(wire.NewTxIn(&op1, nil, nil))
		tx.AddTxOut(wire.NewTxOut(outValue, outScript))
		prev := &mockPrevOuts{
			outputs: map[wire.OutPoint]*wire.TxOut{
				op0: {Value: 0, PkScript: vault.pkScript},
				op1: {Value: testCollateral, PkScript: vault.pkScript},
			},
		}
		return tx, prev
	}

	tx, prev := buildIntentTx(2, vault.pkScript, testCollateral)
	if err := execArkadeLeaf(t, vault, "reboard", "reboard", emulator.PubKey(), tx, 1, prev, nil,
		arkade.WithIntentMessage(`{"type":"register","onchain_output_indexes":[]}`),
	); err != nil {
		t.Fatalf("reboard register with empty onchain_output_indexes should succeed: %v", err)
	}
	if err := execArkadeLeaf(t, vault, "reboard", "reboard", emulator.PubKey(), tx, 1, prev, nil,
		arkade.WithIntentMessage(`{"type":"delete","expire_at":0}`),
	); err != nil {
		t.Fatalf("reboard delete proof should succeed: %v", err)
	}
	if err := execArkadeLeaf(t, vault, "reboard", "reboard", emulator.PubKey(), tx, 1, prev, nil,
		arkade.WithIntentMessage(`{"type":"register","onchain_output_indexes":[0]}`),
	); err == nil {
		t.Fatal("reboard with non-empty onchain_output_indexes must fail")
	}
	if err := execArkadeLeaf(t, vault, "reboard", "reboard", emulator.PubKey(), tx, 1, prev, nil,
		arkade.WithIntentMessage(`{"type":"claim"}`),
	); err == nil {
		t.Fatal("reboard with unknown intent type must fail")
	}

	txV3, prevV3 := buildIntentTx(3, vault.pkScript, testCollateral)
	if err := execArkadeLeaf(t, vault, "reboard", "reboard", emulator.PubKey(), txV3, 1, prevV3, nil,
		arkade.WithIntentMessage(`{"type":"register","onchain_output_indexes":[]}`),
	); err == nil {
		t.Fatal("reboard with tx.version != 2 must fail")
	}

	txDrain, prevDrain := buildIntentTx(2, writerScript, testCollateral)
	if err := execArkadeLeaf(t, vault, "reboard", "reboard", emulator.PubKey(), txDrain, 1, prevDrain, nil,
		arkade.WithIntentMessage(`{"type":"register","onchain_output_indexes":[]}`),
	); err == nil {
		t.Fatal("reboard changing scriptPubKey must fail OP_TUNNEL")
	}

	txShort, prevShort := buildIntentTx(2, vault.pkScript, testCollateral-1)
	if err := execArkadeLeaf(t, vault, "reboard", "reboard", emulator.PubKey(), txShort, 1, prevShort, nil,
		arkade.WithIntentMessage(`{"type":"register","onchain_output_indexes":[]}`),
	); err == nil {
		t.Fatal("reboard reducing value must fail OP_TUNNEL")
	}
}

func TestPredictVaultClose2of2(t *testing.T) {
	writer := privKeyFromByte(41)
	holder := privKeyFromByte(42)
	backup := privKeyFromByte(43)
	oracle := privKeyFromByte(44)
	server := privKeyFromByte(45)
	emulator := privKeyFromByte(46)
	keys := contractKeys{serverKey: server.PubKey(), emulatorKey: emulator.PubKey()}

	writerScript := p2trScript(xOnlyPub(writer))
	holderScript := p2trScript(xOnlyPub(holder))
	art := loadArtifact(t, "predict_vault.artifact.json")
	vault := compileArtifact(t, art, predictVaultArgs(2, writer.PubKey(), holder.PubKey(), oracle.PubKey(), backup.PubKey(), writerScript, holderScript, testStrike, time.Now().Unix()+3600), keys)

	op0 := dummyOutPoint(6, 0)
	tx := wire.NewMsgTx(3)
	tx.AddTxIn(wire.NewTxIn(&op0, nil, nil))
	tx.AddTxOut(wire.NewTxOut(testCollateral, holderScript))
	prev := &mockPrevOuts{outputs: map[wire.OutPoint]*wire.TxOut{op0: {Value: testCollateral, PkScript: vault.pkScript}}}

	tapLeaf := txscript.NewTapLeaf(txscript.BaseLeafVersion, vault.leafScripts["close"])
	sighash, err := arkade.CalcArkadeScriptSignatureHash(
		txscript.NewTxSigHashes(tx, prev),
		txscript.SigHashDefault,
		tx,
		0,
		prev,
		tapLeaf,
	)
	if err != nil {
		t.Fatalf("sighash: %v", err)
	}
	writerSig, err := schnorr.Sign(writer, sighash)
	if err != nil {
		t.Fatalf("sign writer: %v", err)
	}
	holderSig, err := schnorr.Sign(holder, sighash)
	if err != nil {
		t.Fatalf("sign holder: %v", err)
	}

	if err := execArkadeLeaf(t, vault, "close", "close", emulator.PubKey(), tx, 0, prev, wire.TxWitness{holderSig.Serialize(), writerSig.Serialize()}); err != nil {
		t.Fatalf("2-of-2 close should succeed: %v", err)
	}
	if err := execArkadeLeaf(t, vault, "close", "close", emulator.PubKey(), tx, 0, prev, wire.TxWitness{writerSig.Serialize(), holderSig.Serialize()}); err == nil {
		t.Fatal("swapped signatures on close must fail")
	}
}

func TestOptionIntentFinalizeAndCancelCltv(t *testing.T) {
	user := privKeyFromByte(51)
	solver := privKeyFromByte(52)
	vaultKey := privKeyFromByte(53)
	server := privKeyFromByte(54)
	emulator := privKeyFromByte(55)
	keys := contractKeys{serverKey: server.PubKey(), emulatorKey: emulator.PubKey()}

	userScript := p2trScript(xOnlyPub(user))
	solverScript := p2trScript(xOnlyPub(solver))
	vaultScript := p2trScript(xOnlyPub(vaultKey))
	now := time.Now().Unix()
	art := loadArtifact(t, "option_intent.artifact.json")

	openIntent := compileArtifact(t, art, optionIntentArgs(user.PubKey(), userScript, solverScript, vaultScript, now+600), keys)
	op0 := dummyOutPoint(7, 0)
	op1 := dummyOutPoint(8, 0)
	txFill := wire.NewMsgTx(3)
	txFill.AddTxIn(wire.NewTxIn(&op0, nil, nil))
	txFill.AddTxIn(wire.NewTxIn(&op1, nil, nil))
	txFill.AddTxOut(wire.NewTxOut(testStake, solverScript))
	txFill.AddTxOut(wire.NewTxOut(testCollateral, vaultScript))
	prevFill := &mockPrevOuts{
		outputs: map[wire.OutPoint]*wire.TxOut{
			op0: {Value: testStake, PkScript: openIntent.pkScript},
			op1: {Value: testCollateral, PkScript: solverScript},
		},
	}
	if err := execArkadeLeaf(t, openIntent, "finalize", "finalize", emulator.PubKey(), txFill, 0, prevFill, nil); err != nil {
		t.Fatalf("open intent finalize should succeed: %v", err)
	}

	txCancel := wire.NewMsgTx(3)
	txCancel.AddTxIn(wire.NewTxIn(&op0, nil, nil))
	txCancel.AddTxOut(wire.NewTxOut(testStake, userScript))
	prevCancelOpen := &mockPrevOuts{outputs: map[wire.OutPoint]*wire.TxOut{op0: {Value: testStake, PkScript: openIntent.pkScript}}}
	if err := execArkadeLeaf(t, openIntent, "cancel", "cancel", emulator.PubKey(), txCancel, 0, prevCancelOpen, nil); err == nil {
		t.Fatal("cancel before deadline must fail")
	}

	expiredIntent := compileArtifact(t, art, optionIntentArgs(user.PubKey(), userScript, solverScript, vaultScript, now-60), keys)
	prevExpired := &mockPrevOuts{outputs: map[wire.OutPoint]*wire.TxOut{op0: {Value: testStake, PkScript: expiredIntent.pkScript}}}
	if err := execArkadeLeaf(t, expiredIntent, "cancel", "cancel", emulator.PubKey(), txCancel, 0, prevExpired, nil); err != nil {
		t.Fatalf("cancel after deadline should succeed: %v", err)
	}
	if err := execArkadeLeaf(t, expiredIntent, "cancelAuto", "cancelCltv", emulator.PubKey(), txCancel, 0, prevExpired, nil); err != nil {
		t.Fatalf("cancelAuto/cancelCltv after deadline should succeed: %v", err)
	}
	prevExpiredFill := &mockPrevOuts{
		outputs: map[wire.OutPoint]*wire.TxOut{
			op0: {Value: testStake, PkScript: expiredIntent.pkScript},
			op1: {Value: testCollateral, PkScript: solverScript},
		},
	}
	if err := execArkadeLeaf(t, expiredIntent, "finalize", "finalize", emulator.PubKey(), txFill, 0, prevExpiredFill, nil); err == nil {
		t.Fatal("finalize after deadline must fail")
	}
}

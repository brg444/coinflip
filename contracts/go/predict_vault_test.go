package contractstest

import (
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
	writerPk, holderPk, backupPk *btcec.PublicKey,
	writerScript, holderScript []byte,
	expiry int64,
	oraclePk []byte,
) map[string][]byte {
	return map[string][]byte{
		"kind":                 int64Bytes(kind),
		"writerPk":             schnorr.SerializePubKey(writerPk),
		"holderPk":             schnorr.SerializePubKey(holderPk),
		"writerScript.program": writerScript[2:],
		"writerScript.version": int64Bytes(1),
		"holderScript.program": holderScript[2:],
		"holderScript.version": int64Bytes(1),
		"strike":               int64Bytes(testStrike),
		"collateral":           int64Bytes(testCollateral),
		"stake":                int64Bytes(testStake),
		"expiry":               int64Bytes(expiry),
		"oraclePk":             oraclePk,
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

	diaPub := mustHex("100211ee120bca9f272034d98b1b026bb4ab735ebeb5da8be6a69bf7ee0ea24cfd48")
	predictArt := loadArtifact(t, "predict_vault.artifact.json")
	intentArt := loadArtifact(t, "option_intent.artifact.json")

	vault2 := compileArtifact(t, predictArt, predictVaultArgs(2, writer.PubKey(), holder.PubKey(), backup.PubKey(), writerScript, holderScript, 1_790_000_100, diaPub), keys)
	vault3 := compileArtifact(t, predictArt, predictVaultArgs(3, writer.PubKey(), holder.PubKey(), backup.PubKey(), writerScript, holderScript, 1_790_000_100, diaPub), keys)
	intent2 := compileArtifact(t, intentArt, optionIntentArgs(holder.PubKey(), holderScript, writerScript, vault2.pkScript, 1_790_000_000), keys)

	if got, want := hex.EncodeToString(vault2.pkScript), "5120fa22b8698c15fc97715882d63ecdab2f2b0bb0ba9859607e673ff163e5ae368a"; got != want {
		t.Fatalf("kind 2 vault pkScript mismatch:\ngot  %s\nwant %s", got, want)
	}
	if got, want := hex.EncodeToString(intent2.pkScript), "512006bbc5aa88c41ba9b38c1559abac19375c7154ff4cd8d5552afd2f1863c7eccb"; got != want {
		t.Fatalf("kind 2 intent pkScript mismatch:\ngot  %s\nwant %s", got, want)
	}
	if got, want := hex.EncodeToString(vault3.pkScript), "5120d677c7227f3a010360728f6ba8199893d50f20c74eb3c7f0a1bff25c9c132c51"; got != want {
		t.Fatalf("kind 3 vault pkScript mismatch:\ngot  %s\nwant %s", got, want)
	}
}

func TestPredictVaultSettleAndBackup(t *testing.T) {
	writer := privKeyFromByte(11)
	holder := privKeyFromByte(12)
	backup := privKeyFromByte(13)
	server := privKeyFromByte(14)
	emulator := privKeyFromByte(15)
	oracle := privKeyFromByte(16)
	wrongOracle := privKeyFromByte(17)
	keys := contractKeys{serverKey: server.PubKey(), emulatorKey: emulator.PubKey()}

	writerScript := p2trScript(xOnlyPub(writer))
	holderScript := p2trScript(xOnlyPub(holder))
	oraclePk := diaOraclePk(oracle)
	now := time.Now().Unix()
	pastExpiry := now - 120
	futureExpiry := now + 3_600
	art := loadArtifact(t, "predict_vault.artifact.json")

	buildSettleTx := func(vault compiledContract, locked int64, payScript []byte, payAmt int64, extraInput bool) (*wire.MsgTx, *mockPrevOuts) {
		op0 := dummyOutPoint(1, 0)
		tx := wire.NewMsgTx(3)
		tx.AddTxIn(wire.NewTxIn(&op0, nil, nil))
		prevOuts := &mockPrevOuts{
			outputs: map[wire.OutPoint]*wire.TxOut{
				op0: {Value: locked, PkScript: vault.pkScript},
			},
		}
		if extraInput {
			op1 := dummyOutPoint(2, 0)
			tx.AddTxIn(wire.NewTxIn(&op1, nil, nil))
			prevOuts.outputs[op1] = &wire.TxOut{Value: 10_000, PkScript: holderScript}
		}
		tx.AddTxOut(wire.NewTxOut(payAmt, payScript))
		return tx, prevOuts
	}

	makeWitness := func(rawPrice *big.Int, sampleTime, nonce, intentExpiry int64, sig []byte) wire.TxWitness {
		return wire.TxWitness{
			sig,
			int64Bytes(intentExpiry),
			int64Bytes(nonce),
			int64Bytes(sampleTime),
			scriptNumBytes(rawPrice),
		}
	}

	// Kind 2 (higher): above strike pays holder, at/below strike pays writer.
	vault2 := compileArtifact(t, art, predictVaultArgs(2, writer.PubKey(), holder.PubKey(), backup.PubKey(), writerScript, holderScript, pastExpiry, oraclePk), keys)

	rawHigh, sigHigh := signDiaCents(oracle, testStrike+1, pastExpiry+10, 1, pastExpiry+3600)
	tx, prev := buildSettleTx(vault2, testCollateral, holderScript, testCollateral, false)
	if err := execArkadeLeaf(t, vault2, "settle", "settle", emulator.PubKey(), tx, 0, prev, makeWitness(rawHigh, pastExpiry+10, 1, pastExpiry+3600, sigHigh)); err != nil {
		t.Fatalf("kind 2 win should succeed: %v", err)
	}

	// Tier 2 settleBackup with fee-sponsor second input and tweaked backupPk.
	txFee, prevFee := buildSettleTx(vault2, testCollateral, holderScript, testCollateral, true)
	if err := execArkadeLeaf(t, vault2, "settle", "settleBackup", backup.PubKey(), txFee, 0, prevFee, makeWitness(rawHigh, pastExpiry+10, 1, pastExpiry+3600, sigHigh)); err != nil {
		t.Fatalf("settleBackup with fee sponsor input should succeed: %v", err)
	}
	if err := execArkadeLeaf(t, vault2, "settle", "settleBackup", emulator.PubKey(), txFee, 0, prevFee, makeWitness(rawHigh, pastExpiry+10, 1, pastExpiry+3600, sigHigh)); err == nil {
		t.Fatal("settleBackup must reject non-backup signer key")
	}

	// Paying writer when holder won must fail.
	txWrongPayee, prevWrongPayee := buildSettleTx(vault2, testCollateral, writerScript, testCollateral, false)
	if err := execArkadeLeaf(t, vault2, "settle", "settle", emulator.PubKey(), txWrongPayee, 0, prevWrongPayee, makeWitness(rawHigh, pastExpiry+10, 1, pastExpiry+3600, sigHigh)); err == nil {
		t.Fatal("kind 2 win paying writer must fail")
	}

	// Exact strike pays writer.
	rawEq, sigEq := signDiaCents(oracle, testStrike, pastExpiry, 2, pastExpiry+3600)
	txEq, prevEq := buildSettleTx(vault2, testCollateral, writerScript, testCollateral, false)
	if err := execArkadeLeaf(t, vault2, "settle", "settle", emulator.PubKey(), txEq, 0, prevEq, makeWitness(rawEq, pastExpiry, 2, pastExpiry+3600, sigEq)); err != nil {
		t.Fatalf("kind 2 exact strike paying writer should succeed: %v", err)
	}

	// Kind 3 (lower): below strike pays holder, exact strike pays writer.
	vault3 := compileArtifact(t, art, predictVaultArgs(3, writer.PubKey(), holder.PubKey(), backup.PubKey(), writerScript, holderScript, pastExpiry, oraclePk), keys)
	rawLow, sigLow := signDiaCents(oracle, testStrike-1, pastExpiry+60, 3, pastExpiry+3600)
	txLow, prevLow := buildSettleTx(vault3, testCollateral, holderScript, testCollateral, false)
	if err := execArkadeLeaf(t, vault3, "settle", "settle", emulator.PubKey(), txLow, 0, prevLow, makeWitness(rawLow, pastExpiry+60, 3, pastExpiry+3600, sigLow)); err != nil {
		t.Fatalf("kind 3 win should succeed: %v", err)
	}
	txLowEq, prevLowEq := buildSettleTx(vault3, testCollateral, writerScript, testCollateral, false)
	if err := execArkadeLeaf(t, vault3, "settle", "settle", emulator.PubKey(), txLowEq, 0, prevLowEq, makeWitness(rawEq, pastExpiry, 2, pastExpiry+3600, sigEq)); err != nil {
		t.Fatalf("kind 3 exact strike paying writer should succeed: %v", err)
	}

	// Security rejections.
	badSig := append([]byte(nil), sigHigh...)
	badSig[0] ^= 0xff
	if err := execArkadeLeaf(t, vault2, "settle", "settle", emulator.PubKey(), tx, 0, prev, makeWitness(rawHigh, pastExpiry+10, 1, pastExpiry+3600, badSig)); err == nil {
		t.Fatal("bad DIA sig must fail")
	}
	_, wrongOracleSig := signDiaCents(wrongOracle, testStrike+1, pastExpiry+10, 1, pastExpiry+3600)
	if err := execArkadeLeaf(t, vault2, "settle", "settle", emulator.PubKey(), tx, 0, prev, makeWitness(rawHigh, pastExpiry+10, 1, pastExpiry+3600, wrongOracleSig)); err == nil {
		t.Fatal("wrong oracle signer must fail")
	}
	rawEarly, sigEarly := signDiaCents(oracle, testStrike+1, pastExpiry-1, 4, pastExpiry+3600)
	if err := execArkadeLeaf(t, vault2, "settle", "settle", emulator.PubKey(), tx, 0, prev, makeWitness(rawEarly, pastExpiry-1, 4, pastExpiry+3600, sigEarly)); err == nil {
		t.Fatal("sample before expiry must fail")
	}
	rawLate, sigLate := signDiaCents(oracle, testStrike+1, pastExpiry+61, 5, pastExpiry+3600)
	if err := execArkadeLeaf(t, vault2, "settle", "settle", emulator.PubKey(), tx, 0, prev, makeWitness(rawLate, pastExpiry+61, 5, pastExpiry+3600, sigLate)); err == nil {
		t.Fatal("sample after expiry+60 must fail")
	}
	txShort, prevShort := buildSettleTx(vault2, testCollateral, holderScript, testCollateral-1, false)
	if err := execArkadeLeaf(t, vault2, "settle", "settle", emulator.PubKey(), txShort, 0, prevShort, makeWitness(rawHigh, pastExpiry+10, 1, pastExpiry+3600, sigHigh)); err == nil {
		t.Fatal("short payout must fail")
	}
	txUnder, prevUnder := buildSettleTx(vault2, testCollateral-1, holderScript, testCollateral-1, false)
	if err := execArkadeLeaf(t, vault2, "settle", "settle", emulator.PubKey(), txUnder, 0, prevUnder, makeWitness(rawHigh, pastExpiry+10, 1, pastExpiry+3600, sigHigh)); err == nil {
		t.Fatal("underfunded vault must fail")
	}

	vaultFuture := compileArtifact(t, art, predictVaultArgs(2, writer.PubKey(), holder.PubKey(), backup.PubKey(), writerScript, holderScript, futureExpiry, oraclePk), keys)
	rawFut, sigFut := signDiaCents(oracle, testStrike+1, futureExpiry+5, 6, futureExpiry+3600)
	txFut, prevFut := buildSettleTx(vaultFuture, testCollateral, holderScript, testCollateral, false)
	if err := execArkadeLeaf(t, vaultFuture, "settle", "settle", emulator.PubKey(), txFut, 0, prevFut, makeWitness(rawFut, futureExpiry+5, 6, futureExpiry+3600, sigFut)); err == nil {
		t.Fatal("settle before expiry must fail OP_CHECKTIME")
	}
}

func TestPredictVaultRefundAndBackup(t *testing.T) {
	writer := privKeyFromByte(21)
	holder := privKeyFromByte(22)
	backup := privKeyFromByte(23)
	server := privKeyFromByte(24)
	emulator := privKeyFromByte(25)
	oracle := privKeyFromByte(26)
	keys := contractKeys{serverKey: server.PubKey(), emulatorKey: emulator.PubKey()}

	writerScript := p2trScript(xOnlyPub(writer))
	holderScript := p2trScript(xOnlyPub(holder))
	now := time.Now().Unix()
	art := loadArtifact(t, "predict_vault.artifact.json")

	// Voidable vault: expiry + voidAfter is in the past.
	voidable := compileArtifact(t, art, predictVaultArgs(2, writer.PubKey(), holder.PubKey(), backup.PubKey(), writerScript, holderScript, now-testVoidAfter-60, diaOraclePk(oracle)), keys)

	op0 := dummyOutPoint(3, 0)
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
	early := compileArtifact(t, art, predictVaultArgs(2, writer.PubKey(), holder.PubKey(), backup.PubKey(), writerScript, holderScript, now-testVoidAfter+120, diaOraclePk(oracle)), keys)
	prevEarly := &mockPrevOuts{outputs: map[wire.OutPoint]*wire.TxOut{op0: {Value: testCollateral, PkScript: early.pkScript}}}
	if err := execArkadeLeaf(t, early, "refund", "refund", emulator.PubKey(), tx, 0, prevEarly, nil); err == nil {
		t.Fatal("refund before expiry+voidAfter must fail")
	}
}

func TestPredictVaultReboardIntentGuards(t *testing.T) {
	writer := privKeyFromByte(31)
	holder := privKeyFromByte(32)
	backup := privKeyFromByte(33)
	server := privKeyFromByte(34)
	emulator := privKeyFromByte(35)
	oracle := privKeyFromByte(36)
	keys := contractKeys{serverKey: server.PubKey(), emulatorKey: emulator.PubKey()}

	writerScript := p2trScript(xOnlyPub(writer))
	holderScript := p2trScript(xOnlyPub(holder))
	art := loadArtifact(t, "predict_vault.artifact.json")
	vault := compileArtifact(t, art, predictVaultArgs(2, writer.PubKey(), holder.PubKey(), backup.PubKey(), writerScript, holderScript, time.Now().Unix()+3600, diaOraclePk(oracle)), keys)

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
	server := privKeyFromByte(44)
	emulator := privKeyFromByte(45)
	oracle := privKeyFromByte(46)
	keys := contractKeys{serverKey: server.PubKey(), emulatorKey: emulator.PubKey()}

	writerScript := p2trScript(xOnlyPub(writer))
	holderScript := p2trScript(xOnlyPub(holder))
	art := loadArtifact(t, "predict_vault.artifact.json")
	vault := compileArtifact(t, art, predictVaultArgs(2, writer.PubKey(), holder.PubKey(), backup.PubKey(), writerScript, holderScript, time.Now().Unix()+3600, diaOraclePk(oracle)), keys)

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

	// Open intent (deadline in future): finalize succeeds, cancel fails.
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

	txEarlyCancel := wire.NewMsgTx(3)
	txEarlyCancel.AddTxIn(wire.NewTxIn(&op0, nil, nil))
	txEarlyCancel.AddTxOut(wire.NewTxOut(testStake, userScript))
	prevCancelOpen := &mockPrevOuts{outputs: map[wire.OutPoint]*wire.TxOut{op0: {Value: testStake, PkScript: openIntent.pkScript}}}
	if err := execArkadeLeaf(t, openIntent, "cancel", "cancel", emulator.PubKey(), txEarlyCancel, 0, prevCancelOpen, nil); err == nil {
		t.Fatal("cancel before deadline must fail")
	}

	// Expired intent (deadline in past): finalize fails, both cancel and cancelAuto/cancelCltv succeed.
	expiredIntent := compileArtifact(t, art, optionIntentArgs(user.PubKey(), userScript, solverScript, vaultScript, now-60), keys)
	prevExpired := &mockPrevOuts{outputs: map[wire.OutPoint]*wire.TxOut{op0: {Value: testStake, PkScript: expiredIntent.pkScript}}}
	if err := execArkadeLeaf(t, expiredIntent, "cancel", "cancel", emulator.PubKey(), txEarlyCancel, 0, prevExpired, nil); err != nil {
		t.Fatalf("cancel after deadline should succeed: %v", err)
	}
	if err := execArkadeLeaf(t, expiredIntent, "cancelAuto", "cancelCltv", emulator.PubKey(), txEarlyCancel, 0, prevExpired, nil); err != nil {
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

package contractstest

import (
	"encoding/hex"
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
	testReadFee        int64 = 1_000
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
	beaconTxid []byte,
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
		"beaconTxid":           beaconTxid,
		"beaconGidx":           int64Bytes(0),
		"readFee":              int64Bytes(testReadFee),
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

	beaconTxid := make([]byte, 32)
	for i := range beaconTxid {
		beaconTxid[i] = 0x07
	}
	predictArt := loadArtifact(t, "predict_vault.artifact.json")
	intentArt := loadArtifact(t, "option_intent.artifact.json")

	vault2 := compileArtifact(t, predictArt, predictVaultArgs(2, writer.PubKey(), holder.PubKey(), backup.PubKey(), writerScript, holderScript, 1_790_000_100, beaconTxid), keys)
	vault3 := compileArtifact(t, predictArt, predictVaultArgs(3, writer.PubKey(), holder.PubKey(), backup.PubKey(), writerScript, holderScript, 1_790_000_100, beaconTxid), keys)
	intent2 := compileArtifact(t, intentArt, optionIntentArgs(holder.PubKey(), holderScript, writerScript, vault2.pkScript, 1_790_000_000), keys)

	if got, want := hex.EncodeToString(vault2.pkScript), "51207b405215b7d16ec19aa55b993294d890b9e8944fb023d6b7b10eb8bb9a6f99b4"; got != want {
		t.Fatalf("kind 2 vault pkScript mismatch:\ngot  %s\nwant %s", got, want)
	}
	if got, want := hex.EncodeToString(intent2.pkScript), "51203f1f2037a47238c2530028ef91236c687699fcd3d8a445e8ca50b5e9dc73dc22"; got != want {
		t.Fatalf("kind 2 intent pkScript mismatch:\ngot  %s\nwant %s", got, want)
	}
	if got, want := hex.EncodeToString(vault3.pkScript), "512042e9fa8dae5118e76c1ff18498f78543c5d7fea0dc356d639110c4564292f2da"; got != want {
		t.Fatalf("kind 3 vault pkScript mismatch:\ngot  %s\nwant %s", got, want)
	}
}

func TestPredictVaultSettleBeaconCanonicalFixing(t *testing.T) {
	writer := privKeyFromByte(11)
	holder := privKeyFromByte(12)
	backup := privKeyFromByte(13)
	server := privKeyFromByte(14)
	emulator := privKeyFromByte(15)
	beaconKey := privKeyFromByte(16)
	keys := contractKeys{serverKey: server.PubKey(), emulatorKey: emulator.PubKey()}

	writerScript := p2trScript(xOnlyPub(writer))
	holderScript := p2trScript(xOnlyPub(holder))
	beaconScript := p2trScript(xOnlyPub(beaconKey))
	var beaconTxid [32]byte
	beaconTxid[0] = 0x07
	var wrongBeaconTxid [32]byte
	wrongBeaconTxid[0] = 0x09

	now := time.Now().Unix()
	pastExpiry := now - 120
	futureExpiry := now + 3_600
	art := loadArtifact(t, "predict_vault.artifact.json")

	buildBeaconSettle := func(
		vault compiledContract,
		locked int64,
		payScript []byte,
		payAmt int64,
		assetTxid [32]byte,
		slots []beaconSlot,
	) (*wire.MsgTx, *mockPrevOuts) {
		state := encodeBeaconState(1, slots)
		prevBeacon := beaconPrevTx(t, beaconScript, state)
		op0 := dummyOutPoint(1, 0)
		op1 := dummyOutPoint(2, 0)
		tx := wire.NewMsgTx(3)
		tx.AddTxIn(wire.NewTxIn(&op0, nil, nil))
		tx.AddTxIn(wire.NewTxIn(&op1, nil, nil))
		tx.AddTxOut(wire.NewTxOut(330+testReadFee, beaconScript))
		tx.AddTxOut(wire.NewTxOut(payAmt, payScript))
		tx.AddTxOut(beaconTransferExtTxOut(t, assetTxid, 0, state))
		prev := &mockPrevOuts{
			outputs: map[wire.OutPoint]*wire.TxOut{
				op0: {Value: locked, PkScript: vault.pkScript},
				op1: {Value: 330, PkScript: beaconScript},
			},
			arkTxs: map[wire.OutPoint]*wire.MsgTx{
				op1: prevBeacon,
			},
		}
		return tx, prev
	}

	pot := testCollateral - testReadFee
	vault2 := compileArtifact(t, art, predictVaultArgs(2, writer.PubKey(), holder.PubKey(), backup.PubKey(), writerScript, holderScript, pastExpiry, beaconTxid[:]), keys)

	// Kind 2 above strike pays holder (pot = collateral - readFee); paying writer fails.
	txWin, prevWin := buildBeaconSettle(vault2, testCollateral, holderScript, pot, beaconTxid, []beaconSlot{{pastExpiry, testStrike + 1, pastExpiry + 10}})
	if err := execArkadeLeaf(t, vault2, "settle", "settle", emulator.PubKey(), txWin, 0, prevWin, nil); err != nil {
		t.Fatalf("kind 2 beacon win should succeed: %v", err)
	}
	txWrong, prevWrong := buildBeaconSettle(vault2, testCollateral, writerScript, pot, beaconTxid, []beaconSlot{{pastExpiry, testStrike + 1, pastExpiry + 10}})
	if err := execArkadeLeaf(t, vault2, "settle", "settle", emulator.PubKey(), txWrong, 0, prevWrong, nil); err == nil {
		t.Fatal("kind 2 beacon win paying writer must fail")
	}

	// Newest matching slot wins: a second conflicting slot in older history cannot flip the outcome.
	txNewest, prevNewest := buildBeaconSettle(vault2, testCollateral, holderScript, pot, beaconTxid, []beaconSlot{
		{pastExpiry, testStrike + 50, pastExpiry + 55},
		{pastExpiry, testStrike - 50, pastExpiry + 5},
	})
	if err := execArkadeLeaf(t, vault2, "settle", "settle", emulator.PubKey(), txNewest, 0, prevNewest, nil); err != nil {
		t.Fatalf("newest slot matching holder win should succeed: %v", err)
	}
	txOldFlip, prevOldFlip := buildBeaconSettle(vault2, testCollateral, writerScript, pot, beaconTxid, []beaconSlot{
		{pastExpiry, testStrike + 50, pastExpiry + 55},
		{pastExpiry, testStrike - 50, pastExpiry + 5},
	})
	if err := execArkadeLeaf(t, vault2, "settle", "settle", emulator.PubKey(), txOldFlip, 0, prevOldFlip, nil); err == nil {
		t.Fatal("older conflicting slot must not flip canonical newest fixing")
	}

	// Exact strike pays writer.
	txEq, prevEq := buildBeaconSettle(vault2, testCollateral, writerScript, pot, beaconTxid, []beaconSlot{{pastExpiry, testStrike, pastExpiry}})
	if err := execArkadeLeaf(t, vault2, "settle", "settle", emulator.PubKey(), txEq, 0, prevEq, nil); err != nil {
		t.Fatalf("kind 2 exact strike paying writer should succeed: %v", err)
	}

	// Kind 3 below strike pays holder; exact strike pays writer.
	vault3 := compileArtifact(t, art, predictVaultArgs(3, writer.PubKey(), holder.PubKey(), backup.PubKey(), writerScript, holderScript, pastExpiry, beaconTxid[:]), keys)
	txLow, prevLow := buildBeaconSettle(vault3, testCollateral, holderScript, pot, beaconTxid, []beaconSlot{{pastExpiry, testStrike - 1, pastExpiry + 60}})
	if err := execArkadeLeaf(t, vault3, "settle", "settle", emulator.PubKey(), txLow, 0, prevLow, nil); err != nil {
		t.Fatalf("kind 3 beacon win should succeed: %v", err)
	}
	txLowEq, prevLowEq := buildBeaconSettle(vault3, testCollateral, writerScript, pot, beaconTxid, []beaconSlot{{pastExpiry, testStrike, pastExpiry}})
	if err := execArkadeLeaf(t, vault3, "settle", "settle", emulator.PubKey(), txLowEq, 0, prevLowEq, nil); err != nil {
		t.Fatalf("kind 3 exact strike paying writer should succeed: %v", err)
	}

	// Security rejections.
	txBadBeacon, prevBadBeacon := buildBeaconSettle(vault2, testCollateral, holderScript, pot, wrongBeaconTxid, []beaconSlot{{pastExpiry, testStrike + 1, pastExpiry + 10}})
	if err := execArkadeLeaf(t, vault2, "settle", "settle", emulator.PubKey(), txBadBeacon, 0, prevBadBeacon, nil); err == nil {
		t.Fatal("wrong beacon asset must fail")
	}
	txNoSlot, prevNoSlot := buildBeaconSettle(vault2, testCollateral, holderScript, pot, beaconTxid, []beaconSlot{{pastExpiry + 300, testStrike + 1, pastExpiry + 310}})
	if err := execArkadeLeaf(t, vault2, "settle", "settle", emulator.PubKey(), txNoSlot, 0, prevNoSlot, nil); err == nil {
		t.Fatal("missing expiry slot must fail")
	}
	txEarlySample, prevEarlySample := buildBeaconSettle(vault2, testCollateral, holderScript, pot, beaconTxid, []beaconSlot{{pastExpiry, testStrike + 1, pastExpiry - 1}})
	if err := execArkadeLeaf(t, vault2, "settle", "settle", emulator.PubKey(), txEarlySample, 0, prevEarlySample, nil); err == nil {
		t.Fatal("sample before expiry must fail")
	}
	txLateSample, prevLateSample := buildBeaconSettle(vault2, testCollateral, holderScript, pot, beaconTxid, []beaconSlot{{pastExpiry, testStrike + 1, pastExpiry + 61}})
	if err := execArkadeLeaf(t, vault2, "settle", "settle", emulator.PubKey(), txLateSample, 0, prevLateSample, nil); err == nil {
		t.Fatal("sample after expiry+60 must fail")
	}
	txShort, prevShort := buildBeaconSettle(vault2, testCollateral, holderScript, pot-1, beaconTxid, []beaconSlot{{pastExpiry, testStrike + 1, pastExpiry + 10}})
	if err := execArkadeLeaf(t, vault2, "settle", "settle", emulator.PubKey(), txShort, 0, prevShort, nil); err == nil {
		t.Fatal("short payout must fail")
	}
	txUnder, prevUnder := buildBeaconSettle(vault2, testCollateral-1, holderScript, pot-1, beaconTxid, []beaconSlot{{pastExpiry, testStrike + 1, pastExpiry + 10}})
	if err := execArkadeLeaf(t, vault2, "settle", "settle", emulator.PubKey(), txUnder, 0, prevUnder, nil); err == nil {
		t.Fatal("underfunded vault must fail")
	}

	vaultFuture := compileArtifact(t, art, predictVaultArgs(2, writer.PubKey(), holder.PubKey(), backup.PubKey(), writerScript, holderScript, futureExpiry, beaconTxid[:]), keys)
	txFut, prevFut := buildBeaconSettle(vaultFuture, testCollateral, holderScript, pot, beaconTxid, []beaconSlot{{futureExpiry, testStrike + 1, futureExpiry + 5}})
	if err := execArkadeLeaf(t, vaultFuture, "settle", "settle", emulator.PubKey(), txFut, 0, prevFut, nil); err == nil {
		t.Fatal("settle before expiry must fail OP_CHECKTIME")
	}
}

func TestPredictVaultRefundAndBackup(t *testing.T) {
	writer := privKeyFromByte(21)
	holder := privKeyFromByte(22)
	backup := privKeyFromByte(23)
	server := privKeyFromByte(24)
	emulator := privKeyFromByte(25)
	keys := contractKeys{serverKey: server.PubKey(), emulatorKey: emulator.PubKey()}

	writerScript := p2trScript(xOnlyPub(writer))
	holderScript := p2trScript(xOnlyPub(holder))
	var beaconTxid [32]byte
	beaconTxid[0] = 0x07
	now := time.Now().Unix()
	art := loadArtifact(t, "predict_vault.artifact.json")

	voidable := compileArtifact(t, art, predictVaultArgs(2, writer.PubKey(), holder.PubKey(), backup.PubKey(), writerScript, holderScript, now-testVoidAfter-60, beaconTxid[:]), keys)

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
	early := compileArtifact(t, art, predictVaultArgs(2, writer.PubKey(), holder.PubKey(), backup.PubKey(), writerScript, holderScript, now-testVoidAfter+120, beaconTxid[:]), keys)
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
	keys := contractKeys{serverKey: server.PubKey(), emulatorKey: emulator.PubKey()}

	writerScript := p2trScript(xOnlyPub(writer))
	holderScript := p2trScript(xOnlyPub(holder))
	var beaconTxid [32]byte
	beaconTxid[0] = 0x07
	art := loadArtifact(t, "predict_vault.artifact.json")
	vault := compileArtifact(t, art, predictVaultArgs(2, writer.PubKey(), holder.PubKey(), backup.PubKey(), writerScript, holderScript, time.Now().Unix()+3600, beaconTxid[:]), keys)

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
	keys := contractKeys{serverKey: server.PubKey(), emulatorKey: emulator.PubKey()}

	writerScript := p2trScript(xOnlyPub(writer))
	holderScript := p2trScript(xOnlyPub(holder))
	var beaconTxid [32]byte
	beaconTxid[0] = 0x07
	art := loadArtifact(t, "predict_vault.artifact.json")
	vault := compileArtifact(t, art, predictVaultArgs(2, writer.PubKey(), holder.PubKey(), backup.PubKey(), writerScript, holderScript, time.Now().Unix()+3600, beaconTxid[:]), keys)

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

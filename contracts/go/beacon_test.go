package contractstest

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"math/big"
	"testing"

	"github.com/arkade-os/arkd/pkg/ark-lib/asset"
	"github.com/arkade-os/arkd/pkg/ark-lib/extension"
	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/btcec/v2/schnorr"
	"github.com/btcsuite/btcd/chainhash/v2"
	"github.com/btcsuite/btcd/wire/v2"
)

type recordedDia struct {
	expiry       int64
	rawPrice     string
	cents        int64
	sampleTime   int64
	nonce        string
	intentExpiry int64
	sigHex       string
}

// Real Lasernet BTC/USD OracleUpdate prints signed by the pinned DIA key on 5-minute closes.
var (
	recordedDia1 = recordedDia{
		expiry:       1795593000,
		rawPrice:     "58728258984125017358336",
		cents:        5872826,
		sampleTime:   1795593002,
		nonce:        "1793790301274586439",
		intentExpiry: 1795596602,
		sigHex:       "7980c73f7210211fd2887cc55bd0df6e049ccb57771131a81ed1bb655a6b52887fa15bb26be0e35f0de52badce56190ec3df541814e8652d0f9314a088c26280",
	}
	recordedDia2 = recordedDia{
		expiry:       1795593300,
		rawPrice:     "58625783362453267021824",
		cents:        5862578,
		sampleTime:   1795593302,
		nonce:        "1793790301274586451",
		intentExpiry: 1795596902,
		sigHex:       "20ff8e96d370f05b83595e832a8825505ccdaa12633f2ef12186cc851ed0af0d1b4a3b1cd5a066df39fe5c244748997f06c367ee9b60ed2bc7378590eaf07af4",
	}
)

func beaconArgs(ctrlTxid []byte, adminPk *btcec.PublicKey) map[string][]byte {
	return map[string][]byte{
		"ctrlTxid":  ctrlTxid,
		"ctrlGidx":  int64Bytes(0),
		"domain":    []byte("BTCUSD-FIX"),
		"expiryLag": int64Bytes(60),
		"readFee":   int64Bytes(testReadFee),
		"adminPk":   schnorr.SerializePubKey(adminPk),
		"exit":      int64Bytes(exitSequence(testExitDelay)),
	}
}

func leUint32(n uint32) []byte {
	var b [4]byte
	binary.LittleEndian.PutUint32(b[:], n)
	return b[:]
}

func leUint64(n uint64) []byte {
	var b [8]byte
	binary.LittleEndian.PutUint64(b[:], n)
	return b[:]
}

func beaconAttestDigest(domain []byte, ctrlTxid []byte, ctrlGidx uint32, round uint64, expiry, cents, sampleTime int64) []byte {
	h := sha256.New()
	h.Write(domain)
	h.Write([]byte("attest"))
	h.Write(ctrlTxid)
	h.Write(leUint32(ctrlGidx))
	h.Write(leUint64(round))
	h.Write(leUint64(uint64(expiry)))
	h.Write(leUint64(uint64(cents)))
	h.Write(leUint64(uint64(sampleTime)))
	return h.Sum(nil)
}

func beaconMigrateDigest(domain []byte, ctrlTxid []byte, ctrlGidx uint32, round uint64, nextProgram []byte) []byte {
	h := sha256.New()
	h.Write(domain)
	h.Write([]byte("migrate"))
	h.Write(ctrlTxid)
	h.Write(leUint32(ctrlGidx))
	h.Write(leUint64(round))
	h.Write(nextProgram)
	return h.Sum(nil)
}

func beaconReboardDigest(domain []byte, ctrlTxid []byte, ctrlGidx uint32, opTxid []byte, opVout uint32) []byte {
	h := sha256.New()
	h.Write(domain)
	h.Write([]byte("reboard"))
	h.Write(ctrlTxid)
	h.Write(leUint32(ctrlGidx))
	h.Write(opTxid)
	h.Write(leUint32(opVout))
	return h.Sum(nil)
}

func beaconReseedDigest(domain []byte, ctrlTxid []byte, ctrlGidx uint32, opTxid []byte, opVout uint32, round uint64, lastExpiry int64) []byte {
	h := sha256.New()
	h.Write(domain)
	h.Write([]byte("reseed"))
	h.Write(ctrlTxid)
	h.Write(leUint32(ctrlGidx))
	h.Write(opTxid)
	h.Write(leUint32(opVout))
	h.Write(leUint64(round))
	h.Write(leUint64(uint64(lastExpiry)))
	return h.Sum(nil)
}

func beaconAssetOnlyExt(t *testing.T, beaconTxid [32]byte, inIdx uint16) *wire.TxOut {
	t.Helper()
	var hash chainhash.Hash
	copy(hash[:], beaconTxid[:])
	aid := &asset.AssetId{Txid: hash, Index: 0}
	in, err := asset.NewAssetInput(inIdx, 1)
	if err != nil {
		t.Fatalf("asset input: %v", err)
	}
	out, err := asset.NewAssetOutput(0, 1)
	if err != nil {
		t.Fatalf("asset output: %v", err)
	}
	grp, err := asset.NewAssetGroup(aid, nil, []asset.AssetInput{*in}, []asset.AssetOutput{*out}, nil)
	if err != nil {
		t.Fatalf("asset group: %v", err)
	}
	pkt, err := asset.NewPacket([]asset.AssetGroup{*grp})
	if err != nil {
		t.Fatalf("asset packet: %v", err)
	}
	ext, err := extension.NewExtensionFromPackets(pkt)
	if err != nil {
		t.Fatalf("beacon asset ext: %v", err)
	}
	txOut, err := ext.TxOut()
	if err != nil {
		t.Fatalf("beacon asset ext txout: %v", err)
	}
	return txOut
}

func mustBigInt(s string) *big.Int {
	v, ok := new(big.Int).SetString(s, 10)
	if !ok {
		panic(s)
	}
	return v
}

func mustDecodeHex(s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return b
}

func beaconSelfTransferExt(t *testing.T, beaconTxid [32]byte, inIdx uint16, state []byte) *wire.TxOut {
	t.Helper()
	var hash chainhash.Hash
	copy(hash[:], beaconTxid[:])
	aid := &asset.AssetId{Txid: hash, Index: 0}
	in, err := asset.NewAssetInput(inIdx, 1)
	if err != nil {
		t.Fatalf("asset input: %v", err)
	}
	out, err := asset.NewAssetOutput(0, 1)
	if err != nil {
		t.Fatalf("asset output: %v", err)
	}
	grp, err := asset.NewAssetGroup(aid, nil, []asset.AssetInput{*in}, []asset.AssetOutput{*out}, nil)
	if err != nil {
		t.Fatalf("asset group: %v", err)
	}
	pkt, err := asset.NewPacket([]asset.AssetGroup{*grp})
	if err != nil {
		t.Fatalf("asset packet: %v", err)
	}
	ext, err := extension.NewExtensionFromPackets(pkt, extension.UnknownPacket{PacketType: 32, Data: state})
	if err != nil {
		t.Fatalf("beacon ext: %v", err)
	}
	txOut, err := ext.TxOut()
	if err != nil {
		t.Fatalf("beacon ext txout: %v", err)
	}
	return txOut
}

func TestAttestationBeaconScriptParityWithTS(t *testing.T) {
	admin := privKeyFromByte(1)
	server := privKeyFromByte(8)
	emulator := privKeyFromByte(9)
	keys := contractKeys{serverKey: server.PubKey(), emulatorKey: emulator.PubKey()}

	ctrlTxid := make([]byte, 32)
	for i := range ctrlTxid {
		ctrlTxid[i] = 0x07
	}
	art := loadArtifact(t, "attestation_beacon.artifact.json")
	beacon := compileArtifact(t, art, beaconArgs(ctrlTxid, admin.PubKey()), keys)
	want := "51201e1ed57ce75940b544f6ee68d1996bee0688f19fb9bebbd722a363aff0fe1aae"
	if got := hex.EncodeToString(beacon.pkScript); got != want {
		t.Fatalf("beacon pkScript mismatch:\ngot  %s\nwant %s", got, want)
	}
}

func TestAttestationBeaconAttestAuthGridAndMonotonicity(t *testing.T) {
	admin := privKeyFromByte(61)
	stranger := privKeyFromByte(62)
	server := privKeyFromByte(63)
	emulator := privKeyFromByte(64)
	keys := contractKeys{serverKey: server.PubKey(), emulatorKey: emulator.PubKey()}

	var ctrlTxid [32]byte
	ctrlTxid[0] = 0x07
	art := loadArtifact(t, "attestation_beacon.artifact.json")
	beacon := compileArtifact(t, art, beaconArgs(ctrlTxid[:], admin.PubKey()), keys)
	domain := []byte("BTCUSD-FIX")

	runAttest := func(
		prevRound uint64,
		prevSlots []beaconSlot,
		d recordedDia,
		expiry int64,
		price *big.Int,
		diaSig []byte,
		signer *btcec.PrivateKey,
		signRound uint64,
	) error {
		prevState := encodeBeaconState(prevRound, prevSlots)
		nextSlots := append([]beaconSlot{{expiry, d.cents, d.sampleTime}}, prevSlots...)
		nextState := encodeBeaconState(prevRound+1, nextSlots)

		prevTx := beaconPrevTx(t, beacon.pkScript, prevState)
		op0 := dummyOutPoint(10, 0)
		tx := wire.NewMsgTx(3)
		tx.AddTxIn(wire.NewTxIn(&op0, nil, nil))
		tx.AddTxOut(wire.NewTxOut(330, beacon.pkScript))
		tx.AddTxOut(beaconSelfTransferExt(t, ctrlTxid, 0, nextState))
		prev := &mockPrevOuts{
			outputs: map[wire.OutPoint]*wire.TxOut{op0: {Value: 330, PkScript: beacon.pkScript}},
			arkTxs:  map[wire.OutPoint]*wire.MsgTx{op0: prevTx},
		}
		digest := beaconAttestDigest(domain, ctrlTxid[:], 0, signRound, expiry, d.cents, d.sampleTime)
		adminSig, err := schnorr.Sign(signer, digest)
		if err != nil {
			t.Fatalf("sign admin: %v", err)
		}
		witness := wire.TxWitness{
			adminSig.Serialize(),
			diaSig,
			int64Bytes(d.intentExpiry),
			scriptNumBytes(mustBigInt(d.nonce)),
			int64Bytes(d.sampleTime),
			scriptNumBytes(price),
			int64Bytes(expiry),
		}
		return execArkadeLeaf(t, beacon, "attest", "attest", emulator.PubKey(), tx, 0, prev, witness)
	}

	p1 := mustBigInt(recordedDia1.rawPrice)
	s1 := mustDecodeHex(recordedDia1.sigHex)
	p2 := mustBigInt(recordedDia2.rawPrice)
	s2 := mustDecodeHex(recordedDia2.sigHex)

	// Valid DIA + valid adminPk on 5-minute grid from genesis succeeds.
	if err := runAttest(0, nil, recordedDia1, recordedDia1.expiry, p1, s1, admin, 0); err != nil {
		t.Fatalf("valid attest from genesis should succeed: %v", err)
	}

	// Valid DIA + stranger signature (front-running without adminPk) must fail.
	if err := runAttest(0, nil, recordedDia1, recordedDia1.expiry, p1, s1, stranger, 0); err == nil {
		t.Fatal("attest without adminPk signature must fail")
	}

	// Valid adminPk + tampered DIA price (oracle attempting to invent a price) must fail.
	tampered := new(big.Int).Add(p1, big.NewInt(1))
	if err := runAttest(0, nil, recordedDia1, recordedDia1.expiry, tampered, s1, admin, 0); err == nil {
		t.Fatal("attest with invalid DIA signature must fail")
	}

	// Wrong round in adminSig must fail replay check.
	if err := runAttest(0, nil, recordedDia1, recordedDia1.expiry, p1, s1, admin, 1); err == nil {
		t.Fatal("attest with wrong round in adminSig must fail")
	}

	// Off-grid expiry (not a multiple of 300s) must fail even with valid DIA + adminSig.
	if err := runAttest(0, nil, recordedDia1, recordedDia1.expiry-30, p1, s1, admin, 0); err == nil {
		t.Fatal("off-grid expiry must fail")
	}

	// Strictly advancing close (1795593000 -> 1795593300) succeeds.
	afterOne := []beaconSlot{{recordedDia1.expiry, recordedDia1.cents, recordedDia1.sampleTime}}
	if err := runAttest(1, afterOne, recordedDia2, recordedDia2.expiry, p2, s2, admin, 1); err != nil {
		t.Fatalf("strictly advancing close should succeed: %v", err)
	}

	// Earlier or evicted close cannot be re-attested once beacon has advanced (flushing attack blocked).
	afterEight := make([]beaconSlot, 8)
	for i := range 8 {
		afterEight[i] = beaconSlot{recordedDia2.expiry + int64(7-i)*300, recordedDia2.cents, recordedDia2.sampleTime}
	}
	if err := runAttest(9, afterEight, recordedDia1, recordedDia1.expiry, p1, s1, admin, 9); err == nil {
		t.Fatal("re-attesting evicted earlier close must fail expiry order")
	}
}

func TestAttestationBeaconReadAndMigrate(t *testing.T) {
	admin := privKeyFromByte(71)
	stranger := privKeyFromByte(72)
	nextKey := privKeyFromByte(73)
	server := privKeyFromByte(74)
	emulator := privKeyFromByte(75)
	keys := contractKeys{serverKey: server.PubKey(), emulatorKey: emulator.PubKey()}

	var ctrlTxid [32]byte
	ctrlTxid[0] = 0x07
	art := loadArtifact(t, "attestation_beacon.artifact.json")
	beacon := compileArtifact(t, art, beaconArgs(ctrlTxid[:], admin.PubKey()), keys)
	domain := []byte("BTCUSD-FIX")

	state := encodeBeaconState(3, []beaconSlot{{recordedDia1.expiry, recordedDia1.cents, recordedDia1.sampleTime}})
	prevTx := beaconPrevTx(t, beacon.pkScript, state)

	// read(selfIndex=1) adds readFee and carries state unchanged.
	op0 := dummyOutPoint(11, 0)
	op1 := dummyOutPoint(12, 0)
	txRead := wire.NewMsgTx(3)
	txRead.AddTxIn(wire.NewTxIn(&op0, nil, nil))
	txRead.AddTxIn(wire.NewTxIn(&op1, nil, nil))
	txRead.AddTxOut(wire.NewTxOut(330+testReadFee, beacon.pkScript))
	txRead.AddTxOut(beaconSelfTransferExt(t, ctrlTxid, 1, state))
	prevRead := &mockPrevOuts{
		outputs: map[wire.OutPoint]*wire.TxOut{
			op0: {Value: 50_000, PkScript: p2trScript(xOnlyPub(stranger))},
			op1: {Value: 330, PkScript: beacon.pkScript},
		},
		arkTxs: map[wire.OutPoint]*wire.MsgTx{op1: prevTx},
	}
	if err := execArkadeLeaf(t, beacon, "read", "read", emulator.PubKey(), txRead, 1, prevRead, wire.TxWitness{int64Bytes(1)}); err != nil {
		t.Fatalf("beacon read should succeed: %v", err)
	}
	txReadShort := txRead.Copy()
	txReadShort.TxOut[0].Value = 330 + testReadFee - 1
	if err := execArkadeLeaf(t, beacon, "read", "read", emulator.PubKey(), txReadShort, 1, prevRead, wire.TxWitness{int64Bytes(1)}); err == nil {
		t.Fatal("beacon read shorting readFee must fail")
	}

	// migrate(next, opSig) moves beacon coin, state, and identity asset to nextScript with adminPk signature.
	nextProg := xOnlyPub(nextKey)
	nextScript := p2trScript(nextProg)
	txMig := wire.NewMsgTx(3)
	txMig.AddTxIn(wire.NewTxIn(&op1, nil, nil))
	txMig.AddTxOut(wire.NewTxOut(330, nextScript))
	txMig.AddTxOut(beaconSelfTransferExt(t, ctrlTxid, 0, state))
	prevMig := &mockPrevOuts{
		outputs: map[wire.OutPoint]*wire.TxOut{op1: {Value: 330, PkScript: beacon.pkScript}},
		arkTxs:  map[wire.OutPoint]*wire.MsgTx{op1: prevTx},
	}
	migDigest := beaconMigrateDigest(domain, ctrlTxid[:], 0, 3, nextProg)
	adminMigSig, err := schnorr.Sign(admin, migDigest)
	if err != nil {
		t.Fatalf("sign migrate: %v", err)
	}
	if err := execArkadeLeaf(t, beacon, "migrate", "migrate", emulator.PubKey(), txMig, 0, prevMig, wire.TxWitness{
		adminMigSig.Serialize(),
		int64Bytes(1),
		nextProg,
	}); err != nil {
		t.Fatalf("beacon migrate with adminPk should succeed: %v", err)
	}
	badMigSig, err := schnorr.Sign(stranger, migDigest)
	if err != nil {
		t.Fatalf("sign bad migrate: %v", err)
	}
	if err := execArkadeLeaf(t, beacon, "migrate", "migrate", emulator.PubKey(), txMig, 0, prevMig, wire.TxWitness{
		badMigSig.Serialize(),
		int64Bytes(1),
		nextProg,
	}); err == nil {
		t.Fatal("beacon migrate with wrong signer must fail")
	}
}

func TestAttestationBeaconReboardAndReseed(t *testing.T) {
	admin := privKeyFromByte(81)
	stranger := privKeyFromByte(82)
	server := privKeyFromByte(83)
	emulator := privKeyFromByte(84)
	keys := contractKeys{serverKey: server.PubKey(), emulatorKey: emulator.PubKey()}

	var ctrlTxid [32]byte
	ctrlTxid[0] = 0x07
	art := loadArtifact(t, "attestation_beacon.artifact.json")
	beacon := compileArtifact(t, art, beaconArgs(ctrlTxid[:], admin.PubKey()), keys)
	domain := []byte("BTCUSD-FIX")

	// reboard(opSig) succeeds on v2 register/delete intent with adminPk signature bound to outpoint.
	op0 := dummyOutPoint(21, 0)
	op1 := dummyOutPoint(22, 0)
	txReboard := wire.NewMsgTx(2)
	txReboard.AddTxIn(wire.NewTxIn(&op0, nil, nil))
	txReboard.AddTxIn(wire.NewTxIn(&op1, nil, nil))
	txReboard.AddTxOut(wire.NewTxOut(330, beacon.pkScript))
	txReboard.AddTxOut(beaconAssetOnlyExt(t, ctrlTxid, 1))
	prevReboard := &mockPrevOuts{
		outputs: map[wire.OutPoint]*wire.TxOut{
			op0: {Value: 0, PkScript: beacon.pkScript},
			op1: {Value: 330, PkScript: beacon.pkScript},
		},
	}
	rbDigest := beaconReboardDigest(domain, ctrlTxid[:], 0, op1.Hash[:], op1.Index)
	adminRbSig, err := schnorr.Sign(admin, rbDigest)
	if err != nil {
		t.Fatalf("sign reboard: %v", err)
	}
	strangerRbSig, err := schnorr.Sign(stranger, rbDigest)
	if err != nil {
		t.Fatalf("sign stranger reboard: %v", err)
	}
	if err := execArkadeLeaf(t, beacon, "reboard", "reboard", emulator.PubKey(), txReboard, 1, prevReboard, wire.TxWitness{adminRbSig.Serialize()},
		arkade.WithIntentMessage(`{"type":"register","onchain_output_indexes":[]}`),
	); err != nil {
		t.Fatalf("valid beacon reboard register should succeed: %v", err)
	}
	if err := execArkadeLeaf(t, beacon, "reboard", "reboard", emulator.PubKey(), txReboard, 1, prevReboard, wire.TxWitness{adminRbSig.Serialize()},
		arkade.WithIntentMessage(`{"type":"delete"}`),
	); err != nil {
		t.Fatalf("valid beacon reboard delete should succeed: %v", err)
	}
	if err := execArkadeLeaf(t, beacon, "reboard", "reboard", emulator.PubKey(), txReboard, 1, prevReboard, wire.TxWitness{strangerRbSig.Serialize()},
		arkade.WithIntentMessage(`{"type":"register","onchain_output_indexes":[]}`),
	); err == nil {
		t.Fatal("beacon reboard without adminPk signature must fail")
	}
	if err := execArkadeLeaf(t, beacon, "reboard", "reboard", emulator.PubKey(), txReboard, 1, prevReboard, wire.TxWitness{adminRbSig.Serialize()},
		arkade.WithIntentMessage(`{"type":"register","onchain_output_indexes":[0]}`),
	); err == nil {
		t.Fatal("beacon reboard with onchain output must fail")
	}

	// reseed(round, lastExpiry, opSig) succeeds ONLY when input lacks STATE and all slot values are zero.
	unseededPrev := wire.NewMsgTx(3)
	unseededPrev.AddTxOut(wire.NewTxOut(330, beacon.pkScript))
	reseedOp := dummyOutPoint(23, 0)
	reseedState := encodeBeaconState(4, []beaconSlot{{recordedDia1.expiry, 0, 0}})
	txReseed := wire.NewMsgTx(3)
	txReseed.AddTxIn(wire.NewTxIn(&reseedOp, nil, nil))
	txReseed.AddTxOut(wire.NewTxOut(330, beacon.pkScript))
	txReseed.AddTxOut(beaconSelfTransferExt(t, ctrlTxid, 0, reseedState))
	prevReseed := &mockPrevOuts{
		outputs: map[wire.OutPoint]*wire.TxOut{reseedOp: {Value: 330, PkScript: beacon.pkScript}},
		arkTxs:  map[wire.OutPoint]*wire.MsgTx{reseedOp: unseededPrev},
	}
	rsDigest := beaconReseedDigest(domain, ctrlTxid[:], 0, reseedOp.Hash[:], reseedOp.Index, 4, recordedDia1.expiry)
	adminRsSig, err := schnorr.Sign(admin, rsDigest)
	if err != nil {
		t.Fatalf("sign reseed: %v", err)
	}
	if err := execArkadeLeaf(t, beacon, "reseed", "reseed", emulator.PubKey(), txReseed, 0, prevReseed, wire.TxWitness{
		adminRsSig.Serialize(),
		int64Bytes(recordedDia1.expiry),
		int64Bytes(4),
	}); err != nil {
		t.Fatalf("valid reseed on unseeded beacon should succeed: %v", err)
	}

	// reseed on an already-seeded beacon coin must fail.
	seededPrev := beaconPrevTx(t, beacon.pkScript, encodeBeaconState(3, []beaconSlot{{recordedDia1.expiry, recordedDia1.cents, recordedDia1.sampleTime}}))
	prevAlreadySeeded := &mockPrevOuts{
		outputs: map[wire.OutPoint]*wire.TxOut{reseedOp: {Value: 330, PkScript: beacon.pkScript}},
		arkTxs:  map[wire.OutPoint]*wire.MsgTx{reseedOp: seededPrev},
	}
	if err := execArkadeLeaf(t, beacon, "reseed", "reseed", emulator.PubKey(), txReseed, 0, prevAlreadySeeded, wire.TxWitness{
		adminRsSig.Serialize(),
		int64Bytes(recordedDia1.expiry),
		int64Bytes(4),
	}); err == nil {
		t.Fatal("reseed on already-seeded beacon coin must fail")
	}

	// reseed attempting to inject a non-zero price in slot 0 must fail.
	forgedPriceState := encodeBeaconState(4, []beaconSlot{{recordedDia1.expiry, recordedDia1.cents, recordedDia1.sampleTime}})
	txForgedPrice := wire.NewMsgTx(3)
	txForgedPrice.AddTxIn(wire.NewTxIn(&reseedOp, nil, nil))
	txForgedPrice.AddTxOut(wire.NewTxOut(330, beacon.pkScript))
	txForgedPrice.AddTxOut(beaconSelfTransferExt(t, ctrlTxid, 0, forgedPriceState))
	if err := execArkadeLeaf(t, beacon, "reseed", "reseed", emulator.PubKey(), txForgedPrice, 0, prevReseed, wire.TxWitness{
		adminRsSig.Serialize(),
		int64Bytes(recordedDia1.expiry),
		int64Bytes(4),
	}); err == nil {
		t.Fatal("reseed injecting a non-zero price must fail")
	}

	// reseed replaying signature onto a different outpoint must fail.
	otherOp := dummyOutPoint(24, 0)
	txReplay := wire.NewMsgTx(3)
	txReplay.AddTxIn(wire.NewTxIn(&otherOp, nil, nil))
	txReplay.AddTxOut(wire.NewTxOut(330, beacon.pkScript))
	txReplay.AddTxOut(beaconSelfTransferExt(t, ctrlTxid, 0, reseedState))
	prevReplay := &mockPrevOuts{
		outputs: map[wire.OutPoint]*wire.TxOut{otherOp: {Value: 330, PkScript: beacon.pkScript}},
		arkTxs:  map[wire.OutPoint]*wire.MsgTx{otherOp: unseededPrev},
	}
	if err := execArkadeLeaf(t, beacon, "reseed", "reseed", emulator.PubKey(), txReplay, 0, prevReplay, wire.TxWitness{
		adminRsSig.Serialize(),
		int64Bytes(recordedDia1.expiry),
		int64Bytes(4),
	}); err == nil {
		t.Fatal("reseed signature replay onto different outpoint must fail")
	}
}

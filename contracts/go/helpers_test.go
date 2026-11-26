package contractstest

import (
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/arkade-os/arkd/pkg/ark-lib/asset"
	"github.com/arkade-os/arkd/pkg/ark-lib/extension"
	scriptlib "github.com/arkade-os/arkd/pkg/ark-lib/script"
	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/btcec/v2/schnorr"
	"github.com/btcsuite/btcd/chainhash/v2"
	"github.com/btcsuite/btcd/psbt/v2"
	"github.com/btcsuite/btcd/txscript/v2"
	"github.com/btcsuite/btcd/wire/v2"
)

const testReadFee int64 = 1_000

type artifactFile struct {
	ContractName string             `json:"contractName"`
	Functions    []artifactFunction `json:"functions"`
}

type artifactFunction struct {
	Name   string          `json:"name"`
	Arkade *artifactArkade `json:"arkade,omitempty"`
	Leaves []artifactLeaf  `json:"leaves"`
}

type artifactArkade struct {
	Asm []string `json:"asm"`
}

type artifactLeaf struct {
	Name string   `json:"name"`
	Asm  []string `json:"asm"`
}

type compiledContract struct {
	arkadeScripts map[string][]byte
	leafScripts   map[string][]byte
	pkScript      []byte
	tapKey        *btcec.PublicKey
}

type contractKeys struct {
	serverKey   *btcec.PublicKey
	emulatorKey *btcec.PublicKey
}

func loadArtifact(t *testing.T, name string) artifactFile {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", name))
	if err != nil {
		t.Fatalf("read artifact %s: %v", name, err)
	}
	var art artifactFile
	if err := json.Unmarshal(raw, &art); err != nil {
		t.Fatalf("parse artifact %s: %v", name, err)
	}
	return art
}

func privKeyFromByte(b byte) *btcec.PrivateKey {
	var raw [32]byte
	raw[31] = b
	priv, _ := btcec.PrivKeyFromBytes(raw[:])
	return priv
}

func xOnlyPub(priv *btcec.PrivateKey) []byte {
	return schnorr.SerializePubKey(priv.PubKey())
}

func p2trScript(xOnlyKey []byte) []byte {
	out := make([]byte, 34)
	out[0] = txscript.OP_1
	out[1] = 0x20
	copy(out[2:], xOnlyKey)
	return out
}

func scriptNumBytes(v *big.Int) []byte {
	if v.Sign() == 0 {
		return nil
	}
	neg := v.Sign() < 0
	abs := new(big.Int).Abs(v).Bytes()
	out := make([]byte, len(abs))
	for i := range abs {
		out[i] = abs[len(abs)-1-i]
	}
	if out[len(out)-1]&0x80 != 0 {
		if neg {
			out = append(out, 0x80)
		} else {
			out = append(out, 0x00)
		}
	} else if neg {
		out[len(out)-1] |= 0x80
	}
	return out
}

func int64Bytes(n int64) []byte {
	return scriptNumBytes(big.NewInt(n))
}

func exitSequence(seconds int64) int64 {
	if seconds <= 0 || seconds%512 != 0 {
		panic(fmt.Sprintf("exit delay must be a positive multiple of 512: %d", seconds))
	}
	return 0x400000 | (seconds / 512)
}

func encodeScriptAsm(
	tokens []string,
	args map[string][]byte,
	keys contractKeys,
	arkadeScripts map[string][]byte,
) ([]byte, error) {
	b := txscript.NewScriptBuilder()
	for _, tok := range tokens {
		switch {
		case strings.HasPrefix(tok, "<") && strings.HasSuffix(tok, ">"):
			inner := tok[1 : len(tok)-1]
			switch {
			case inner == "SERVER_KEY":
				b.AddData(schnorr.SerializePubKey(keys.serverKey))
			case strings.HasPrefix(inner, "EMULATOR_KEY:"):
				fn := strings.TrimPrefix(inner, "EMULATOR_KEY:")
				scr, ok := arkadeScripts[fn]
				if !ok {
					return nil, fmt.Errorf("missing arkade script for %s", fn)
				}
				tweaked := arkade.ComputeArkadeScriptPublicKey(keys.emulatorKey, arkade.ArkadeScriptHash(scr))
				b.AddData(schnorr.SerializePubKey(tweaked))
			case strings.HasPrefix(inner, "TWEAK:"):
				parts := strings.Split(inner, ":")
				if len(parts) != 3 {
					return nil, fmt.Errorf("bad tweak placeholder %s", tok)
				}
				baseRaw, ok := args[parts[1]]
				if !ok {
					return nil, fmt.Errorf("missing tweak key arg %s", parts[1])
				}
				basePub, err := schnorr.ParsePubKey(baseRaw)
				if err != nil {
					return nil, fmt.Errorf("parse tweak key %s: %w", parts[1], err)
				}
				scr, ok := arkadeScripts[parts[2]]
				if !ok {
					return nil, fmt.Errorf("missing arkade script for %s", parts[2])
				}
				tweaked := arkade.ComputeArkadeScriptPublicKey(basePub, arkade.ArkadeScriptHash(scr))
				b.AddData(schnorr.SerializePubKey(tweaked))
			default:
				val, ok := args[inner]
				if !ok {
					return nil, fmt.Errorf("missing constructor arg %s", inner)
				}
				b.AddData(val)
			}
		case strings.HasPrefix(tok, "OP_"):
			op, ok := arkade.OpcodeByName[tok]
			if !ok {
				return nil, fmt.Errorf("unknown opcode %s", tok)
			}
			b.AddOp(op)
		case strings.HasPrefix(tok, "0x"):
			raw, err := hex.DecodeString(strings.TrimPrefix(tok, "0x"))
			if err != nil {
				return nil, fmt.Errorf("decode hex %s: %w", tok, err)
			}
			b.AddData(raw)
		default:
			n, ok := new(big.Int).SetString(tok, 10)
			if !ok {
				return nil, fmt.Errorf("unsupported asm token %q", tok)
			}
			b.AddData(scriptNumBytes(n))
		}
	}
	return b.Script()
}

func compileArtifact(t *testing.T, art artifactFile, args map[string][]byte, keys contractKeys) compiledContract {
	t.Helper()
	arkScripts := make(map[string][]byte)
	for _, fn := range art.Functions {
		if fn.Arkade == nil {
			continue
		}
		scr, err := encodeScriptAsm(fn.Arkade.Asm, args, keys, nil)
		if err != nil {
			t.Fatalf("compile %s.%s arkade: %v", art.ContractName, fn.Name, err)
		}
		arkScripts[fn.Name] = scr
	}
	leafScripts := make(map[string][]byte)
	var closures []scriptlib.Closure
	for _, fn := range art.Functions {
		for _, leaf := range fn.Leaves {
			scr, err := encodeScriptAsm(leaf.Asm, args, keys, arkScripts)
			if err != nil {
				t.Fatalf("compile %s.%s leaf: %v", art.ContractName, leaf.Name, err)
			}
			leafScripts[leaf.Name] = scr
			closure, err := scriptlib.DecodeClosure(scr)
			if err != nil {
				t.Fatalf("decode closure %s.%s: %v", art.ContractName, leaf.Name, err)
			}
			closures = append(closures, closure)
		}
	}
	vtxo := &scriptlib.TapscriptsVtxoScript{Closures: closures}
	tapKey, _, err := vtxo.TapTree()
	if err != nil {
		t.Fatalf("build tap tree for %s: %v", art.ContractName, err)
	}
	return compiledContract{
		arkadeScripts: arkScripts,
		leafScripts:   leafScripts,
		pkScript:      p2trScript(schnorr.SerializePubKey(tapKey)),
		tapKey:        tapKey,
	}
}

type mockPrevOuts struct {
	outputs map[wire.OutPoint]*wire.TxOut
	arkTxs  map[wire.OutPoint]*wire.MsgTx
	scripts map[wire.OutPoint][]byte
}

func (m *mockPrevOuts) FetchPrevOutput(op wire.OutPoint) *wire.TxOut {
	return m.outputs[op]
}

func (m *mockPrevOuts) FetchPrevOutArkTx(op wire.OutPoint) *wire.MsgTx {
	return m.arkTxs[op]
}

func (m *mockPrevOuts) FetchVtxoPrevOutPkScript(op wire.OutPoint) []byte {
	if s := m.scripts[op]; s != nil {
		return s
	}
	if out := m.outputs[op]; out != nil {
		return out.PkScript
	}
	return nil
}

func execArkadeLeaf(
	t *testing.T,
	bound compiledContract,
	fnName string,
	leafName string,
	signerPub *btcec.PublicKey,
	tx *wire.MsgTx,
	inputIdx int,
	prevOuts *mockPrevOuts,
	witness wire.TxWitness,
	opts ...arkade.ExecuteOption,
) error {
	t.Helper()
	arkScr, ok := bound.arkadeScripts[fnName]
	if !ok {
		t.Fatalf("missing arkade script %s", fnName)
	}
	leafScr, ok := bound.leafScripts[leafName]
	if !ok {
		t.Fatalf("missing leaf script %s", leafName)
	}
	ptx, err := psbt.NewFromUnsignedTx(tx)
	if err != nil {
		t.Fatalf("new psbt: %v", err)
	}
	ptx.Inputs[inputIdx].TaprootLeafScript = []*psbt.TaprootTapLeafScript{{
		Script:      leafScr,
		LeafVersion: txscript.BaseLeafVersion,
	}}
	entry := arkade.EmulatorEntry{
		Vin:     uint16(inputIdx),
		Script:  arkScr,
		Witness: witness,
	}
	parsed, err := arkade.ReadArkadeScript(ptx, signerPub, entry)
	if err != nil {
		return err
	}
	return parsed.Execute(tx, prevOuts, inputIdx, opts...)
}

type beaconSlot struct {
	expiry     int64
	priceCents int64
	sampleTime int64
}

func encodeBeaconState(round uint64, slots []beaconSlot) []byte {
	buf := make([]byte, 329)
	buf[0] = 0x01
	binary.LittleEndian.PutUint64(buf[1:9], round)
	for i, slot := range slots {
		if i >= 8 {
			break
		}
		off := 9 + i*40
		binary.LittleEndian.PutUint64(buf[off:off+8], uint64(slot.expiry))
		binary.LittleEndian.PutUint64(buf[off+8:off+16], uint64(slot.priceCents))
		binary.LittleEndian.PutUint64(buf[off+16:off+24], uint64(slot.sampleTime))
	}
	return buf
}

func beaconPrevTx(t *testing.T, beaconScript []byte, state []byte) *wire.MsgTx {
	t.Helper()
	ext, err := extension.NewExtensionFromPackets(extension.UnknownPacket{PacketType: 32, Data: state})
	if err != nil {
		t.Fatalf("beacon state ext: %v", err)
	}
	extOut, err := ext.TxOut()
	if err != nil {
		t.Fatalf("beacon state txout: %v", err)
	}
	prev := wire.NewMsgTx(3)
	prev.AddTxIn(wire.NewTxIn(&wire.OutPoint{}, nil, nil))
	prev.AddTxOut(wire.NewTxOut(330, beaconScript))
	prev.AddTxOut(extOut)
	return prev
}

func beaconTransferExtTxOut(t *testing.T, beaconTxid [32]byte, beaconGidx uint16, state []byte) *wire.TxOut {
	t.Helper()
	var hash chainhash.Hash
	copy(hash[:], beaconTxid[:])
	aid := &asset.AssetId{Txid: hash, Index: beaconGidx}
	in, err := asset.NewAssetInput(1, 1)
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
		t.Fatalf("transfer ext: %v", err)
	}
	txOut, err := ext.TxOut()
	if err != nil {
		t.Fatalf("transfer ext txout: %v", err)
	}
	return txOut
}

func dummyOutPoint(tag byte, vout uint32) wire.OutPoint {
	var h chainhash.Hash
	h[0] = tag
	return wire.OutPoint{Hash: h, Index: vout}
}

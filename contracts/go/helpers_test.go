package contractstest

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"

	scriptlib "github.com/arkade-os/arkd/pkg/ark-lib/script"
	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/btcec/v2/ecdsa"
	"github.com/btcsuite/btcd/btcec/v2/schnorr"
	"github.com/btcsuite/btcd/chainhash/v2"
	"github.com/btcsuite/btcd/psbt/v2"
	"github.com/btcsuite/btcd/txscript/v2"
	"github.com/btcsuite/btcd/wire/v2"
	"golang.org/x/crypto/sha3"
)

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

func mustHex(s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return b
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

func keccak256(parts ...[]byte) []byte {
	h := sha3.NewLegacyKeccak256()
	for _, p := range parts {
		h.Write(p)
	}
	return h.Sum(nil)
}

func wordBE32(n *big.Int) []byte {
	out := make([]byte, 32)
	b := n.Bytes()
	copy(out[32-len(b):], b)
	return out
}

var (
	diaDomain     = mustHex("f57d55f057fd4aba6b1a7f8bccb6a3e826cf71fd34971f22a39d7ffd6e620fb3")
	diaTypehash   = mustHex("24e574fa7512cc24e9109b981256e33759d91bc2ee9b74a2bf633e013c0620b5")
	diaIntentType = mustHex("ef9b6324ed493183babb66ed98fcf36e9bcb0243ae4c5a29fcd99184b08f1899")
	diaVersion    = mustHex("e6bbd6277e1bf288eed5e8d1780f9a50b239e86b153736bceebccf4ea79d90b3")
	diaSymbol     = mustHex("ee62665949c883f9e0f6f002eac32e00bd59dfe6c34e92a91c37d6a8322d6489")
	diaSource     = mustHex("f5a695b63ab16fd8278cb1cf7d29f274a9574b64e0b894750e08c990fc8891bc")
	diaScale      = new(big.Int).Exp(big.NewInt(10), big.NewInt(16), nil)
)

func diaOraclePk(priv *btcec.PrivateKey) []byte {
	return append([]byte{0x10}, priv.PubKey().SerializeCompressed()...)
}

func signDiaCents(priv *btcec.PrivateKey, cents, sampleTime, nonce, intentExpiry int64) (*big.Int, []byte) {
	rawPrice := new(big.Int).Mul(big.NewInt(cents), diaScale)
	body := make([]byte, 0, 320)
	for _, chunk := range [][]byte{
		diaTypehash,
		diaIntentType,
		diaVersion,
		wordBE32(big.NewInt(1050)),
		wordBE32(big.NewInt(nonce)),
		wordBE32(big.NewInt(intentExpiry)),
		diaSymbol,
		wordBE32(rawPrice),
		wordBE32(big.NewInt(sampleTime)),
		diaSource,
	} {
		body = append(body, chunk...)
	}
	digest := keccak256([]byte{0x19, 0x01}, diaDomain, keccak256(body))
	compact := ecdsa.SignCompact(priv, digest, true)
	return rawPrice, compact[1:]
}

func dummyOutPoint(tag byte, vout uint32) wire.OutPoint {
	var h chainhash.Hash
	h[0] = tag
	return wire.OutPoint{Hash: h, Index: vout}
}

package inventory

import "errors"

// ErrRegNotExist means a registry key (or value) does not exist.
var ErrRegNotExist = errors.New("registry key not found")

// RegNode is a read-only view of one registry key. The Windows implementation
// wraps golang.org/x/sys/windows/registry; tests use an in-memory tree.
type RegNode interface {
	// SubKeyNames lists the immediate subkeys.
	SubKeyNames() ([]string, error)
	// Open opens a subkey by relative path (backslash separated).
	Open(path string) (RegNode, error)
	// String reads a REG_SZ/REG_EXPAND_SZ value (expanded).
	String(name string) (string, bool)
	// DWord reads a REG_DWORD value.
	DWord(name string) (uint32, bool)
	Close()
}

// openAll opens each path in turn and returns the first that exists.
func openIf(n RegNode, path string) RegNode {
	sub, err := n.Open(path)
	if err != nil {
		return nil
	}
	return sub
}

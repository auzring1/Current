package e2e

import "runtime"

func runtimeOS() string   { return runtime.GOOS }
func runtimeArch() string { return runtime.GOARCH }

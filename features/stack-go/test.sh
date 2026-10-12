#!/usr/bin/env bash
set -euo pipefail

# Run the built image with --network=none; everything below must already be baked in.
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export HOME="$work/home"
mkdir -p "$HOME" "$work/demo" "$work/cgo"
test "${GOMODCACHE:?}" = /var/cache/nightshift-deps/go/mod
test "${GOCACHE:?}" = /var/cache/nightshift-deps/go/build
test "${GOTOOLCHAIN:?}" = local
test "${CGO_ENABLED:?}" = 1
test -w "$GOMODCACHE"
test -w "$GOCACHE"
test -z "${GOFLAGS:-}"
for tool in go gofmt gopls golangci-lint gcc; do
  command -v "$tool"
done
if command -v mise >/dev/null; then
  echo "mise must stay off PATH" >&2
  exit 1
fi

go_version="$(go env GOVERSION)"
go_version="${go_version#go}"

cat >"$work/demo/go.mod" <<MOD
module example.com/demo

go ${go_version%.*}
MOD
cat >"$work/demo/demo.go" <<'GO'
package demo

func Add(a, b int) int {
	return a + b
}
GO
cat >"$work/demo/demo_test.go" <<'GO'
package demo

import "testing"

func TestAdd(t *testing.T) {
	if Add(2, 3) != 5 {
		t.Fatal("Add(2, 3) != 5")
	}
}
GO

cat >"$work/cgo/go.mod" <<MOD
module example.com/cgo

go ${go_version%.*}
MOD
cat >"$work/cgo/cgo.go" <<'GO'
package cgo

// static int twice(int x) { return 2 * x; }
import "C"

func Twice(x int) int {
	return int(C.twice(C.int(x)))
}
GO
cat >"$work/cgo/cgo_test.go" <<'GO'
package cgo

import (
	"sync"
	"testing"
)

func TestTwice(t *testing.T) {
	var wg sync.WaitGroup
	for i := range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if Twice(i) != 2*i {
				t.Errorf("Twice(%d) != %d", i, 2*i)
			}
		}()
	}
	wg.Wait()
}
GO

lsp_initialize() {
  mkdir -p "$work/lsp"
  printf 'module example.com/lsp\n\ngo %s\n' "${go_version%.*}" >"$work/lsp/go.mod"
  cat >"$work/lsp/main.go" <<'GO'
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/textproto"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

type message struct {
	ID     *int            `json:"id"`
	Method string          `json:"method"`
	Result json.RawMessage `json:"result"`
	Error  json.RawMessage `json:"error"`
}

func main() {
	root, cmd := os.Args[1], os.Args[2:]
	name := strings.Join(cmd, " ")
	child := exec.Command(cmd[0], cmd[1:]...)
	child.Dir = root
	child.Stderr = os.Stderr
	stdin, _ := child.StdinPipe()
	stdout, _ := child.StdoutPipe()
	if err := child.Start(); err != nil {
		fail(name, err)
	}
	time.AfterFunc(30*time.Second, func() { child.Process.Kill(); fail(name, fmt.Errorf("LSP lifecycle timed out")) })
	reader := textproto.NewReader(bufio.NewReader(stdout))

	send := func(msg map[string]any) {
		msg["jsonrpc"] = "2.0"
		body, _ := json.Marshal(msg)
		fmt.Fprintf(stdin, "Content-Length: %d\r\n\r\n%s", len(body), body)
	}
	response := func(id int) message {
		for {
			headers, err := reader.ReadMIMEHeader()
			if err != nil {
				fail(name, fmt.Errorf("language server closed stdout before responding: %w", err))
			}
			length, _ := strconv.Atoi(headers.Get("Content-Length"))
			body := make([]byte, length)
			if _, err := io.ReadFull(reader.R, body); err != nil {
				fail(name, err)
			}
			var msg message
			if err := json.Unmarshal(body, &msg); err != nil {
				fail(name, err)
			}
			if msg.ID != nil && *msg.ID == id && msg.Method == "" {
				if len(msg.Error) > 0 {
					fail(name, fmt.Errorf("%s", msg.Error))
				}
				return msg
			}
		}
	}

	send(map[string]any{"id": 1, "method": "initialize", "params": map[string]any{
		"processId": nil, "rootUri": "file://" + root, "capabilities": map[string]any{}, "workspaceFolders": nil,
	}})
	var result struct{ Capabilities map[string]any }
	if json.Unmarshal(response(1).Result, &result) != nil || len(result.Capabilities) == 0 {
		fail(name, fmt.Errorf("missing LSP capabilities"))
	}
	fmt.Printf("%s: initialize ok\n", name)
	send(map[string]any{"method": "initialized", "params": map[string]any{}})
	send(map[string]any{"id": 2, "method": "shutdown"})
	response(2)
	send(map[string]any{"method": "exit"})
	stdin.Close()
	child.Wait()
}

func fail(name string, err error) {
	fmt.Fprintf(os.Stderr, "%s: %v\n", name, err)
	os.Exit(1)
}
GO
  (cd "$work/lsp" && go run . "$work/demo" "$@")
}

go version
gopls version
golangci-lint version
gcc --version | head -1

(cd "$work/demo" && go build ./... && go vet ./... && go test ./...)
(cd "$work/demo" && test -z "$(gofmt -l .)")
(cd "$work/demo" && golangci-lint run)
(cd "$work/cgo" && go build ./... && go test -race ./...)

cat >"$work/demo/bad.go" <<'GO'
package demo

func unused() int {
	x := 1
	return 2
}
GO
if (cd "$work/demo" && golangci-lint run >"$work/lint.txt" 2>&1); then
  echo "golangci-lint run passed a file with an unused variable" >&2
  exit 1
fi
cat "$work/lint.txt"
grep -q 'declared and not used' "$work/lint.txt"
rm "$work/demo/bad.go"

printf 'module example.com/newer\n\ngo 1.999\n' >"$work/demo/go.mod"
if (cd "$work/demo" && go build ./... 2>"$work/toolchain.txt"); then
  echo "go built a module requiring a newer Go than the installed one" >&2
  exit 1
fi
grep -q 'GOTOOLCHAIN=local' "$work/toolchain.txt"

lsp_initialize gopls

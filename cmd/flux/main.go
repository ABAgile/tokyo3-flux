package main

import (
	"fmt"
	"io"
	"net"
	"os"
	"strings"

	basecrypto "github.com/abagile/tokyo3-base/crypto"
	baseversion "github.com/abagile/tokyo3-base/version"
)

var Version = "dev"

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "flux:", err)
		os.Exit(1)
	}
}
func run(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		printUsage(stdout)
		return nil
	}
	switch args[0] {
	case "serve", "migrate", "bootstrap", "member", "seed", "prune", "cleanup":
		return runPlan(args, stdout, stderr)
	case "read":
		return runRead(args[1:], stdout, stderr)
	case "import":
		return runImport(args[1:], stdout, stderr)
	case "version":
		_, err := fmt.Fprintf(stdout, "flux %s\n", baseversion.Resolve(Version))
		return err
	case "help", "-h", "--help":
		printUsage(stdout)
		return nil
	default:
		return fmt.Errorf("unknown command %q; Flux is native-only (see flux help)", args[0])
	}
}
func printUsage(w io.Writer) {
	fmt.Fprintln(w, `Flux — native planning

flux serve [--addr ADDR] [--demo]
flux migrate
flux bootstrap --subject ID [--name NAME] [--project NAME]
flux member --workspace ID --subject ID [--role viewer|member|admin]
flux seed --workspace ID --subject ID [--project ID]
flux prune [--days N]
flux cleanup
flux read --workspace ID --view board|item|triage|sprints|review|failures|links|catalog|imports|history [--target ID --offset N --revision N --limit N]
flux import --workspace ID --input snapshot.json --mapping mapping.json (dry run only)
flux version

Browser membership, CSRF, revision checks and human approval are required for planning writes. Machine credentials are read-only.`)
}
func envOrDefault(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
func serveSessionKey(raw string, demo bool) ([]byte, error) {
	if strings.TrimSpace(raw) == "" && demo {
		return basecrypto.RandomBytes(32)
	}
	return basecrypto.ParseKEK(strings.TrimSpace(raw))
}
func isLoopbackAddress(addr string) bool {
	host, _, err := net.SplitHostPort(strings.TrimSpace(addr))
	if err != nil {
		return false
	}
	host = strings.Trim(host, "[]")
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

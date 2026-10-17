#!/usr/bin/env bash
# CI on Linux: downloads Zotero and Better BibTeX (cached), unpacks Zotero and runs the
# end-to-end suite headless under Xvfb. Needs: curl, xz, python3, xvfb-run and Zotero's
# GTK libraries (see .github/workflows/ci.yml).
#
#   ZOTERO_VERSION   e.g. 10.0.6        [required]
#   BBT_VERSION      e.g. 9.0.71        [required]
#   CI_CACHE         download cache     (default ~/zmcp-ci-cache)
#   CI_WORK          scratch directory  (default $RUNNER_TEMP/zmcp-ci or /tmp/zmcp-ci)
#   NO_NETWORK=1     skip the tests that need online lookups
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${ZOTERO_VERSION:?set ZOTERO_VERSION}"
: "${BBT_VERSION:?set BBT_VERSION}"
CACHE="${CI_CACHE:-$HOME/zmcp-ci-cache}"
WORK="${CI_WORK:-${RUNNER_TEMP:-/tmp}/zmcp-ci}"

case "$(uname -m)" in
	x86_64) PLATFORM=linux-x86_64 ;;
	aarch64 | arm64) PLATFORM=linux-arm64 ;;
	*) echo "Unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

download() {
	local url="$1" target="$2"
	if [[ ! -s "$target" ]]; then
		echo "Downloading $url"
		curl -fsSL --retry 3 -o "$target.part" "$url"
		mv "$target.part" "$target"
	fi
}

mkdir -p "$CACHE" "$WORK"
TARBALL="$CACHE/Zotero-${ZOTERO_VERSION}_${PLATFORM}.tar.xz"
BBT_XPI="$CACHE/zotero-better-bibtex-${BBT_VERSION}.xpi"
download "https://www.zotero.org/download/client/dl?channel=release&platform=${PLATFORM}&version=${ZOTERO_VERSION}" "$TARBALL"
download "https://github.com/retorquere/zotero-better-bibtex/releases/download/v${BBT_VERSION}/zotero-better-bibtex-${BBT_VERSION}.xpi" "$BBT_XPI"

rm -rf "$WORK/zotero"
mkdir -p "$WORK/zotero"
tar -xJf "$TARBALL" -C "$WORK/zotero"
ZOTERO_APP="$(find "$WORK/zotero" -mindepth 1 -maxdepth 1 -type d | head -1)"

export ZOTERO_APP BBT_XPI TEST_BASE="$WORK/test"
exec xvfb-run -a -s "-screen 0 1600x1200x24" "$ROOT/tests/run-tests.sh"

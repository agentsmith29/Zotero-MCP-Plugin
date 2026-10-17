#!/usr/bin/env bash
# Runs the end-to-end suite against an isolated Zotero 10 (never your own profile or library).
#
#   ZOTERO_APP=/path/to/Zotero.app TEST_BASE=/tmp/zmcp-test BBT_XPI=/path/to/better-bibtex.xpi tests/run-tests.sh
#
# Set NO_NETWORK=1 to skip the online lookup tests, KEEP_RUNNING=1 to leave Zotero open afterwards.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${ZOTERO_APP:?set ZOTERO_APP}"
: "${TEST_BASE:?set TEST_BASE}"
export TEST_BASE TEST_OUT="${TEST_OUT:-$TEST_BASE/out}"

"$HERE/zotero-test-env.sh" reset
"$HERE/zotero-test-env.sh" start
if [[ -n "${BBT_XPI:-}" ]]; then
	# Better BibTeX starts after Zotero's server; wait until its JSON-RPC answers
	for _ in $(seq 1 120); do
		if curl -s -m 5 -X POST "http://127.0.0.1:${TEST_PORT:-23129}/better-bibtex/json-rpc" \
				-H "Content-Type: application/json" -H "Zotero-Allowed-Request: 1" \
				-d '{"jsonrpc":"2.0","method":"api.ready","id":1}' | grep -q '"betterbibtex"'; then
			echo "Better BibTeX is ready"
			break
		fi
		sleep 2
	done
fi
sleep 3
cd "$HERE"
status=0
python3 -W ignore -m unittest -v test_m1_transport test_m2_read test_m3_export test_m4_write test_m5_lookup test_m6_destructive || status=$?
if [[ -z "${KEEP_RUNNING:-}" ]]; then
	"$HERE/zotero-test-env.sh" stop
fi
exit $status

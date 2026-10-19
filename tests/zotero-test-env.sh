#!/usr/bin/env bash
# Starts an isolated Zotero for end-to-end tests: its own profile, data directory and
# HTTP port, with this plugin (from source), the test helper and optionally Better BibTeX.
# Your normal Zotero profile and library are never touched.
#
# Usage: tests/zotero-test-env.sh start|stop|reset  (environment variables below)
#   ZOTERO_APP   path to Zotero.app (macOS) or the unpacked Linux tarball  [required]
#   TEST_BASE    directory for profile, data and log                  [required]
#   BBT_XPI      path to a Better BibTeX .xpi to install                [optional]
#   PLUGIN_XPI   install this built XPI instead of loading the source   [optional]
#   INSECURE_UPDATES=1  allow http update URLs (update-flow test only)
#   TEST_PORT    HTTP port (default 23129)
#   TEST_TOKEN   MCP token (default: test-token-0123456789abcdef)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${ZOTERO_APP:?set ZOTERO_APP}"
: "${TEST_BASE:?set TEST_BASE}"
TEST_PORT="${TEST_PORT:-23129}"
TEST_TOKEN="${TEST_TOKEN:-test-token-0123456789abcdef}"
PROFILE="$TEST_BASE/profile"
DATA="$TEST_BASE/data"
LOG="$TEST_BASE/zotero.log"
PIDFILE="$TEST_BASE/zotero.pid"

if [[ -x "$ZOTERO_APP/Contents/MacOS/zotero" ]]; then
	# macOS app bundle
	LAUNCH=("$ZOTERO_APP/Contents/MacOS/zotero")
elif [[ -x "$ZOTERO_APP/zotero-bin" ]]; then
	# Linux tarball: start zotero-bin directly (the zotero wrapper script would keep it as a
	# child process, so stopping by PID would leave Zotero running); mirror the wrapper's settings
	ulimit -n 4096 || true
	export MOZ_ALLOW_DOWNGRADE=1 MOZ_LEGACY_PROFILES=1
	LAUNCH=("$ZOTERO_APP/zotero-bin" -app "$ZOTERO_APP/app/application.ini")
else
	LAUNCH=("$ZOTERO_APP/zotero")
fi

stop() {
	if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
		kill "$(cat "$PIDFILE")" || true
		for _ in $(seq 1 40); do
			kill -0 "$(cat "$PIDFILE")" 2>/dev/null || break
			sleep 0.5
		done
	fi
	rm -f "$PIDFILE"
}

setup_profile() {
	mkdir -p "$PROFILE/extensions" "$DATA"
	if [[ -n "${PLUGIN_XPI:-}" ]]; then
		rm -f "$PROFILE/extensions/zotero-mcp@agentsmith29.github.io"
		cp "$PLUGIN_XPI" "$PROFILE/extensions/zotero-mcp@agentsmith29.github.io.xpi"
	else
		rm -f "$PROFILE/extensions/zotero-mcp@agentsmith29.github.io.xpi"
		printf '%s' "$ROOT" > "$PROFILE/extensions/zotero-mcp@agentsmith29.github.io"
	fi
	printf '%s' "$ROOT/tests/helper-plugin" > "$PROFILE/extensions/zotero-mcp-test-helper@agentsmith29.github.io"
	if [[ -n "${BBT_XPI:-}" ]]; then
		cp "$BBT_XPI" "$PROFILE/extensions/better-bibtex@iris-advies.com.xpi"
	fi
	cat > "$PROFILE/user.js" <<PREFS
user_pref("extensions.zotero.dataDir", "$DATA");
user_pref("extensions.zotero.useDataDir", true);
user_pref("extensions.zotero.httpServer.port", $TEST_PORT);
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
user_pref("extensions.update.enabled", false);
user_pref("app.update.enabled", false);
user_pref("app.update.auto", false);
user_pref("extensions.zotero.sync.autoSync", false);
user_pref("extensions.zotero.zoteromcp.token", "$TEST_TOKEN");
user_pref("extensions.zotero.zoteromcp.notices.bbtMissing", false);
user_pref("extensions.zotero.zoteromcp.notices.bbtSettings", false);
PREFS
	if [[ -n "${INSECURE_UPDATES:-}" ]]; then
		# Lets the update-flow test use a plain-http stand-in for GitHub releases
		echo 'user_pref("extensions.checkUpdateSecurity", false);' >> "$PROFILE/user.js"
	fi
	# Force a rescan of the extensions directory
	if [[ -f "$PROFILE/prefs.js" ]]; then
		sed -i.bak -e '/extensions.lastAppBuildId/d' -e '/extensions.lastAppVersion/d' "$PROFILE/prefs.js"
		rm -f "$PROFILE/prefs.js.bak"
	fi
}

start() {
	stop
	setup_profile
	"${LAUNCH[@]}" -profile "$PROFILE" -datadir "$DATA" -no-remote -ZoteroDebugText > "$LOG" 2>&1 &
	echo $! > "$PIDFILE"
	for _ in $(seq 1 120); do
		if curl -s -m 2 "http://127.0.0.1:$TEST_PORT/connector/ping" >/dev/null 2>&1; then
			echo "Zotero test instance up on port $TEST_PORT (pid $(cat "$PIDFILE"), log $LOG)"
			return 0
		fi
		sleep 1
	done
	echo "Zotero test instance did not come up; see $LOG" >&2
	return 1
}

case "${1:-}" in
	start) start ;;
	stop) stop ;;
	reset) stop; rm -rf "$PROFILE" "$DATA" "$LOG" ;;
	*) echo "usage: $0 start|stop|reset" >&2; exit 2 ;;
esac

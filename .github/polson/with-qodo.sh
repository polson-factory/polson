#!/usr/bin/env bash
# Runs one command with Qodo's CLI available, then deletes the CLI and its home.
# The wait steps in polson-agent.yml use it so wait-for-pr.sh can read Qodo's own
# review record (issue #26: Qodo's comment cannot tell a skipped review from a
# real one).
#
# Usage: bash with-qodo.sh <command> [args...]
# Needs, from the workflow:
#   QODO_INSTALLER_URL, QODO_INSTALLER_SHA256, QODO_CLI_VERSION  the pinned installer
#   QODO_API_KEY, QODO_BASE_URL  the CLI's sign-in (set only on the wait steps)
#   RUNNER_TEMP                  QODO_HOME is created under it
#
# The installer is checked against its pinned SHA-256 before it runs, and it
# checks the CLI it downloads against the SHA-256 in Qodo's version.json.
# QODO_HOME/bin goes on PATH before the installer runs, so the installer links
# nothing into other directories and edits no shell profile. With QODO_API_KEY
# and QODO_BASE_URL set, the CLI reads the key from the environment and stores
# nothing. QODO_HOME is deleted when this script exits, success or failure.
# A failed install fails the step, and the workflow hands the issue to a person.
set -euo pipefail

: "${QODO_INSTALLER_URL:?QODO_INSTALLER_URL must be set}"
: "${QODO_INSTALLER_SHA256:?QODO_INSTALLER_SHA256 must be set}"
: "${QODO_CLI_VERSION:?QODO_CLI_VERSION must be set}"
: "${RUNNER_TEMP:?RUNNER_TEMP must be set}"
if [ "$#" -eq 0 ]; then
  echo "Usage: bash with-qodo.sh <command> [args...]" >&2
  exit 2
fi

started=$(date +%s)
QODO_HOME=$(mktemp -d "$RUNNER_TEMP/qodo-home.XXXXXX")
export QODO_HOME
trap 'rm -rf "$QODO_HOME"' EXIT

# No background updates, no keychain: this CLI lives for one step.
export QODO_DISABLE_AUTOUPDATE=1 QODO_DISABLE_SKILLS_AUTOUPDATE=1 QODO_NO_KEYCHAIN=1
export PATH="$QODO_HOME/bin:$PATH"

installer="$QODO_HOME/install.sh"
curl --fail --silent --show-error --location --max-time 60 -o "$installer" "$QODO_INSTALLER_URL"
got=$(sha256sum "$installer" | cut -d' ' -f1)
if [ "$got" != "$QODO_INSTALLER_SHA256" ]; then
  echo "::error::Qodo installer SHA-256 mismatch: want $QODO_INSTALLER_SHA256, got $got. Not running it." >&2
  exit 1
fi
if ! timeout 120 sh "$installer" --version "$QODO_CLI_VERSION" </dev/null >"$QODO_HOME/install.log" 2>&1; then
  echo "::error::The Qodo CLI install failed:" >&2
  cat "$QODO_HOME/install.log" >&2
  exit 1
fi
installed=$(qodo --version)
if [ "$installed" != "$QODO_CLI_VERSION" ]; then
  echo "::error::Installed Qodo CLI $installed, expected $QODO_CLI_VERSION." >&2
  exit 1
fi
echo "Qodo CLI $installed is ready in a temporary QODO_HOME."

# The install ran inside the step's time limit, so the wait gets what is left of
# its budget (wait-for-pr.sh's TIMEOUT_SECONDS, default 900), not a fresh one, and
# reaches its own deadline and escalation before the step's limit.
left=$(( ${TIMEOUT_SECONDS:-900} - ($(date +%s) - started) ))
[ "$left" -gt 0 ] || left=0
export TIMEOUT_SECONDS="$left"

"$@"

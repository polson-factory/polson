#!/usr/bin/env bash
# Installs the pinned Qodo CLI for the verify-qodo job in polson-agent.yml
# (issue #26).
#
# Usage: bash qodo-cli.sh install
# Needs QODO_HOME (a new directory under runner.temp; the job deletes it at the
# end), QODO_INSTALLER_URL, QODO_INSTALLER_SHA256 and QODO_CLI_VERSION.
#
# The installer is Qodo's published, immutable installer script, checked against
# its pinned SHA-256 before it runs. It checks the CLI it downloads against the
# SHA-256 in Qodo's version.json.
#
# curl, the installer and the CLI's version check run with an allowlist of
# environment variables: PATH, HOME, QODO_HOME and the flags in clean_env. They
# never receive GH_TOKEN, GITHUB_TOKEN, the ACTIONS_* token variables or the Qodo
# key (the installer does not need it). QODO_HOME/bin is on PATH before the
# installer runs, so it links nothing into other directories and edits no shell
# profile.
set -euo pipefail

if [ "${1:-}" != install ]; then
  echo "Usage: bash qodo-cli.sh install" >&2
  exit 2
fi
: "${QODO_HOME:?QODO_HOME must be set}"
: "${QODO_INSTALLER_URL:?QODO_INSTALLER_URL must be set}"
: "${QODO_INSTALLER_SHA256:?QODO_INSTALLER_SHA256 must be set}"
: "${QODO_CLI_VERSION:?QODO_CLI_VERSION must be set}"
: "${HOME:?HOME must be set}"
if ! [[ "$QODO_CLI_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "::error::QODO_CLI_VERSION must be a release version like 2.4.0, got: $QODO_CLI_VERSION" >&2
  exit 2
fi

mkdir -p "$QODO_HOME"
path="$QODO_HOME/bin:$PATH"

# Runs a command with only the variables the installer and CLI need.
clean_env() {
  env -i PATH="$path" HOME="$HOME" QODO_HOME="$QODO_HOME" \
    QODO_DISABLE_AUTOUPDATE=1 QODO_DISABLE_SKILLS_AUTOUPDATE=1 QODO_NO_KEYCHAIN=1 CI=true \
    "$@"
}

installer="$QODO_HOME/install.sh"
clean_env curl --fail --silent --show-error --location --max-time 60 -o "$installer" "$QODO_INSTALLER_URL"
got=$(sha256sum "$installer" | cut -d' ' -f1)
if [ "$got" != "$QODO_INSTALLER_SHA256" ]; then
  echo "::error::Qodo installer SHA-256 mismatch: want $QODO_INSTALLER_SHA256, got $got. Not running it." >&2
  rm -f "$installer"
  exit 1
fi
if ! clean_env timeout 120 sh "$installer" --version "$QODO_CLI_VERSION" </dev/null >"$QODO_HOME/install.log" 2>&1; then
  echo "::error::The Qodo CLI install failed:" >&2
  cat "$QODO_HOME/install.log" >&2
  exit 1
fi
installed=$(clean_env qodo --version)
if [ "$installed" != "$QODO_CLI_VERSION" ]; then
  echo "::error::Installed Qodo CLI $installed, expected $QODO_CLI_VERSION." >&2
  exit 1
fi
echo "Qodo CLI $installed is installed in QODO_HOME."

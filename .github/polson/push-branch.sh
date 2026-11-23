#!/usr/bin/env bash
# Pushes the current branch for Polson's agent. The agent may run only
# `bash <runner.temp>/polson/push-branch.sh <issue>`, the workflow's copy of this
# file from the default branch, with its own issue number, so it never chooses
# the destination: this script pushes the current branch to the
# branch of the same name, and only if that name is a ticket branch for <issue>.
set -euo pipefail

issue="${1:-}"
if ! [[ "$issue" =~ ^[1-9][0-9]{0,9}$ ]]; then
  echo "Usage: bash push-branch.sh <issue-number>" >&2
  exit 2
fi

branch=$(git symbolic-ref --quiet --short HEAD) || {
  echo "Not on a branch (detached HEAD). Check out your ticket branch first." >&2
  exit 1
}

if ! [[ "$branch" =~ ^${issue}-[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
  echo "Refusing to push '$branch': the branch must be named ${issue}-<short-slug> (lowercase words joined by hyphens)." >&2
  exit 1
fi

# The agents may never change anything under .github/ (the workflow, its scripts
# and prompts). Their tool rules deny Edit and Write there, but the builder can
# run `git rm` and `git mv`, so check what is actually pushed: every path the
# branch adds, modifies, deletes or renames, compared with where it left the
# default branch (the merge base, so later changes on the default branch do not
# count). Anything that cannot be read stops the push (AGENTS.md rule 6).
refuse() {
  echo "Refusing to push '$branch': $1" >&2
  exit 1
}
symref=$(git ls-remote --symref origin HEAD) || refuse "could not read the default branch of origin."
default=$(awk '$1 == "ref:" && $3 == "HEAD" { sub("^refs/heads/", "", $2); print $2; exit }' <<<"$symref")
[[ "$default" =~ ^[A-Za-z0-9._/-]+$ ]] || refuse "could not read the default branch of origin."
git fetch --quiet --no-tags origin "+refs/heads/${default}:refs/remotes/origin/${default}" \
  || refuse "could not fetch the default branch ${default}."
if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
  git fetch --quiet --no-tags --unshallow origin || refuse "could not fetch the history needed to compare with ${default}."
fi
base=$(git merge-base "refs/remotes/origin/${default}" HEAD) \
  || refuse "it has no common history with ${default}."
changes=$(mktemp)
trap 'rm -f "$changes"' EXIT
# -z: paths exactly as stored, never quoted. --no-renames: a rename is listed as
# its old path (deleted) and its new path (added), so both are checked.
git diff --no-renames --name-only -z "$base" HEAD >"$changes" || refuse "could not list its changes against ${default}."
protected=()
while IFS= read -r -d '' path; do
  case "$path" in .github/*) protected+=("$path") ;; esac
done <"$changes"
if [ "${#protected[@]}" -gt 0 ]; then
  refuse "it changes files under .github/, which the agent may never change: $(printf '%s, ' "${protected[@]}" | sed 's/, $//'). Escalate on the issue instead."
fi

git push --set-upstream origin "refs/heads/${branch}:refs/heads/${branch}"

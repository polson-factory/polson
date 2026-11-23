#!/usr/bin/env bash
# Reads the body of Qodo's "Code Review by Qodo" comment on stdin and prints how
# many High or Medium findings it still lists as open, or "unknown" if the
# comment cannot be read with confidence.
#
# Three rules keep it from guessing (AGENTS.md rule 6):
#   1. Structure is matched only at the start of a line. Each finding quotes its
#      description and code on lines starting with ">", and that text can contain
#      any marker below. On PR #24 quoted "Resolved findings" and "<summary>  1."
#      text made this script misread a real review.
#   2. The comment must end with Qodo's footer (the qodo.ai logo link). Without
#      it the comment may be cut short, and a cut comment can still show count
#      badges that match the findings it lists.
#   3. Every open finding needs a severity label. A severity badge (an
#      img.shields.io "High-...", "Medium-..." or "Low-..." image) labels the next
#      finding only. Qodo's "View high/medium/low (N)" header labels the next N
#      findings, its group: PR #40 lists three Low findings under one "View low
#      (3)" header and one badge, and PR #24 labels its second finding with only a
#      "View medium (1)" header. A group with fewer or more findings than its N, a
#      badge in a group that disagrees with its header, a finding with no label,
#      or a label this script does not know makes the whole result unknown. A
#      finding never takes the previous finding's severity outside its group.
#
# Each finding is listed as `<summary>  N.  Title ...`. Fixed findings carry
# "✓ Resolved", and findings a person dismissed carry "✗ Dismissed"; neither
# counts as open.
#
# Qodo also shows the open findings by category, as count badges such as
# `<code>🐞 Bugs (1)</code>`, `<code>📘 Rule violations (0)</code>` and
# `<code>📎 Requirement gaps (0)</code>`. When nothing is open it either shows
# zero counts ("Great, no issues found!") or drops the counts and lists only
# "Resolved findings" (seen on PRs 1, 6, 7, 8 and 10).
#
# The review is readable only if:
#   - it is a Qodo review that ends with Qodo's footer,
#   - every open finding has a known severity label, every group holds exactly
#     the number of findings its header says, and
#   - with count badges, they add up to the number of open findings found;
#     without them, nothing is open and the comment says so ("Resolved findings"
#     or "no issues found").
# Anything else prints "unknown".
set -euo pipefail

awk '
  BEGIN { seen_review = 0; footer = 0; resolved_section = 0; label = ""
          open_hm = 0; open_all = 0; unknown = 0
          counts = 0; count_sum = 0; closed_section = 0
          group_sev = ""; group_left = 0; in_group = 0; group_depth = 0; depth = 0 }
  /^[[:space:]]*<h3>Code Review by Qodo<\/h3>/ { seen_review = 1 }

  # A group is open from its header to the </details> that closes the header'"'"'s
  # <details>. Only <details> tags at the start of a line count: the ones inside a
  # finding are quoted (">"). This rule runs before the header rule below, so a
  # group'"'"'s depth includes its own <details>.
  /^<details/ { depth++ }
  /^<\/details>/ { if (in_group && depth == group_depth) end_group(); depth-- }

  # A group still owed findings when it closes, or when another group, the resolved
  # section or the end of the comment begins, has fewer findings than its header
  # said.
  function end_group() {
    if (group_left > 0) unknown++
    in_group = 0; group_sev = ""; group_left = 0
  }
  /^<details><summary><strong>Resolved findings<\/strong>/ { end_group(); resolved_section = 1; closed_section = 1 }
  /^<h3>Great, no issues found!<\/h3>/ { closed_section = 1 }
  /^<a href="https:\/\/www\.qodo\.ai"><img src="https:\/\/www\.qodo\.ai\/wp-content\/uploads\/[0-9\/]+qodo-logo\.svg"/ { footer = 1 }

  # A severity label applies to the next finding only. Two labels that disagree,
  # or a label this script does not know, leave that finding unlabelled ("?").
  function set_label(sev) { label = (label == "" || label == sev) ? sev : "?" }
  /^<img src="https:\/\/img\.shields\.io\/badge\// {
    if ($0 ~ /^<img src="https:\/\/img\.shields\.io\/badge\/High-/) set_label("High")
    else if ($0 ~ /^<img src="https:\/\/img\.shields\.io\/badge\/Medium-/) set_label("Medium")
    else if ($0 ~ /^<img src="https:\/\/img\.shields\.io\/badge\/Low-/) set_label("Low")
    else set_label("?")
  }
  # "View <severity> (N)" starts a group that labels the next N findings. A header
  # without a count of at least 1, or with a severity this script does not know,
  # leaves the next finding unlabelled.
  /^<details><summary><ins><strong>View / {
    end_group()
    if (match($0, /<strong>View (high|medium|low) \([1-9][0-9]*\)<\/strong>/)) {
      header = substr($0, RSTART, RLENGTH)
      match(header, /\([0-9]+\)/)
      group_left = substr(header, RSTART + 1, RLENGTH - 2) + 0
      in_group = 1; group_depth = depth
      if (header ~ /View high/) group_sev = "High"
      else if (header ~ /View medium/) group_sev = "Medium"
      else group_sev = "Low"
    } else set_label("?")
  }

  /^<code>/ {
    line = $0
    while (match(line, /<code>[^<]*(Bugs|Rule violations|Requirement gaps) \([0-9]+\)<\/code>/)) {
      badge = substr(line, RSTART, RLENGTH)
      line = substr(line, RSTART + RLENGTH)
      match(badge, /\([0-9]+\)/)
      counts++
      count_sum += substr(badge, RSTART + 1, RLENGTH - 2)
    }
  }

  /^<summary>[[:space:]]+[0-9]+\.[[:space:]]/ {
    # In a group, the header gives the severity, and a badge must agree with it. A
    # finding past the header'"'"'s N, still inside the group, is unknown, badge or not
    # (Qodo on PR #42), and so is a resolved or dismissed one.
    if (in_group && group_left == 0) { unknown++; label = ""; next }
    if (in_group) {
      sev = (label == "" || label == group_sev) ? group_sev : "?"
      group_left--
    } else sev = label
    label = ""
    if ($0 ~ /✓ Resolved/ || $0 ~ /✗ Dismissed/) next
    if (resolved_section) unknown++
    else if (sev == "High" || sev == "Medium") { open_hm++; open_all++ }
    else if (sev == "Low") open_all++
    else unknown++
  }

  END {
    end_group()
    readable = seen_review && footer && unknown == 0
    if (counts > 0) readable = readable && count_sum == open_all
    else readable = readable && open_all == 0 && closed_section
    if (readable) print open_hm
    else print "unknown"
  }
'

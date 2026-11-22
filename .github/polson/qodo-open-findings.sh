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
#   3. Every open finding needs its own severity label between the previous
#      finding and itself: a severity badge (an img.shields.io "High-...",
#      "Medium-..." or "Low-..." image) or Qodo's "View high/medium/low (N)"
#      header (PR #24 labels its second finding with only that header). A finding
#      with no label, or with a label this script does not know, makes the whole
#      result unknown. It never takes the previous finding's severity.
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
#   - every open finding has its own known severity label, and
#   - with count badges, they add up to the number of open findings found;
#     without them, nothing is open and the comment says so ("Resolved findings"
#     or "no issues found").
# Anything else prints "unknown".
set -euo pipefail

awk '
  BEGIN { seen_review = 0; footer = 0; resolved_section = 0; label = ""
          open_hm = 0; open_all = 0; unknown = 0
          counts = 0; count_sum = 0; closed_section = 0 }
  /^[[:space:]]*<h3>Code Review by Qodo<\/h3>/ { seen_review = 1 }
  /^<details><summary><strong>Resolved findings<\/strong>/ { resolved_section = 1; closed_section = 1 }
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
  /^<details><summary><ins><strong>View / {
    if ($0 ~ /<strong>View high \(/) set_label("High")
    else if ($0 ~ /<strong>View medium \(/) set_label("Medium")
    else if ($0 ~ /<strong>View low \(/) set_label("Low")
    else set_label("?")
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
    sev = label; label = ""
    if ($0 ~ /✓ Resolved/ || $0 ~ /✗ Dismissed/) next
    if (resolved_section) unknown++
    else if (sev == "High" || sev == "Medium") { open_hm++; open_all++ }
    else if (sev == "Low") open_all++
    else unknown++
  }

  END {
    readable = seen_review && footer && unknown == 0
    if (counts > 0) readable = readable && count_sum == open_all
    else readable = readable && open_all == 0 && closed_section
    if (readable) print open_hm
    else print "unknown"
  }
'

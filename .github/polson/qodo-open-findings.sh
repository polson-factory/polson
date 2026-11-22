#!/usr/bin/env bash
# Reads the body of Qodo's "Code Review by Qodo" comment on stdin and prints how
# many High or Medium findings it still lists as open, or "unknown" if the
# comment cannot be read with confidence.
#
# Qodo groups open findings under a severity badge (an img.shields.io "High-...",
# "Medium-..." or "Low-..." image) and lists each one as `<summary>  N.  Title ...`.
# Fixed findings carry "✓ Resolved", and findings a person dismissed carry
# "✗ Dismissed"; neither counts as open.
#
# Qodo also shows the open findings by category, as count badges such as
# `<code>🐞 Bugs (1)</code>`, `<code>📘 Rule violations (0)</code>` and
# `<code>📎 Requirement gaps (0)</code>`. When nothing is open it either shows
# zero counts ("Great, no issues found!") or drops the counts and lists only
# "Resolved findings" (seen on PRs 1, 6, 7, 8 and 10).
#
# The review is readable only if:
#   - it is a Qodo review,
#   - every open finding sits under a severity badge, and
#   - with count badges, they add up to the number of open findings found;
#     without them, nothing is open and the comment says so ("Resolved findings"
#     or "no issues found").
# Anything else prints "unknown".
set -euo pipefail

awk '
  BEGIN { seen_review = 0; sev = ""; open_hm = 0; open_all = 0; unknown = 0
          counts = 0; count_sum = 0; closed_section = 0 }
  /Code Review by Qodo/ { seen_review = 1 }
  /Resolved findings/ { sev = "resolved"; closed_section = 1 }
  /no issues found/ { closed_section = 1 }
  /img\.shields\.io\/badge\/High-/   { sev = "High" }
  /img\.shields\.io\/badge\/Medium-/ { sev = "Medium" }
  /img\.shields\.io\/badge\/Low-/    { sev = "Low" }
  {
    line = $0
    while (match(line, /<code>[^<]*(Bugs|Rule violations|Requirement gaps) \([0-9]+\)<\/code>/)) {
      badge = substr(line, RSTART, RLENGTH)
      line = substr(line, RSTART + RLENGTH)
      match(badge, /\([0-9]+\)/)
      counts++
      count_sum += substr(badge, RSTART + 1, RLENGTH - 2)
    }
  }
  /<summary>[[:space:]]+[0-9]+\.[[:space:]]/ {
    if ($0 ~ /✓ Resolved/ || $0 ~ /✗ Dismissed/) next
    if (sev == "High" || sev == "Medium") { open_hm++; open_all++ }
    else if (sev == "Low") open_all++
    else unknown++
  }
  END {
    readable = seen_review && unknown == 0
    if (counts > 0) readable = readable && count_sum == open_all
    else readable = readable && open_all == 0 && closed_section
    if (readable) print open_hm
    else print "unknown"
  }
'

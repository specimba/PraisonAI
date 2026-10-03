#!/usr/bin/env bash
# r216: replayable browser QA for the r212 pulse attention deep-links — the
# two same-panel scroll branches that were the last unverified click paths.
#
#   Phase A (breaker): plant an enabled:false + failStreak:3 registry row →
#     the pulse's "Needs attention" cell shows the parked count → click →
#     assert the workflows view's "Lane degraded" strip (#breaker-paused-strip)
#     scrolled into view.
#   Phase B (stale): flip the row to enabled:true + nextRunAt 25h old →
#     stale becomes the first offender (priority order) → click → assert this
#     panel's amber strip (#automation-stale-strip) scrolled into view.
#   Cleanup: delete the fixture row.
#
# The lane-blocked branch rides the r134 vault deep-link — the same
# setSettingsAnchor machinery the r213 badge QA already proved.
set -uo pipefail
PASS=0; FAIL=0
step() {
  local name="$1" out="$2"
  if [[ "$out" == *"NOT-FOUND"* || "$out" == *"MISSING"* || "$out" == "NO-STRIP" || "$out" == *"ERROR"* ]]; then
    echo "FAIL $name: $out"; FAIL=$((FAIL+1)); return 1
  fi
  echo "PASS $name: $out"; PASS=$((PASS+1)); return 0
}
assert_visible() { # assert_visible <name> <element-id>
  local out
  out=$(agent-browser eval "(()=>{const s=document.getElementById('$2');if(!s)return 'NO-STRIP';const r=s.getBoundingClientRect();return '$2 top='+Math.round(r.top)+' visible='+(r.top<window.innerHeight&&r.bottom>0&&r.height>0);})()" | tail -1)
  if echo "$out" | grep -q "visible=true"; then step "$1" "$out"; else echo "FAIL $1: $out"; FAIL=$((FAIL+1)); fi
}
click_attention() {
  agent-browser eval "(()=>{const b=document.querySelector('button[aria-label^=\"Needs attention\"]');if(!b)return 'ATTENTION-MISSING';b.click();return 'ATTENTION-CLICKED:'+b.getAttribute('aria-label');})()" | tail -1
}

# ── Phase A: breaker-parked branch ──────────────────────────────────────────
bun scripts/qa-attention-fixture.ts plant-breaker || { echo "FAIL fixture-plant"; exit 1; }
agent-browser set viewport 1440 900
agent-browser open http://localhost:3000
agent-browser wait --load networkidle
agent-browser wait 2000
NAV=$(agent-browser eval "(()=>{const c=[...document.querySelectorAll('a,button,[role=\"tab\"],[role=\"menuitem\"],nav button,aside button')].filter(e=>/workflow/i.test(e.textContent||'')&&e.offsetParent!==null);if(!c.length)return 'NAV-NOT-FOUND';c[0].click();return 'NAV-CLICKED';})()" | tail -1)
step "nav-workflows" "$NAV"
agent-browser wait 2500   # let the autopilot's sync GET land
ATT_A=$(click_attention)
step "attention-click-breaker" "$ATT_A"
agent-browser wait 1500
agent-browser screenshot download/r216-01-breaker.png 2>/dev/null
assert_visible "parked-strip-scrolled" "automation-parked-strip"

# ── Phase B: stale branch (priority first offender) ─────────────────────────
bun scripts/qa-attention-fixture.ts plant-stale
agent-browser reload
agent-browser wait --load networkidle
agent-browser wait 2500
ATT_B=$(click_attention)
step "attention-click-stale" "$ATT_B"
agent-browser wait 1500
agent-browser screenshot download/r216-02-stale.png 2>/dev/null
assert_visible "stale-strip-scrolled" "automation-stale-strip"

# ── Cleanup + verdict ────────────────────────────────────────────────────────
bun scripts/qa-attention-fixture.ts clean
agent-browser close
echo "SUMMARY: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && echo "QA RESULT: GREEN" || echo "QA RESULT: RED"
exit "$FAIL"

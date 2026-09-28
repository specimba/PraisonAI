set -e
E=agent-browser
echo "--- inject:"; $E eval "$(cat /home/z/my-project/scripts/inject-r86.js)"
$E open http://localhost:3000 >/dev/null 2>&1; sleep 2
echo "--- click-run:"; $E eval '(() => { var h=[...document.querySelectorAll("h3")].find(function(x){return x.textContent==="Novelty Lab (sample)"}); if(!h) return "NO-HEADING"; var cur=h.closest("div"); var runBtn=null; for(var k=0;k<6&&cur;k++){ runBtn=[...cur.querySelectorAll("button")].find(function(b){return b.textContent.trim()==="Run"}); if(runBtn) break; cur=cur.parentElement; } if(!runBtn) return "NO-RUNBTN"; runBtn.click(); return "CLICKED-RUN"; })()'
sleep 1
echo "--- toggle:"; $E eval '(() => { var t=[...document.querySelectorAll("button")].find(function(b){return (b.getAttribute("aria-label")||"").indexOf("Toggle run history")===0}); if(!t) return "NO-TOGGLE"; t.click(); return "TOGGLED"; })()'
sleep 1
echo "--- row:"; $E eval '(() => { var r=[...document.querySelectorAll("button")].find(function(b){return (b.getAttribute("aria-label")||"").indexOf("View run from 1h ago")===0}); if(!r) return "NO-ROW"; r.click(); return "ROW-OPEN"; })()'
sleep 1
echo "--- verify-r87:"; $E eval '(() => { var d=document.querySelector("[role=dialog]"); if(!d) return "NO-DIALOG"; var cb=[...d.querySelectorAll("button[aria-label^=\"Copy output of step\"]")]; return JSON.stringify({copyButtons:cb.length, first:cb.length?cb[0].getAttribute("aria-label"):null}); })()'

E=agent-browser
$E open http://localhost:3000 >/dev/null 2>&1; sleep 2
echo "--- click-probe-run:"; $E eval '(() => { var h=[...document.querySelectorAll("h3")].find(function(x){return x.textContent==="Stall Probe v4"}); if(!h) return "NO-PROBE-CARD"; var cur=h.closest("div"); var runBtn=null; for(var k=0;k<6&&cur;k++){ runBtn=[...cur.querySelectorAll("button")].find(function(b){return b.textContent.trim()==="Run"}); if(runBtn) break; cur=cur.parentElement; } if(!runBtn) return "NO-RUNBTN"; runBtn.click(); return "CLICKED"; })()'
sleep 1
echo "--- fill-task:"; $E eval '(() => { var d=document.querySelector("[role=dialog]"); if(!d) return "NO-DIALOG"; var ta=d.querySelector("textarea"); if(!ta) return "NO-TEXTAREA"; var set=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set; set.call(ta,"stall probe v4 verification run"); ta.dispatchEvent(new Event("input",{bubbles:true})); return "FILLED"; })()'
sleep 1
echo "--- start-run:"; $E eval '(() => { var d=document.querySelector("[role=dialog]"); if(!d) return "NO-DIALOG"; var btn=[...d.querySelectorAll("button")].find(function(b){return b.textContent.trim()==="Run"&&!b.disabled}); if(!btn) return "NO-ENABLED-RUN"; btn.click(); return "RUN-STARTED"; })()'
sleep 3
echo "--- early-state:"; $E eval '(() => { var d=document.querySelector("[role=dialog]"); if(!d) return "NO-DIALOG"; return JSON.stringify({snip:d.textContent.slice(0,180)}); })()'

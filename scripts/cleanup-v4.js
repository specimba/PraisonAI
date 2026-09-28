(() => {
  var out = {};
  var bak = localStorage.getItem("praison-bak-settings");
  if (bak) { localStorage.setItem("praison-settings", bak); localStorage.removeItem("praison-bak-settings"); out.settings = "RESTORED"; } else { out.settings = "NO-BAK"; }
  var wbak = localStorage.getItem("praison-bak-workflows");
  if (wbak) { localStorage.setItem("praison-workflows", wbak); localStorage.removeItem("praison-bak-workflows"); out.workflows = "RESTORED"; } else { out.workflows = "NO-BAK"; }
  localStorage.removeItem("praison-stall-timeout-ms");
  out.stallKey = "REMOVED";
  return JSON.stringify(out);
})()

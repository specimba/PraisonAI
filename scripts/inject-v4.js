(() => {
  var out = {};
  var sraw = localStorage.getItem("praison-settings");
  if (!sraw) return "NO-SETTINGS";
  localStorage.setItem("praison-bak-settings", sraw);
  var senv = JSON.parse(sraw);
  var st = senv.state;
  out.pre = { provider: st.provider, activeProviderId: st.activeProviderId, keys: st.providerKeys ? Object.keys(st.providerKeys).join(",") : "(none)", relayEnabled: st.relayEnabled };
  st.provider = "custom";
  st.activeProviderId = "";
  st.providerKeys = {};
  st.relayEnabled = false;
  st.baseUrl = "http://localhost:4319/v1";
  st.defaultModel = "hang-test";
  localStorage.setItem("praison-settings", JSON.stringify(senv));
  localStorage.setItem("praison-stall-timeout-ms", "20000");
  var araw = localStorage.getItem("praison-agents");
  var aenv = araw ? JSON.parse(araw) : null;
  var agents = aenv && aenv.state && aenv.state.agents ? aenv.state.agents : [];
  out.agents = agents.slice(0, 6).map(function (a) { return a.name + "=" + (a.model || "(undef)"); });
  var wraw = localStorage.getItem("praison-workflows");
  if (!wraw) return "NO-WFS";
  localStorage.setItem("praison-bak-workflows", wraw);
  var wenv = JSON.parse(wraw);
  var wfs = wenv.state.workflows;
  var src = null;
  for (var i = 0; i < wfs.length; i++) { if (wfs[i].steps && wfs[i].steps.length > 0) { src = wfs[i]; break; } }
  if (!src) return "NO-SRC";
  var probe = {
    id: "qa-stall-probe-v4",
    name: "Stall Probe v4",
    description: "E2E recipe v4 single-step stall probe",
    steps: [JSON.parse(JSON.stringify(src.steps[0]))],
    runs: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  var kept = [];
  for (var j = 0; j < wfs.length; j++) { if (wfs[j].id !== "qa-stall-probe-v4") kept.push(wfs[j]); }
  kept.push(probe);
  wenv.state.workflows = kept;
  localStorage.setItem("praison-workflows", JSON.stringify(wenv));
  out.probeStep = probe.steps[0].label + " agentId=" + probe.steps[0].agentId;
  out.ok = true;
  return JSON.stringify(out);
})()

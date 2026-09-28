(() => {
  // v7 = v4 recipe + explicit agent model. v6 falsified "browser dialed 4319"
  // under agents=auto; the v7 hypothesis is the gate just needs the resolved
  // provider to be "custom" — which the legacy branch ALREADY yields with the
  // v4 settings. Forcing the probe agent's model to an explicit id removes the
  // last "auto" ambiguity in resolveLlm's pickModel path.
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
  // v7 DIFF #1: every agent gets an EXPLICIT model id (no "auto" anywhere).
  for (var k = 0; k < agents.length; k++) {
    if (!agents[k].model || agents[k].model === "auto") agents[k].model = "hang-test";
  }
  if (aenv) localStorage.setItem("praison-agents", JSON.stringify(aenv));
  localStorage.setItem("praison-bak-agents", araw || "");
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
    description: "E2E recipe v7 single-step stall probe (explicit agent model)",
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

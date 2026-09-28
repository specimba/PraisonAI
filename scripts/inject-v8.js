(() => {
  // v8 = v7 recipe, but targeting the REAL zustand-persist layer.
  // v7 falsification proved inject-v4/v7 wrote envelope-root mirror keys
  // (state.provider etc.) that the store IGNORES — the real Settings live at
  // state.settings.*. This injector writes the real layer.
  var out = {};
  var sraw = localStorage.getItem("praison-settings");
  if (!sraw) return "NO-SETTINGS";
  localStorage.setItem("praison-bak-settings", sraw);
  var senv = JSON.parse(sraw);
  var real = senv.state.settings;
  if (!real) return "NO-REAL-LAYER";
  out.preReal = { provider: real.provider, activeProviderId: real.activeProviderId, baseUrl: real.baseUrl, relay: real.relayEnabled };
  real.provider = "custom";
  real.activeProviderId = "";
  real.providerKeys = {};
  real.relayEnabled = false;
  real.baseUrl = "http://localhost:4319/v1";
  real.defaultModel = "hang-test";
  real.apiKey = "";
  localStorage.setItem("praison-settings", JSON.stringify(senv));
  localStorage.setItem("praison-stall-timeout-ms", "20000");
  var araw = localStorage.getItem("praison-agents");
  var aenv = araw ? JSON.parse(araw) : null;
  out.agentsShape = aenv && aenv.state ? Object.keys(aenv.state).slice(0, 8).join(",") : "(none)";
  if (aenv && aenv.state && aenv.state.agents) {
    var agents = aenv.state.agents;
    localStorage.setItem("praison-bak-agents", araw);
    for (var k = 0; k < agents.length; k++) {
      if (!agents[k].model || agents[k].model === "auto") agents[k].model = "hang-test";
    }
    localStorage.setItem("praison-agents", JSON.stringify(aenv));
    out.agentsTouched = agents.length;
  }
  var wraw = localStorage.getItem("praison-workflows");
  if (!wraw) return "NO-WFS";
  localStorage.setItem("praison-bak-workflows", wraw);
  var wenv = JSON.parse(wraw);
  var wfs = wenv.state.workflows;
  if (!wfs) return "NO-WF-LAYER";
  var src = null;
  for (var i = 0; i < wfs.length; i++) { if (wfs[i].steps && wfs[i].steps.length > 0) { src = wfs[i]; break; } }
  if (!src) return "NO-SRC";
  var probe = {
    id: "qa-stall-probe-v4",
    name: "Stall Probe v4",
    description: "E2E recipe v8 single-step stall probe (REAL-layer injection)",
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

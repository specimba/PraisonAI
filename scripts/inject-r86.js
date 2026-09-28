(() => {
  var KEY = "praison-workflows";
  var raw = localStorage.getItem(KEY);
  if (!raw) return "NO-STORE";
  var env = JSON.parse(raw);
  var wfs = env.state && env.state.workflows ? env.state.workflows : null;
  if (!wfs || !wfs.length) return "NO-WFS";
  var wf = null;
  for (var i = 0; i < wfs.length; i++) {
    if (wfs[i].name === "Novelty Lab (sample)" && wfs[i].runs) { wf = wfs[i]; break; }
  }
  if (!wf) return "NO-TARGET";
  wf.runs = wf.runs.filter(function (r) { return r.id !== "qa-r86-verify"; });
  var now = Date.now();
  var mk = function (i, sid, name, emoji, label, status, ms) {
    return { stepId: sid, agentId: "qa-a" + i, agentName: name, agentEmoji: emoji, label: label, output: status === "done" ? "ok output " + i : (status === "error" ? "boom" : ""), toolCalls: [], status: status, ms: ms };
  };
  var run = {
    id: "qa-r86-verify",
    workflowId: wf.id,
    workflowName: wf.name,
    task: "r86 render-branch verification (synthetic)",
    status: "error",
    startedAt: now - 3600000,
    finishedAt: now - 3500000,
    steps: [
      mk(1, "qa-s1", "Alpha", "🧪", "Step one", "done", 1200),
      mk(2, "qa-s2", "Beta", "🧬", "Step two", "done", 2300),
      mk(3, "qa-s3", "Gamma", "⚡", "Step three", "error", 3000),
      mk(4, "qa-s4", "Delta", "🛡️", "Step four", "stopped", 0)
    ],
    error: { stepIndex: 2, stepId: "qa-s3", stepLabel: "Step three", agentName: "Gamma", message: "network error", kind: "network", hint: "Retry failed step", toolCallsOk: 1, stepsDone: 2, llmLabel: "QA harness", attempts: 1 },
    resumeCount: 0,
    callLog: [],
    novelty: 50
  };
  wf.runs.push(run);
  localStorage.setItem(KEY, JSON.stringify(env));
  return "INJECTED into " + wf.name + " runs=" + wf.runs.length;
})()

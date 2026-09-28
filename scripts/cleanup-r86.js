(() => {
  var KEY = "praison-workflows";
  var raw = localStorage.getItem(KEY);
  if (!raw) return "NO-STORE";
  var env = JSON.parse(raw);
  var wfs = env.state && env.state.workflows ? env.state.workflows : null;
  if (!wfs) return "NO-WFS";
  var removed = 0;
  for (var i = 0; i < wfs.length; i++) {
    var before = wfs[i].runs.length;
    wfs[i].runs = wfs[i].runs.filter(function (r) { return r.id !== "qa-r86-verify"; });
    removed += before - wfs[i].runs.length;
  }
  localStorage.setItem(KEY, JSON.stringify(env));
  return "REMOVED=" + removed;
})()

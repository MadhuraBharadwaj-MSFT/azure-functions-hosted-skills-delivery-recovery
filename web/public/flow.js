function createMessageFlow() {
  const get = id => document.getElementById(id);
  const svg = get("flow-svg");
  const canvas = get("flow-dots");
  const context = canvas.getContext("2d");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const routePoints = new Map();
  const colors = { valid: "#3979ef", malformed: "#d99532", recovered: "#9056dc" };
  const lanes = new Map();
  const animatedStages = new Map();
  const seen = new Map();
  const observations = new Map();
  let last = null;
  let frameId = null;
  let freshSubmission = false;
  function resizeCanvas() {
    const bounds = svg.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(bounds.width * scale));
    const height = Math.max(1, Math.round(bounds.height * scale));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      context?.setTransform(width / 960, 0, 0, height / 425, 0, 0);
    }
  }

  function clearParticles() {
    if (frameId !== null) cancelAnimationFrame(frameId);
    frameId = null;
    lanes.clear();
    context?.clearRect(0, 0, 960, 425);
    canvas.dataset.movingMessages = "0";
    canvas.dataset.pendingMessages = "0";
  }

  function pointsFor(route) {
    if (!routePoints.has(route)) {
      const path = get(route);
      const length = path.getTotalLength();
      const points = [];
      // Sample each SVG path once, rather than query its geometry for every dot/frame.
      for (let index = 0; index <= 160; index++) {
        const point = path.getPointAtLength(length * index / 160);
        points.push({ x: point.x, y: point.y });
      }
      routePoints.set(route, points);
    }
    return routePoints.get(route);
  }

  function queueMotion(index, stage, route, tone, duration) {
    if (stage <= (animatedStages.get(index) || 0)) return;
    animatedStages.set(index, stage);
    if (!lanes.has(index)) lanes.set(index, { active: null, steps: [], notBefore: null });
    lanes.get(index).steps.push({ route, tone, duration: duration * 1000 });
  }

  function drawFrame(now) {
    frameId = null;
    if (reducedMotion.matches || document.hidden) {
      clearParticles();
      return;
    }
    resizeCanvas();
    context.clearRect(0, 0, 960, 425);
    const dots = { valid: [], malformed: [], recovered: [] };
    let moving = 0;
    for (const [index, lane] of lanes) {
      if (now < lane.notBefore) continue;
      if (lane.active && now - lane.active.startedAt >= lane.active.duration) {
        lane.active = null;
        lane.notBefore = now;
      }
      if (!lane.active) {
        if (!lane.steps.length) {
          lanes.delete(index);
          continue;
        }
        lane.active = { ...lane.steps.shift(), startedAt: lane.notBefore };
      }
      const progress = Math.min(1, (now - lane.active.startedAt) / lane.active.duration);
      const points = pointsFor(lane.active.route);
      const position = progress * 160;
      const segment = Math.min(159, Math.floor(position));
      const fraction = position - segment;
      const a = points[segment];
      const b = points[segment + 1];
      dots[lane.active.tone].push(a.x + (b.x - a.x) * fraction, a.y + (b.y - a.y) * fraction);
      moving++;
    }
    for (const [tone, positions] of Object.entries(dots)) {
      if (!positions.length) continue;
      const radius = tone === "valid" ? 3 : 4.5;
      context.beginPath();
      context.fillStyle = colors[tone];
      for (let index = 0; index < positions.length; index += 2) {
        const x = positions[index];
        const y = positions[index + 1];
        context.moveTo(x + radius, y);
        context.arc(x, y, radius, 0, Math.PI * 2);
      }
      context.fill();
    }
    canvas.dataset.movingMessages = String(moving);
    canvas.dataset.pendingMessages = String(lanes.size - moving);
    if (lanes.size) frameId = requestAnimationFrame(drawFrame);
  }

  function playReadyMotions() {
    if (reducedMotion.matches || document.hidden || !context) {
      clearParticles();
      return;
    }
    const now = performance.now();
    for (const [index, lane] of lanes) {
      // Small identity-based staggering separates same-poll messages without grouping them.
      if (lane.notBefore === null) lane.notBefore = now + ((Math.imul(index, 2654435761) >>> 0) / 4294967296) * 600;
    }
    if (lanes.size && frameId === null) frameId = requestAnimationFrame(drawFrame);
  }

  function state(text, value) {
    get("flow-state").textContent = text;
    svg.setAttribute("data-state", value);
    get("flow-state").setAttribute("data-state", value);
  }

  function reset() {
    clearParticles();
    seen.clear();
    observations.clear();
    animatedStages.clear();
    last = null;
    freshSubmission = false;
    get("flow-sent").textContent = "0 sent; awaiting receipt";
    get("flow-valid").textContent = "0 received; awaiting output";
    get("flow-stored").textContent = "0 output files";
    get("flow-malformed").textContent = "0 rejected records";
    get("flow-repaired").textContent = "0 recovered outputs";
    get("flow-recovery-status").textContent = "Recovery path";
    svg.classList.remove("awaiting-recovery", "confirmed-return");
    get("flow-freshness").textContent = "Last confirmed stages. Waiting for a run.";
    state("Ready", "idle");
  }

  function start() {
    reset();
    freshSubmission = true;
    state("Submitting", "pending");
  }

  function update(run) {
    if (last && last.id !== run.id) reset();
    const first = last === null;
    const tracking = run.tracking;
    get("flow-stored").textContent = `${run.processed.toLocaleString()} output files`;
    if (!tracking) {
      state("Stage data unavailable", "paused");
      get("flow-freshness").textContent = "This API response has no message tracking data.";
      clearParticles();
      return;
    }
    const animate = !first || freshSubmission;
    const counts = Array(7).fill(0);
    let rejected = 0;
    let requeued = 0;
    for (let index = 0; index < tracking.states.length; index++) {
      const previous = seen.get(index) || 0;
      const code = Math.max(previous, tracking.states[index]);
      const previousEvents = observations.get(index) || 0;
      const events = previousEvents | tracking.observations[index];
      const added = events & ~previousEvents;
      observations.set(index, events);
      seen.set(index, code);
      counts[code]++;
      if (events & ((1 << 3) | (1 << 5))) rejected++;
      if (events & (1 << 4)) requeued++;
      if (animate) {
        if (added & (1 << 2)) queueMotion(index, 2, "flow-input-route", "valid", 0.8);
        if (added & (1 << 3)) queueMotion(index, 3, "flow-malformed-route", "malformed", 1.6);
        if (added & (1 << 4)) queueMotion(index, 4, "flow-received-repair-route", "recovered", 1.6);
        if (added & (1 << 5)) queueMotion(index, 5, "flow-malformed-route", "malformed", 1.6);
        if (added & (1 << 6)) queueMotion(index, 6, "flow-output-route", "valid", 0.8);
      } else {
        animatedStages.set(index, code);
      }
    }
    last = run;
    get("flow-sent").textContent = `${counts[1].toLocaleString()} sent; awaiting receipt`;
    get("flow-valid").textContent = `${(counts[2] + counts[4]).toLocaleString()} received; awaiting output`;
    get("flow-malformed").textContent = `${rejected.toLocaleString()} rejected records`;
    get("flow-repaired").textContent = `${run.recovered.toLocaleString()} recovered outputs`;
    const awaiting = counts[3] + counts[5];
    get("flow-recovery-status").textContent = awaiting
      ? `${awaiting} awaiting recovery`
      : requeued ? `${requeued} requeued message${requeued === 1 ? "" : "s"} received` : "Recovery path";
    svg.classList.toggle("awaiting-recovery", awaiting > 0);
    svg.classList.toggle("confirmed-return", requeued > 0);
    get("flow-freshness").textContent = tracking.error || (!tracking.enabled
      ? "Tracking was off for this run. Only dispatch and saved output are available."
      : `Last confirmed stages - checked ${new Date(tracking.observed_at).toLocaleTimeString()}`);

    if (tracking.error || (run.expired && !run.complete) || run.dispatch_error) {
      clearParticles();
      state(tracking.error ? "Tracking unavailable" : run.dispatch_error ? "Dispatch error" : "Run window ended", "paused");
      return;
    }
    if (!context) {
      clearParticles();
      get("flow-freshness").textContent = "Canvas animation is unavailable in this browser. Confirmed counts remain available.";
      state("Animation unavailable", "paused");
      return;
    }
    state(run.complete ? "Complete" : "Tracking messages", run.complete ? "complete" : "pending");
    playReadyMotions();
    freshSubmission = false;
  }

  function pause(message) {
    clearParticles();
    state(message, "paused");
  }

  get("flow-focus").addEventListener("click", () => {
    const highlighted = svg.classList.toggle("highlight-repair");
    get("flow-focus").setAttribute("aria-pressed", String(highlighted));
    get("flow-focus").textContent = highlighted ? "Show all paths" : "Highlight repair path";
  });
  reducedMotion.addEventListener("change", () => { if (reducedMotion.matches) clearParticles(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden) clearParticles(); });
  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();
  reset();
  return { reset, start, update, pause };
}

const el = id => document.getElementById(id);
const messageFlow = createMessageFlow();
const valid = { record_id: "assigned-on-send", source: " Partner Feed ", value: 21.5 };
const malformed = { recordId: "assigned-on-send", source: " Partner Feed ", value: "21.5" };
const batchSize = 1000;
let allowed = false;
let busy = false;
let pending = null;
let currentId = null;
let pollTimer = null;
let elapsedTimer = null;
let startedAt = null;
let completedAt = null;
let sentAt = null;
let observedAt = null;
let pollVersion = 0;
let reconnectStartedAt = null;
let reconnectAttempts = 0;
let restoring = false;
let submissionInFlight = false;
let dispatchConfirmed = false;
let statusRequest = null;
const reconnectLimitMs = 5 * 60 * 1000;
const singlePollMs = 500;
const batchPollMs = 2000;

function setBusy(value) {
  busy = value;
  for (const id of ["send", "batch", "valid", "malformed", "message"]) el(id).disabled = !allowed || busy;
  el("clear").disabled = busy;
}

function error(message) {
  el("error").textContent = message;
  el("error").hidden = !message;
}

async function request(path, options = {}) {
  let result;
  let text;
  try {
    result = await fetch(path, { ...options, cache: "no-store", signal: AbortSignal.timeout(40000) });
    text = await result.text();
  } catch (failure) {
    failure.retryable = ["TypeError", "TimeoutError", "AbortError"].includes(failure.name);
    throw failure;
  }
  const retryAfter = result.headers.get("Retry-After");
  const retryAfterMs = retryAfter === null ? 0 : Math.max(0,
    /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : (Date.parse(retryAfter) - Date.now()) || 0,
  );
  let data;
  try { data = JSON.parse(text); } catch {
    const failure = new Error(
      [401, 403].includes(result.status)
        ? "Access was denied. Sign in with the configured demo-owner Microsoft account, then reload the page."
        : `The server returned a non-JSON response (HTTP ${result.status}). No result is confirmed.`,
    );
    failure.status = result.status;
    failure.retryAfterMs = retryAfterMs;
    throw failure;
  }
  if (!result.ok) {
    const failure = new Error(data.error || `Request failed (HTTP ${result.status}). Check your sign-in and demo access.`);
    failure.status = result.status;
    failure.activeRunId = data.active_run_id;
    failure.retryAfterMs = retryAfterMs;
    throw failure;
  }
  return data;
}

function remember() {
  if (pending || currentId) {
    sessionStorage.setItem("hosted-skill-demo", JSON.stringify({ pending, currentId, sentAt }));
  } else {
    sessionStorage.removeItem("hosted-skill-demo");
  }
}

function showElapsed() {
  const seconds = (end, start) => Math.max(0, (end - start) / 1000).toFixed(1);
  const parts = [];
  if (sentAt !== null) {
    parts.push(`${seconds(observedAt ?? Date.now(), sentAt)}s ${observedAt !== null ? "click to result" : "since send"}`);
  }
  if (startedAt !== null && completedAt !== null) {
    parts.push(`${seconds(completedAt, startedAt)}s run to output`);
  } else if (sentAt === null && startedAt !== null) {
    parts.push(`${seconds(Date.now(), startedAt)}s since run started`);
  }
  el("elapsed").textContent = parts.join(" | ") || "Timing unavailable";
}

function stopPolling() {
  pollVersion++;
  clearTimeout(pollTimer);
  clearInterval(elapsedTimer);
  pollTimer = null;
  elapsedTimer = null;
}

function clearResults() {
  stopPolling();
  messageFlow.reset();
  pending = null;
  currentId = null;
  startedAt = null;
  completedAt = null;
  sentAt = null;
  observedAt = null;
  reconnectStartedAt = null;
  reconnectAttempts = 0;
  restoring = false;
  submissionInFlight = false;
  dispatchConfirmed = false;
  remember();
  error("");
  el("results").hidden = true;
  el("resume").hidden = true;
  el("retry").hidden = true;
  el("run-title").textContent = "Current run";
  el("run-id").textContent = "";
  el("record-id").textContent = "";
  el("original").textContent = "";
  el("output").textContent = "No output yet.";
  el("processed").textContent = "0";
  el("total").textContent = " / 1";
  el("recovered").textContent = "0";
  el("bad-total").textContent = " / 0";
  el("processed-bar").value = 0;
  el("recovered-bar").value = 0;
  el("elapsed").textContent = "0s elapsed";
  el("status").className = "";
  el("status").textContent = "Ready to send.";
  setBusy(false);
}

function render(run) {
  messageFlow.update(run);
  el("results").hidden = false;
  el("run-title").textContent = run.mode === "batch" ? `${run.total.toLocaleString()}-record batch` : "Single-message run";
  el("run-id").textContent = `Run ID: ${run.id}`;
  el("processed").textContent = run.processed.toLocaleString();
  el("total").textContent = ` / ${run.total.toLocaleString()}`;
  el("recovered").textContent = run.recovered;
  el("bad-total").textContent = ` / ${run.malformed}`;
  el("processed-bar").max = run.total;
  el("processed-bar").value = run.processed;
  el("recovered-bar").max = Math.max(1, run.malformed);
  el("recovered-bar").value = run.recovered;
  el("recovery-note").textContent = run.malformed ? "Confirmed by output files for malformed record IDs" : "Valid input. No repair needed.";
  el("example-title").textContent = run.malformed ? "Follow one malformed record" : "Follow this record";
  el("record-id").textContent = run.example.id;
  el("original").textContent = JSON.stringify(run.example.input, null, 2);
  el("output").textContent = run.example.output ? JSON.stringify(run.example.output, null, 2) : "No output yet.";
  startedAt = Date.parse(run.created_at);
  completedAt = run.completed_at ? Date.parse(run.completed_at) : null;
  if (run.complete) observedAt ??= Date.now();
  showElapsed();
  el("status").className = run.complete ? "complete" : "";
  if (run.complete) {
    el("status").textContent = run.malformed
      ? `${run.total === 1 ? "Record processed." : `All ${run.total.toLocaleString()} records processed.`} ${run.recovered} malformed ${run.recovered === 1 ? "record" : "records"} recovered automatically.`
      : "Output confirmed. The existing ingestion function processed the valid record.";
  } else if (run.expired) {
    el("status").textContent = "The 20-minute demo window has ended. Missing output is not confirmed as recovered. Check the function logs.";
  } else if (run.dispatch_error) {
    el("status").textContent = run.dispatch_error;
  } else if (run.dispatch_state !== "submitted") {
    el("status").textContent = "The HTTP producer is sending messages to Service Bus.";
  } else {
    el("status").textContent = run.malformed > run.recovered
      ? "Waiting for output files for the remaining records, including malformed records."
      : "Awaiting ingestion output.";
  }
}

async function poll(version) {
  if (version !== pollVersion) return;
  if (statusRequest) {
    statusRequest.then(() => poll(version), () => poll(version));
    return;
  }
  const read = request(`/api/demo/runs/${currentId}`);
  statusRequest = read;
  try {
    const run = await read;
    if (version !== pollVersion) return;
    if (run.dispatch_state === "submitted" || run.complete) dispatchConfirmed = true;
    if (run.dispatch_state === "submitted" || run.complete || run.expired) pending = null;
    reconnectStartedAt = null;
    reconnectAttempts = 0;
    error("");
    el("retry").hidden = true;
    if (restoring && run.complete) {
      clearResults();
      return;
    }
    restoring = false;
    render(run);
    if (pending && !submissionInFlight && run.dispatch_state !== "submitted" && !run.complete && !run.expired) {
      remember();
      stopPolling();
      error("Sending to Service Bus is not confirmed. Retry the same submission to resume safely.");
      el("retry").hidden = false;
      messageFlow.pause("Send incomplete");
      return;
    }
    if (run.complete || run.expired) {
      stopPolling();
      sessionStorage.removeItem("hosted-skill-demo");
      setBusy(submissionInFlight);
      return;
    }
    remember();
    pollTimer = setTimeout(() => poll(version), run.mode === "single" ? singlePollMs : batchPollMs);
  } catch (failure) {
    if (version !== pollVersion) return;
    if (failure.status === 404 && pending) {
      if (submissionInFlight) {
        pollTimer = setTimeout(() => poll(version), pending.mode === "single" ? singlePollMs : batchPollMs);
        return;
      }
      stopPolling();
      error("No saved run was found. Retry the same submission to send to Service Bus.");
      el("retry").hidden = false;
      el("resume").hidden = true;
      messageFlow.pause("Submission unconfirmed");
      remember();
      return;
    }
    const transient = failure.retryable || [408, 429].includes(failure.status)
      || (failure.status >= 500 && failure.status <= 599);
    el("results").hidden = false;
    el("status").className = "";
    if (transient) {
      reconnectStartedAt ??= Date.now();
      const delay = Math.max(Math.min(2000 * 2 ** Math.min(reconnectAttempts, 3), 15000), failure.retryAfterMs || 0);
      if (Date.now() + delay - reconnectStartedAt <= reconnectLimitMs) {
        reconnectAttempts++;
        error(`${failure.message} The last confirmed counts are unchanged.`);
        el("status").textContent = `Reconnecting... checking again in ${Math.ceil(delay / 1000)}s. Processing continues in Azure.`;
        messageFlow.pause("Reconnecting");
        pollTimer = setTimeout(() => poll(version), delay);
        return;
      }
    }
    stopPolling();
    error(`${failure.message} Progress is not being updated.`);
    const authFailure = [401, 403].includes(failure.status);
    messageFlow.pause(authFailure ? "Sign-in needed" : "Status unavailable");
    el("status").textContent = authFailure
      ? "Sign-in needs attention. Processing continues in Azure; sign in again and reload."
      : "Status is unavailable. Processing continues in Azure; the last confirmed counts are unchanged.";
    el("sign-in").hidden = authFailure ? false : el("sign-in").hidden;
    el("resume").hidden = authFailure;
    el("retry").hidden = !pending;
  } finally {
    if (statusRequest === read) statusRequest = null;
  }
}

function follow(id, restore = false) {
  stopPolling();
  messageFlow.pause("Checking status");
  if (id !== currentId) {
    sentAt = null;
    observedAt = null;
    startedAt = null;
    completedAt = null;
  }
  restoring = restore;
  reconnectStartedAt = null;
  reconnectAttempts = 0;
  currentId = id;
  remember();
  setBusy(true);
  el("resume").hidden = true;
  el("retry").hidden = true;
  elapsedTimer = setInterval(showElapsed, 1000);
  showElapsed();
  poll(pollVersion);
}

async function submit(mode) {
  if (submissionInFlight) return;
  if (busy && !pending) return;
  error("");
  if (!pending) {
    let record;
    try {
      record = mode === "single" ? JSON.parse(el("message").value) : undefined;
    } catch {
      error("Enter valid JSON syntax. To demonstrate repair, change the field name or value type, not the JSON punctuation.");
      return;
    }
    pending = { request_id: crypto.randomUUID().replaceAll("-", ""), mode, ...(record === undefined ? {} : { record }) };
    currentId = pending.request_id;
    sentAt = Date.now();
    observedAt = null;
    remember();
  }
  stopPolling();
  setBusy(true);
  messageFlow.start();
  el("retry").hidden = true;
  el("results").hidden = false;
  el("status").className = "";
  el("status").textContent = "Sending to Service Bus...";
  // Clear previous results immediately; never show them as the new run's output.
  el("processed").textContent = "0";
  el("recovered").textContent = "0";
  el("total").textContent = pending.mode === "batch" ? ` / ${batchSize.toLocaleString()}` : " / 1";
  el("bad-total").textContent = " / ?";
  el("processed-bar").value = 0;
  el("recovered-bar").value = 0;
  el("original").textContent = pending.record ? JSON.stringify(pending.record, null, 2) : "Waiting for the batch's example record.";
  el("output").textContent = "No output yet.";
  el("record-id").textContent = "";
  el("run-id").textContent = `Run ID: ${currentId}`;
  el("run-title").textContent = pending.mode === "batch" ? `${batchSize.toLocaleString()}-record batch` : "Single-message run";
  startedAt = null;
  completedAt = null;
  showElapsed();
  elapsedTimer = setInterval(showElapsed, 1000);
  const submission = pending;
  const version = pollVersion;
  submissionInFlight = true;
  dispatchConfirmed = false;
  pollTimer = setTimeout(() => poll(version), submission.mode === "single" ? singlePollMs : batchPollMs);
  try {
    const run = await request("/api/demo/runs", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(submission),
    });
    if (currentId !== submission.request_id) return;
    submissionInFlight = false;
    pending = null;
    if (observedAt !== null) {
      setBusy(false);
      return;
    }
    el("status").textContent = "Service Bus accepted the messages. Checking results.";
    follow(run.id);
  } catch (failure) {
    if (currentId !== submission.request_id) return;
    submissionInFlight = false;
    if (dispatchConfirmed) {
      error(`${failure.message} Service Bus acceptance was confirmed by status.`);
      el("retry").hidden = true;
      if (observedAt !== null) setBusy(false);
      return;
    }
    stopPolling();
    if (failure.activeRunId) {
      pending = null;
      el("status").textContent = "Following the existing active run.";
      follow(failure.activeRunId);
      return;
    }
    error(failure.message);
    if ([400, 403, 410, 413, 415].includes(failure.status)) {
      pending = null;
      currentId = null;
      remember();
      stopPolling();
      setBusy(false);
      el("status").textContent = "Submission rejected. No new run was accepted.";
      messageFlow.pause("Submission rejected");
    } else {
      el("status").textContent = "Submission outcome is unconfirmed. Retry the same submission to avoid duplicates.";
      messageFlow.pause("Submission unconfirmed");
      el("retry").hidden = false;
    }
  }
}

el("valid").addEventListener("click", () => { el("message").value = JSON.stringify(valid, null, 2); });
el("malformed").addEventListener("click", () => { el("message").value = JSON.stringify(malformed, null, 2); });
el("send").addEventListener("click", () => submit("single"));
el("batch").addEventListener("click", () => submit("batch"));
el("retry").addEventListener("click", () => submit(pending.mode));
el("resume").addEventListener("click", () => follow(currentId));
el("clear").addEventListener("click", () => { if (!busy) clearResults(); });
el("message").value = JSON.stringify(valid, null, 2);

async function initialize() {
  try {
    const { clientPrincipal: user } = await request("/.auth/me");
    el("account").textContent = user?.userDetails || "Not signed in";
    el("sign-in").hidden = Boolean(user);
    el("sign-out").hidden = !user;
    allowed = false;
    if (user?.identityProvider === "aad") {
      try {
        const access = await request("/api/demo/access");
        allowed = access.allowed === true;
      } catch (failure) {
        if (![401, 403].includes(failure.status)) throw failure;
      }
    }
    el("access-note").hidden = allowed;
    el("access-note").textContent = user
      ? "This account is not the configured demo owner. The API checks the Microsoft provider and exact site user ID."
      : "Sign in with the configured Microsoft account. Only the demo owner can submit messages.";
    setBusy(false);
    if (!allowed) return;
    const saved = sessionStorage.getItem("hosted-skill-demo");
    if (saved) {
      const state = JSON.parse(saved);
      if (/^[a-f0-9]{32}$/.test(state.currentId)) {
        pending = state.pending;
        sentAt = Number.isFinite(state.sentAt) && state.sentAt > 0 && state.sentAt <= Date.now() ? state.sentAt : null;
        currentId = state.currentId;
        follow(state.currentId, true);
      }
    }
  } catch (failure) {
    error(`Unable to initialize the demo: ${failure.message}`);
    setBusy(true);
  }
}
initialize();

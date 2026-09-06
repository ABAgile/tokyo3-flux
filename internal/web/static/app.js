(() => {
  "use strict";

  const STATUS_ORDER = ["todo", "in progress", "awaiting review", "pipeline failing", "blocked", "stale", "done"];
  const ATTENTION_ORDER = ["blocked", "pipeline failing", "awaiting review", "stale", "todo"];
  const ATTENTION_STATUSES = new Set(ATTENTION_ORDER);
  const MAX_WORK_ROWS = 100;
  const MAX_ATTENTION_ROWS = 8;
  const MAX_LABELS_PER_ITEM = 5;
  const THEME_STORAGE_KEY = "flux-theme";

  const state = {
    filter: "all",
    snapshot: null,
    milestones: [],
    currentMilestone: "",
    selectedMilestone: new URLSearchParams(window.location.search).get("milestone")?.trim() || "",
    request: 0,
    sync: {
      csrfToken: "",
      state: "idle",
      lastStartedAt: "",
      lastCompletedAt: "",
      lastDurationMS: 0,
      lastError: "",
      snapshotGeneratedAt: "",
      busy: false,
    },
    action: {
      csrfToken: "",
      item: null,
      labels: [],
      mutationEnabled: null,
      plan: null,
      busy: false,
      generation: 0,
    },
    context: {
      csrfToken: "",
      plan: null,
      busy: false,
      generation: 0,
      mode: "create",
      targetID: "",
    },
  };

  const $ = (selector) => document.querySelector(selector);

  function storedTheme() {
    try {
      const value = localStorage.getItem(THEME_STORAGE_KEY);
      return value === "dark" || value === "light" ? value : "";
    } catch (_) {
      return "";
    }
  }

  function applyTheme(theme, persist) {
    const selected = theme === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = selected;
    if (persist) {
      try {
        localStorage.setItem(THEME_STORAGE_KEY, selected);
      } catch (_) {
        // Theme switching still works when browser storage is unavailable.
      }
    }

    const toggle = $("#theme-toggle");
    if (!toggle) return;
    const dark = selected === "dark";
    toggle.setAttribute("aria-pressed", String(dark));
    toggle.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
    const icon = toggle.querySelector(".theme-icon");
    if (icon) icon.textContent = dark ? "☀" : "☾";
    const label = toggle.querySelector(".theme-toggle-label");
    if (label) label.textContent = dark ? "Light mode" : "Dark mode";
    const themeColor = $("#theme-color");
    if (themeColor) themeColor.setAttribute("content", dark ? "#111713" : "#f4f6f1");
  }

  function setupThemeToggle() {
    const toggle = $("#theme-toggle");
    if (!toggle) return;
    applyTheme(document.documentElement.dataset.theme, false);
    toggle.addEventListener("click", () => {
      applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark", true);
    });

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const followSystem = () => {
      if (storedTheme()) return;
      applyTheme(media.matches ? "dark" : "light", false);
    };
    if (typeof media.addEventListener === "function") media.addEventListener("change", followSystem);
    else if (typeof media.addListener === "function") media.addListener(followSystem);
  }

  function element(tag, className, text) {
    const value = document.createElement(tag);
    if (className) value.className = className;
    if (text !== undefined) value.textContent = text;
    return value;
  }

  function clean(value) {
    return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  }

  function limited(value, fallback, length = 180) {
    const text = clean(value) || fallback;
    return text.length > length ? `${text.slice(0, length)}…` : text;
  }

  function numberValue(value, fallback = 0) {
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback;
  }

  function normalize(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Flux returned an invalid snapshot");
    }

    const summary = raw.summary && typeof raw.summary === "object" && !Array.isArray(raw.summary) ? raw.summary : {};
    const sourceItems = Array.isArray(raw.items) ? raw.items : summary.items;
    const items = Array.isArray(sourceItems) ? sourceItems.filter((item) => item && typeof item === "object") : [];
    const sourceCounts = raw.counts && typeof raw.counts === "object" ? raw.counts : summary.counts;
    const counts = {};

    if (sourceCounts && typeof sourceCounts === "object" && !Array.isArray(sourceCounts)) {
      for (const status of STATUS_ORDER) {
        counts[status] = numberValue(sourceCounts[status]);
      }
    }
    if (Object.values(counts).every((count) => count === 0)) {
      for (const item of items) {
        const status = clean(item.status) || "unknown";
        counts[status] = (counts[status] || 0) + 1;
      }
    }

    const rawTotal = raw.total ?? summary.total;
    return {
      generatedAt: clean(raw.generated_at),
      sprint: raw.sprint && typeof raw.sprint === "object" ? raw.sprint : {},
      total: numberValue(rawTotal, items.length),
      counts,
      items,
    };
  }

  function normalizeMilestones(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Flux returned an invalid milestone list");
    }
    const source = Array.isArray(raw.milestones) ? raw.milestones : [];
    const milestones = source
      .filter((milestone) => milestone && typeof milestone === "object")
      .map((milestone) => ({
        name: clean(milestone.name),
        goal: clean(milestone.goal),
        state: clean(milestone.state),
        startDate: clean(milestone.start_date),
        dueDate: clean(milestone.due_date),
      }))
      .filter((milestone) => milestone.name);
    return { current: clean(raw.current), milestones };
  }

  function milestoneDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
    const date = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(date);
  }

  function milestoneRange(milestone) {
    const start = milestoneDate(milestone.startDate);
    const due = milestoneDate(milestone.dueDate);
    if (start && due) return `${start} – ${due}`;
    return start || due;
  }

  function milestoneOptionText(milestone) {
    const range = milestoneRange(milestone);
    return range ? `${milestone.name} · ${range}` : milestone.name;
  }

  function normalizeSyncStatus(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Flux returned an invalid sync status");
    }
    const stateName = clean(raw.state) || "idle";
    return {
      state: stateName,
      lastStartedAt: clean(raw.last_started_at),
      lastCompletedAt: clean(raw.last_completed_at),
      lastDurationMS: numberValue(raw.last_duration_ms),
      lastError: clean(raw.last_error),
      snapshotGeneratedAt: clean(raw.snapshot_generated_at),
    };
  }

  function normalizeContext(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Flux returned an invalid human context response");
    }
    const entries = Array.isArray(raw.entries) ? raw.entries : [];
    return {
      entries: entries
        .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
        .map((entry) => ({
          id: clean(entry.id),
          revision: numberValue(entry.revision, 1),
          kind: clean(entry.kind),
          status: clean(entry.status),
          confidence: clean(entry.confidence),
          category: clean(entry.category),
          statement: limited(entry.statement, "", 2000),
          itemIDs: Array.isArray(entry.item_ids) ? entry.item_ids.map(clean).filter(Boolean).slice(0, 20) : [],
          milestone: clean(entry.milestone),
          scopeAction: clean(entry.scope_action),
          reportingFrom: clean(entry.reporting_from),
          reportingUntil: clean(entry.reporting_until),
          effectiveAt: clean(entry.effective_at),
          sourceURLs: Array.isArray(entry.source_urls) ? entry.source_urls.map(clean).filter(Boolean).slice(0, 5) : [],
          createdAt: clean(entry.created_at),
          decisionOwner: clean(entry.decision_owner),
          updatedAt: clean(entry.updated_at),
        }))
        .filter((entry) => entry.id && entry.status === "confirmed" && entry.statement),
      coverage: raw.coverage && typeof raw.coverage === "object" ? raw.coverage : {},
    };
  }

  function contextKindLabel(kind) {
    if (kind === "delay_explanation") return "Delay explanation";
    if (kind === "scope_change") return "Scope change";
    return "Human context";
  }

  function contextDate(value) {
    const date = new Date(value);
    if (!value || Number.isNaN(date.getTime())) return "date unavailable";
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(date);
  }

  function contextWindow(entry) {
    const fromValue = new Date(entry.reportingFrom);
    const untilValue = new Date(entry.reportingUntil);
    if (!entry.reportingFrom || !entry.reportingUntil || Number.isNaN(fromValue.getTime()) || Number.isNaN(untilValue.getTime())) return "reporting window unavailable";
    let untilLabel = contextDate(untilValue.toISOString());
    if (untilValue.getUTCHours() === 0 && untilValue.getUTCMinutes() === 0 && untilValue.getUTCSeconds() === 0 && untilValue.getUTCMilliseconds() === 0) {
      untilValue.setUTCDate(untilValue.getUTCDate() - 1);
      untilLabel = contextDate(untilValue.toISOString());
    }
    return `${contextDate(fromValue.toISOString())} – ${untilLabel}`;
  }

  function durationText(milliseconds) {
    const value = numberValue(milliseconds);
    if (value < 1000) return `${value}ms`;
    if (value < 60000) return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}s`;
    return `${Math.floor(value / 60000)}m ${Math.floor((value % 60000) / 1000)}s`;
  }

  function syncStatusText(status) {
    if (status.state === "queued") return "Pull queued";
    if (status.state === "syncing") return "Pulling latest source…";
    if (status.state === "error") {
      const when = status.lastCompletedAt ? ` ${formatDate(status.lastCompletedAt)}` : "";
      const duration = status.lastCompletedAt ? ` · ${durationText(status.lastDurationMS)}` : "";
      return `Pull failed${when}${duration} · ${limited(status.lastError, "unknown error", 160)}`;
    }
    if (status.state === "ready" && status.lastCompletedAt) {
      return `Last pull ${formatDate(status.lastCompletedAt)} · ${durationText(status.lastDurationMS)}`;
    }
    return "Waiting for first pull";
  }

  function renderSyncStatus(raw) {
    const status = normalizeSyncStatus(raw);
    Object.assign(state.sync, status);
    const node = $("#sync-status");
    node.dataset.state = status.state;
    $("#sync-status-text").textContent = syncStatusText(status);
    updateSyncButton();
  }

  function statusOf(item) {
    return clean(item.status) || "unknown";
  }

  function statusLabel(status) {
    if (!status || status === "unknown") return "Unknown";
    return status.replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function formatDate(value) {
    const date = new Date(value);
    if (!value || Number.isNaN(date.getTime())) return "activity unknown";
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }

  function relativeDate(value) {
    const date = new Date(value);
    if (!value || Number.isNaN(date.getTime())) return "activity unknown";
    const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    if (seconds < 60) return "updated just now";
    if (seconds < 3600) return `updated ${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `updated ${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 604800) return `updated ${Math.floor(seconds / 86400)}d ago`;
    return `updated ${formatDate(value)}`;
  }

  function initials(value) {
    const text = clean(value);
    if (!text) return "—";
    const words = text.replace(/^@/, "").split(/[\s._-]+/).filter(Boolean);
    if (words.length > 1) return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
    return text.replace(/^@/, "").slice(0, 2).toUpperCase();
  }

  function attentionItems(items) {
    const rank = new Map(ATTENTION_ORDER.map((status, index) => [status, index]));
    return items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => rank.has(statusOf(item)))
      .sort((left, right) => {
        const statusDelta = rank.get(statusOf(left.item)) - rank.get(statusOf(right.item));
        return statusDelta || left.index - right.index;
      })
      .map(({ item }) => item);
  }

  function mergeRequests(items) {
    const entries = [];
    for (const item of items) {
      const requests = Array.isArray(item.merge_requests) ? item.merge_requests : [];
      for (const request of requests) {
        if (!request || typeof request !== "object") continue;
        entries.push({ item, request });
      }
    }
    return entries.sort((left, right) => {
      const leftKey = `${clean(left.item.project_path)}\u0000${clean(left.request.id)}\u0000${clean(left.item.id)}`;
      const rightKey = `${clean(right.item.project_path)}\u0000${clean(right.request.id)}\u0000${clean(right.item.id)}`;
      return leftKey.localeCompare(rightKey);
    });
  }

  function reviewQueue(items) {
    return mergeRequests(items).filter(({ request }) =>
      clean(request.state) === "open" && request.review_requested === true && request.draft !== true,
    );
  }

  function pipelineFailures(items) {
    return mergeRequests(items).filter(({ request }) =>
      clean(request.state) === "open" && clean(request.pipeline) === "failed",
    );
  }

  function appendSeparator(parent) {
    parent.appendChild(element("span", "context-separator", "·"));
  }

  function statusBadge(status) {
    const badge = element("span", "status-badge", statusLabel(status));
    badge.dataset.status = status;
    return badge;
  }

  function mergeRequestChip(request) {
    const pipeline = clean(request.pipeline);
    const review = request.review_requested === true;
    const signal = pipeline === "failed" ? "failed" : review ? "review" : pipeline || clean(request.state) || "open";
    const className = pipeline === "failed" ? "mr-chip mr-chip--failed" : review ? "mr-chip mr-chip--review" : pipeline === "success" ? "mr-chip mr-chip--success" : "mr-chip";
    const chip = element("span", className);
    const id = element("strong", "", clean(request.id) || "MR");
    chip.append(id, element("span", "", "·"), element("span", "", signal));
    const title = clean(request.title);
    if (title) chip.title = title;
    return chip;
  }

  function workLabels(item) {
    const labels = Array.isArray(item.labels) ? item.labels : [];
    const result = [];
    const seen = new Set();
    for (const value of labels) {
      const label = clean(value);
      const key = label.toLowerCase();
      if (!label || seen.has(key)) continue;
      seen.add(key);
      result.push(label);
    }
    return result;
  }

  function labelChip(label, more = false) {
    const chip = element("span", more ? "label-chip label-chip--more" : "label-chip", label);
    chip.setAttribute("role", "listitem");
    if (!more) chip.title = label;
    return chip;
  }

  function workRow(item) {
    const status = statusOf(item);
    const row = element("article", "work-row");
    const main = element("div", "work-main");
    const titleLine = element("div", "work-title-line");
    const title = element("h3", "work-title", limited(item.title, "Untitled work item", 220));
    title.title = clean(item.title);
    titleLine.append(statusBadge(status), title);

    const context = element("div", "work-context");
    context.appendChild(element("span", "", limited(item.id, "Unknown item", 100)));
    if (clean(item.project_path)) {
      appendSeparator(context);
      context.appendChild(element("span", "", limited(item.project_path, "", 100)));
    }
    if (clean(item.state)) {
      appendSeparator(context);
      context.appendChild(element("span", "", `GitLab ${clean(item.state)}`));
    }
    main.append(titleLine, context);

    const labels = workLabels(item);
    if (labels.length > 0) {
      const labelRow = element("div", "label-row");
      labelRow.setAttribute("role", "list");
      labelRow.setAttribute("aria-label", "GitLab labels");
      for (const label of labels.slice(0, MAX_LABELS_PER_ITEM)) labelRow.appendChild(labelChip(label));
      if (labels.length > MAX_LABELS_PER_ITEM) labelRow.appendChild(labelChip(`+${labels.length - MAX_LABELS_PER_ITEM}`, true));
      main.appendChild(labelRow);
    }

    const requests = Array.isArray(item.merge_requests) ? item.merge_requests.filter((request) => request && typeof request === "object") : [];
    if (requests.length > 0) {
      const mrRow = element("div", "mr-row");
      for (const request of requests.slice(0, 6)) mrRow.appendChild(mergeRequestChip(request));
      if (requests.length > 6) mrRow.appendChild(element("span", "mr-chip", `+${requests.length - 6} more`));
      main.appendChild(mrRow);
    }

    const side = element("div", "work-side");
    const assignee = element("span", "assignee");
    assignee.append(element("span", "avatar", initials(item.assignee)), element("span", "", clean(item.assignee) || "Unassigned"));
    assignee.title = clean(item.assignee) || "Unassigned";
    const updated = element("time", "updated", relativeDate(item.last_activity));
    if (clean(item.last_activity)) updated.dateTime = clean(item.last_activity);
    updated.title = formatDate(item.last_activity);
    const canAddLabel = state.action.mutationEnabled !== false && !state.selectedMilestone && clean(item.project_path) && clean(item.id).includes("#") && clean(item.state) === "open";
    if (canAddLabel) {
      const actionButton = element("button", "work-action", "Add label");
      actionButton.type = "button";
      actionButton.setAttribute("aria-label", `Add label to ${limited(item.id, "issue", 100)}`);
      actionButton.addEventListener("click", () => openLabelDialog(item));
      side.append(actionButton);
    }
    side.append(assignee, updated);

    row.append(main, side);
    return row;
  }

  function emptyState(title, detail) {
    const state = element("div", "empty-state");
    state.append(element("strong", "", title), element("span", "", detail));
    return state;
  }

  function errorState(message) {
    const state = element("div", "error-state");
    state.append(element("strong", "", "Snapshot unavailable"), element("span", "", message));
    return state;
  }

  function setActionMessage(message, error = false) {
    const node = $("#label-action-message");
    node.textContent = message;
    if (error) node.dataset.kind = "error";
    else delete node.dataset.kind;
  }

  function renderMutationStatus(data) {
    const status = $("#mutation-status");
    const enabled = data.mutation_enabled === true;
    state.action.mutationEnabled = enabled;
    if (enabled) {
      status.hidden = true;
      status.textContent = "";
    } else {
      status.hidden = false;
      status.textContent = clean(data.message) || "GitLab mutations disabled: FLUX_GITLAB_WRITE_TOKEN is not configured.";
      if ($("#label-dialog").open) closeLabelDialog();
    }
    if (state.snapshot) renderWork(state.snapshot);
  }

  async function loadActionStatus() {
    try {
      const data = await actionRequest("/api/actions/status", { headers: { Accept: "application/json" } });
      if (typeof data.mutation_enabled !== "boolean") throw new Error("Flux returned an invalid mutation status");
      renderMutationStatus(data);
    } catch (_) {
      state.action.mutationEnabled = null;
      $("#mutation-status").hidden = true;
    }
  }

  function resetLabelPlan() {
    state.action.plan = null;
    $("#label-plan").hidden = true;
    $("#label-plan-summary").textContent = "";
    $("#label-plan-expiry").textContent = "";
    $("#label-plan-button").hidden = false;
    $("#label-plan-button").disabled = state.action.labels.length === 0;
    $("#label-plan-button").textContent = "Preview change";
    $("#label-confirm-button").hidden = false;
    $("#label-confirm-button").disabled = true;
    $("#label-confirm-button").textContent = "Confirm and add label";
    $("#label-cancel").textContent = "Cancel";
  }

  function actionIsCurrent(item, generation) {
    return state.action.item === item && state.action.generation === generation;
  }

  function discardLabelActionState() {
    state.action.generation += 1;
    state.action.item = null;
    state.action.labels = [];
    state.action.plan = null;
    state.action.busy = false;
    $("#label-plan").hidden = true;
    $("#label-plan-summary").textContent = "";
    $("#label-plan-expiry").textContent = "";
    $("#label-input").disabled = true;
    $("#label-cancel").disabled = false;
    $("#label-dialog-close").disabled = false;
    $("#label-plan-button").hidden = false;
    $("#label-plan-button").disabled = true;
    $("#label-plan-button").textContent = "Preview change";
    $("#label-confirm-button").hidden = false;
    $("#label-confirm-button").disabled = true;
    $("#label-confirm-button").textContent = "Confirm and add label";
    $("#label-cancel").textContent = "Cancel";
    setActionMessage("");
  }

  function closeLabelDialog() {
    const dialog = $("#label-dialog");
    discardLabelActionState();
    if (dialog.open) dialog.close();
    else dialog.removeAttribute("open");
  }

  function openLabelDialog(item) {
    if (state.selectedMilestone || state.action.mutationEnabled === false) return;
    const dialog = $("#label-dialog");
    const input = $("#label-input");
    state.action.generation += 1;
    const generation = state.action.generation;
    state.action.item = item;
    state.action.labels = [];
    state.action.plan = null;
    state.action.busy = false;
    $("#label-dialog-context").textContent = `${limited(item.title, "Untitled work item", 180)} · ${limited(item.id, "Unknown issue", 100)}`;
    const loading = element("option", "", "Loading available GitLab labels…");
    loading.value = "";
    input.replaceChildren(loading);
    input.value = "";
    input.disabled = true;
    resetLabelPlan();
    setActionMessage("Loading labels defined in GitLab…");
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    input.focus();
    loadAvailableLabels(item, generation);
  }

  function setAvailableLabelOptions(labels) {
    const input = $("#label-input");
    const planButton = $("#label-plan-button");
    state.action.labels = labels;
    input.replaceChildren();
    if (labels.length === 0) {
      const option = element("option", "", "No unused GitLab labels available");
      option.value = "";
      option.disabled = true;
      option.selected = true;
      input.appendChild(option);
      input.disabled = true;
      planButton.disabled = true;
      return;
    }
    const placeholder = element("option", "", "Choose a GitLab label…");
    placeholder.value = "";
    placeholder.disabled = true;
    placeholder.selected = true;
    input.appendChild(placeholder);
    for (const label of labels) {
      const option = element("option", "", label);
      option.value = label;
      input.appendChild(option);
    }
    input.disabled = false;
    planButton.disabled = false;
  }

  async function loadAvailableLabels(item, generation) {
    try {
      const data = await actionRequest(`/api/actions/labels?item_id=${encodeURIComponent(item.id)}`, { headers: { Accept: "application/json" } });
      if (!actionIsCurrent(item, generation)) return;
      const labels = Array.isArray(data.labels)
        ? [...new Set(data.labels.filter((label) => typeof label === "string").map(clean).filter(Boolean))]
        : [];
      setAvailableLabelOptions(labels);
      setActionMessage(labels.length > 0 ? "Choose an existing label, then preview the change." : "This issue has no unused GitLab labels available.", labels.length === 0);
    } catch (error) {
      if (!actionIsCurrent(item, generation)) return;
      setAvailableLabelOptions([]);
      setActionMessage(error instanceof Error ? error.message : "Flux could not load GitLab labels.", true);
    }
  }

  async function fluxRequest(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      cache: "no-store",
      credentials: "same-origin",
      redirect: "manual",
    });
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400) || response.redirected) {
      window.location.assign(`/auth/login?return_to=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      throw new Error("Flux login required");
    }
    let data = {};
    try {
      data = await response.json();
    } catch (_) {
      // The status below still gives the user a useful failure message.
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) data = {};
    if (!response.ok) throw new Error(data.error || `Flux request returned HTTP ${response.status}`);
    return data;
  }

  async function actionRequest(path, options = {}) {
    return fluxRequest(path, options);
  }

  async function syncCSRFToken() {
    if (state.sync.csrfToken) return state.sync.csrfToken;
    const data = await fluxRequest("/api/sync/csrf", { headers: { Accept: "application/json" } });
    if (!clean(data.csrf_token)) throw new Error("Flux did not return a sync authorization token");
    state.sync.csrfToken = data.csrf_token;
    return state.sync.csrfToken;
  }

  async function loadSyncStatus() {
    try {
      const data = await fluxRequest("/api/sync/status", { headers: { Accept: "application/json" } });
      renderSyncStatus(data);
      return state.sync;
    } catch (_) {
      $("#sync-status").dataset.state = "error";
      $("#sync-status-text").textContent = "Pull status unavailable";
      return null;
    }
  }

  async function actionCSRFToken() {
    if (state.action.csrfToken) return state.action.csrfToken;
    const data = await actionRequest("/api/actions/csrf", { headers: { Accept: "application/json" } });
    if (!clean(data.csrf_token)) throw new Error("Flux did not return an action authorization token");
    state.action.csrfToken = data.csrf_token;
    return state.action.csrfToken;
  }

  function setActionBusy(busy) {
    state.action.busy = busy;
    const input = $("#label-input");
    const planButton = $("#label-plan-button");
    const confirmButton = $("#label-confirm-button");
    input.disabled = busy || state.action.labels.length === 0 || Boolean(state.action.plan);
    planButton.disabled = busy || state.action.labels.length === 0 || Boolean(state.action.plan);
    confirmButton.disabled = busy || !state.action.plan;
    // A request must never make the dialog impossible to discard. Closing it
    // invalidates the local action state; the server still enforces its plan.
    $("#label-cancel").disabled = false;
    $("#label-dialog-close").disabled = false;
    if (busy && state.action.plan) {
      confirmButton.textContent = "Applying…";
      $("#label-cancel").textContent = "Close";
    } else if (state.action.plan) {
      confirmButton.textContent = "Confirm and add label";
      $("#label-cancel").textContent = "Discard plan";
    } else {
      confirmButton.textContent = "Confirm and add label";
      $("#label-cancel").textContent = "Cancel";
    }
    if (busy && !planButton.hidden) planButton.textContent = "Planning…";
    else if (!planButton.hidden) planButton.textContent = "Preview change";
  }

  async function planLabel() {
    if (state.action.mutationEnabled === false) {
      setActionMessage("GitLab mutations disabled: FLUX_GITLAB_WRITE_TOKEN is not configured.", true);
      return;
    }
    const item = state.action.item;
    const generation = state.action.generation;
    const input = $("#label-input");
    const label = clean(input.value);
    if (!item || !label) {
      setActionMessage("Choose a label before previewing the change.", true);
      input.focus();
      return;
    }
    if (!state.action.labels.includes(label)) {
      setActionMessage("Choose a label from the current GitLab label list.", true);
      input.focus();
      return;
    }
    resetLabelPlan();
    setActionMessage("");
    setActionBusy(true);
    try {
      const token = await actionCSRFToken();
      if (!actionIsCurrent(item, generation)) return;
      const data = await actionRequest("/api/actions/labels/plan", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-CSRF-Token": token,
        },
        body: JSON.stringify({ item_id: item.id, label }),
      });
      if (!actionIsCurrent(item, generation)) return;
      if (!data.plan || !clean(data.plan.plan_id)) throw new Error("Flux did not return an action plan");
      state.action.plan = data.plan;
      $("#label-plan-summary").textContent = data.plan.confirmation || `Add label ${data.plan.label} to ${data.plan.item_id}`;
      $("#label-plan-expiry").textContent = `Expires ${formatDate(data.plan.expires_at)}`;
      $("#label-plan").hidden = false;
      $("#label-plan-button").hidden = true;
      $("#label-confirm-button").hidden = false;
      $("#label-cancel").textContent = "Discard plan";
      setActionMessage("Review the plan, then confirm only if it is correct.");
    } catch (error) {
      if (!actionIsCurrent(item, generation)) return;
      setActionMessage(error instanceof Error ? error.message : "Flux could not create an action plan.", true);
    } finally {
      if (actionIsCurrent(item, generation)) setActionBusy(false);
    }
  }

  async function confirmLabel() {
    if (state.action.mutationEnabled === false) {
      setActionMessage("GitLab mutations disabled: FLUX_GITLAB_WRITE_TOKEN is not configured.", true);
      return;
    }
    const item = state.action.item;
    const generation = state.action.generation;
    const plan = state.action.plan;
    if (!item || !plan) return;
    setActionBusy(true);
    try {
      const token = await actionCSRFToken();
      if (!actionIsCurrent(item, generation) || state.action.plan !== plan) return;
      await actionRequest("/api/actions/labels/confirm", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-CSRF-Token": token,
        },
        body: JSON.stringify({ plan_id: plan.plan_id, confirmation: plan.confirmation }),
      });
      if (!actionIsCurrent(item, generation) || state.action.plan !== plan) return;
      closeLabelDialog();
      connection("loading", "Action applied · pull queued");
      window.setTimeout(() => {
        if (!document.hidden && !state.selectedMilestone) reloadView();
      }, 750);
    } catch (error) {
      if (!actionIsCurrent(item, generation)) return;
      setActionMessage(error instanceof Error ? error.message : "Flux could not apply the approved action.", true);
      setActionBusy(false);
    }
  }

  function setContextMessage(message, error = false) {
    const node = $("#context-message");
    node.textContent = message;
    if (error) node.dataset.kind = "error";
    else delete node.dataset.kind;
  }

  function resetContextPlan() {
    state.context.plan = null;
    $("#context-plan").hidden = true;
    $("#context-plan-summary").textContent = "";
    $("#context-plan-detail").textContent = "";
    $("#context-plan-expiry").textContent = "";
    $("#context-plan-button").hidden = false;
    $("#context-plan-button").disabled = false;
    $("#context-confirm-button").hidden = false;
    $("#context-confirm-button").disabled = true;
    $("#context-cancel").textContent = "Cancel";
    $("#context-plan-button").textContent = state.context.mode === "redact" ? "Preview redaction" : state.context.mode === "correct" ? "Preview correction" : "Preview context";
    $("#context-confirm-button").textContent = state.context.mode === "redact" ? "Confirm and redact" : state.context.mode === "correct" ? "Confirm correction" : "Confirm and record";
  }

  function contextIsCurrent(generation) {
    return state.context.generation === generation;
  }

  function setContextBusy(busy) {
    state.context.busy = busy;
    const form = $("#context-form");
    const planButton = $("#context-plan-button");
    const confirmButton = $("#context-confirm-button");
    const hasPlan = Boolean(state.context.plan);
    for (const field of form.querySelectorAll("input, select, textarea")) field.disabled = busy || hasPlan;
    planButton.disabled = busy || hasPlan;
    confirmButton.disabled = busy || !hasPlan;
    // Keep Cancel and close available so a stale or slow request cannot trap
    // the human in the approval dialog.
    $("#context-cancel").disabled = false;
    $("#context-dialog-close").disabled = false;
    if (busy && hasPlan) {
      confirmButton.textContent = state.context.mode === "redact" ? "Redacting…" : state.context.mode === "correct" ? "Correcting…" : "Recording…";
      $("#context-cancel").textContent = "Close";
    } else if (hasPlan) {
      confirmButton.textContent = state.context.mode === "redact" ? "Confirm and redact" : state.context.mode === "correct" ? "Confirm correction" : "Confirm and record";
      $("#context-cancel").textContent = "Discard plan";
    } else {
      confirmButton.textContent = state.context.mode === "redact" ? "Confirm and redact" : state.context.mode === "correct" ? "Confirm correction" : "Confirm and record";
      $("#context-cancel").textContent = "Cancel";
    }
    if (busy && !planButton.hidden) planButton.textContent = "Planning…";
    else if (!planButton.hidden) planButton.textContent = state.context.mode === "redact" ? "Preview redaction" : state.context.mode === "correct" ? "Preview correction" : "Preview context";
  }

  function populateContextItems() {
    const select = $("#context-item");
    if (!select) return;
    const previous = clean(select.value);
    select.replaceChildren(element("option", "", "No specific item"));
    select.firstChild.value = "";
    const items = state.snapshot && Array.isArray(state.snapshot.items) ? state.snapshot.items : [];
    for (const item of items) {
      const itemID = clean(item.id);
      if (!itemID) continue;
      const title = limited(item.title, "Untitled work item", 100);
      const option = element("option", "", `${itemID} · ${title}`);
      option.value = itemID;
      select.appendChild(option);
    }
    if (previous && [...select.options].some((option) => option.value === previous)) select.value = previous;
  }

  function setContextKind() {
    const scope = $("#context-kind").value === "scope_change";
    const fields = $("#context-scope-fields");
    const action = $("#context-scope-action");
    const effective = $("#context-effective-at");
    fields.hidden = !scope;
    action.required = scope;
    effective.required = scope;
    action.disabled = !scope;
    effective.disabled = !scope;
    $("#context-decision-owner").disabled = !scope;
  }

  function dateOnlyToUTC(raw, exclusive) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return "";
    const value = new Date(`${raw}T00:00:00Z`);
    if (Number.isNaN(value.getTime())) return "";
    if (exclusive) value.setUTCDate(value.getUTCDate() + 1);
    return value.toISOString();
  }

  function contextFormPayload() {
    const reportingFrom = $("#context-reporting-from").value;
    const reportingUntil = $("#context-reporting-until").value;
    const itemID = clean($("#context-item").value);
    const sourceURL = clean($("#context-source-url").value);
    return {
      kind: clean($("#context-kind").value),
      statement: $("#context-statement").value,
      category: clean($("#context-category").value),
      item_ids: itemID ? [itemID] : [],
      milestone: $("#context-milestone").value,
      scope_action: clean($("#context-scope-action").value),
      decision_owner: $("#context-decision-owner").value,
      reporting_from: dateOnlyToUTC(reportingFrom, false),
      reporting_until: dateOnlyToUTC(reportingUntil, true),
      effective_at: dateOnlyToUTC($("#context-effective-at").value, false),
      source_urls: sourceURL ? [sourceURL] : [],
      supersedes_id: state.context.mode === "correct" ? state.context.targetID : "",
    };
  }

  function dateInputValue(value, inclusiveEnd = false) {
    const date = new Date(value);
    if (!value || Number.isNaN(date.getTime())) return "";
    if (inclusiveEnd) date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString().slice(0, 10);
  }

  function prepareContextDialog(mode, entry = null) {
    const dialog = $("#context-dialog");
    state.context.generation += 1;
    state.context.plan = null;
    state.context.busy = false;
    state.context.mode = mode;
    state.context.targetID = entry ? clean(entry.id) : "";
    $("#context-form").reset();
    $("#context-form-fields").hidden = mode === "redact";
    $("#context-dialog-title").textContent = mode === "redact" ? "Redact delivery context" : mode === "correct" ? "Correct delivery context" : "Record delivery context";
    $("#context-dialog-context").textContent = mode === "redact"
      ? "This removes retained free-text context for the selected entry. The operation is append-only in the audit trail and requires explicit confirmation."
      : "This note is an audited, human-reported overlay. It does not change GitLab status, counts, milestones, or historical revisions.";
    if (entry && mode === "correct") {
      $("#context-kind").value = entry.kind || "delay_explanation";
      $("#context-category").value = entry.category || "other";
      $("#context-reporting-from").value = dateInputValue(entry.reportingFrom);
      $("#context-reporting-until").value = dateInputValue(entry.reportingUntil, true) || dateInputValue(entry.reportingFrom);
      $("#context-milestone").value = entry.milestone;
      $("#context-item").value = entry.itemIDs[0] || "";
      $("#context-statement").value = entry.statement;
      $("#context-scope-action").value = entry.scopeAction || "add";
      $("#context-effective-at").value = dateInputValue(entry.effectiveAt);
      $("#context-decision-owner").value = entry.decisionOwner;
      $("#context-source-url").value = entry.sourceURLs[0] || "";
    } else {
      const today = new Date().toISOString().slice(0, 10);
      $("#context-reporting-from").value = today;
      $("#context-reporting-until").value = today;
      $("#context-milestone").value = clean(state.snapshot?.sprint?.name);
    }
    populateContextItems();
    setContextKind();
    $("#context-form-fields").hidden = mode === "redact";
    resetContextPlan();
    setContextMessage(mode === "redact" ? `Review redaction of ${limited(entry?.id, "the selected entry", 100)}.` : mode === "correct" ? "Update the context, then preview the exact correction." : "Describe only observable delivery context, then preview the exact record.");
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    if (mode === "redact") $("#context-plan-button").focus();
    else $("#context-kind").focus();
  }

  function openContextDialog() {
    prepareContextDialog("create");
  }

  function openContextCorrection(entry) {
    prepareContextDialog("correct", entry);
  }

  function openContextRedaction(entry) {
    prepareContextDialog("redact", entry);
  }

  function discardContextState() {
    state.context.generation += 1;
    state.context.plan = null;
    state.context.busy = false;
    resetContextPlan();
    setContextBusy(false);
    setContextMessage("");
  }

  function closeContextDialog() {
    const dialog = $("#context-dialog");
    discardContextState();
    if (dialog.open) dialog.close();
    else dialog.removeAttribute("open");
  }

  async function contextCSRFToken() {
    if (state.context.csrfToken) return state.context.csrfToken;
    const data = await fluxRequest("/api/context/csrf", { headers: { Accept: "application/json" } });
    if (!clean(data.csrf_token)) throw new Error("Flux did not return a context authorization token");
    state.context.csrfToken = data.csrf_token;
    return state.context.csrfToken;
  }

  function contextPlanSummary(plan) {
    const entry = plan && plan.entry && typeof plan.entry === "object" ? plan.entry : {};
    if (clean(plan?.operation) === "redact") return `Redact ${contextKindLabel(clean(entry.kind)).toLowerCase()}`;
    const parts = [contextKindLabel(clean(entry.kind)), clean(entry.category).replace(/_/g, " ")];
    if (clean(entry.scope_action)) parts.push(clean(entry.scope_action));
    return parts.filter(Boolean).join(" · ");
  }

  function contextPlanDetail(plan) {
    const entry = plan && plan.entry && typeof plan.entry === "object" ? plan.entry : {};
    if (clean(plan?.operation) === "redact") return `Context: ${limited(entry.id, "selected entry", 100)} · free-text fields will be scrubbed from retained records; audit metadata will remain.`;
    const details = [`Context: ${limited(entry.id, "new entry", 100)} · revision ${numberValue(entry.revision, 1)}`, limited(entry.statement, "No statement", 2000), contextWindow({ reportingFrom: clean(entry.reporting_from), reportingUntil: clean(entry.reporting_until) })];
    if (clean(entry.milestone)) details.push(`Milestone: ${limited(entry.milestone, "", 200)}`);
    if (Array.isArray(entry.item_ids) && entry.item_ids.length > 0) details.push(`Item: ${limited(entry.item_ids[0], "", 300)}`);
    if (clean(entry.scope_action)) details.push(`Action: ${clean(entry.scope_action)}`);
    if (clean(entry.effective_at)) details.push(`Effective: ${contextDate(entry.effective_at)}`);
    if (clean(entry.decision_owner)) details.push(`Decision owner: ${limited(entry.decision_owner, "", 200)}`);
    if (Array.isArray(entry.source_urls) && entry.source_urls.length > 0) details.push(`Evidence: ${limited(entry.source_urls[0], "", 500)}`);
    return details.filter(Boolean).join(" · ");
  }

  async function planContext() {
    const form = $("#context-form");
    if (state.context.mode !== "redact" && !form.reportValidity()) return;
    if (state.context.mode === "redact" && !state.context.targetID) {
      setContextMessage("Choose a context entry to redact.", true);
      return;
    }
    const generation = state.context.generation;
    resetContextPlan();
    setContextMessage("");
    setContextBusy(true);
    try {
      const token = await contextCSRFToken();
      if (!contextIsCurrent(generation)) return;
      const data = await fluxRequest(state.context.mode === "redact" ? "/api/context/redact/plan" : "/api/context/plan", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-CSRF-Token": token,
        },
        body: JSON.stringify(state.context.mode === "redact" ? { context_id: state.context.targetID } : contextFormPayload()),
      });
      if (!contextIsCurrent(generation)) return;
      if (!data.plan || !clean(data.plan.plan_id)) throw new Error("Flux did not return a context plan");
      state.context.plan = data.plan;
      $("#context-plan-summary").textContent = contextPlanSummary(data.plan);
      $("#context-plan-detail").textContent = contextPlanDetail(data.plan);
      $("#context-plan-expiry").textContent = `Confirmation: ${limited(data.plan.confirmation, "exact confirmation required", 180)} · Expires ${formatDate(data.plan.expires_at)}`;
      $("#context-plan").hidden = false;
      $("#context-plan-button").hidden = true;
      setContextMessage("Review the exact record. Confirm only if it is correct and agreed by the team.");
    } catch (error) {
      if (!contextIsCurrent(generation)) return;
      setContextMessage(error instanceof Error ? error.message : "Flux could not create a context plan.", true);
    } finally {
      if (contextIsCurrent(generation)) setContextBusy(false);
    }
  }

  async function confirmContext() {
    const generation = state.context.generation;
    const plan = state.context.plan;
    if (!plan) return;
    setContextBusy(true);
    try {
      const token = await contextCSRFToken();
      if (!contextIsCurrent(generation) || state.context.plan !== plan) return;
      await fluxRequest(state.context.mode === "redact" ? "/api/context/redact/confirm" : "/api/context/confirm", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-CSRF-Token": token,
        },
        body: JSON.stringify({ plan_id: plan.plan_id, confirmation: plan.confirmation }),
      });
      if (!contextIsCurrent(generation) || state.context.plan !== plan) return;
      closeContextDialog();
      await loadContext();
    } catch (error) {
      if (!contextIsCurrent(generation)) return;
      setContextMessage(error instanceof Error ? error.message : "Flux could not record the confirmed context.", true);
      setContextBusy(false);
    }
  }

  async function loadContext() {
    try {
      const data = await fluxRequest("/api/context?limit=20", { headers: { Accept: "application/json" } });
      renderContext(normalizeContext(data));
    } catch (error) {
      const list = $("#context-list");
      list.replaceChildren(contextErrorState(error instanceof Error ? error.message : "The Flux context API could not be reached."));
      list.setAttribute("aria-busy", "false");
      $("#context-summary").textContent = "Confirmed human context unavailable";
    }
  }

  function renderMetrics(snapshot) {
    const count = (status) => numberValue(snapshot.counts[status]);
    $("#hero-total").textContent = String(snapshot.total);
    $("#metric-total").textContent = String(snapshot.total);
    $("#metric-active").textContent = String(count("in progress"));
    $("#metric-blocked").textContent = String(count("blocked"));
    $("#metric-review").textContent = String(count("awaiting review"));
    $("#metric-pipeline").textContent = String(count("pipeline failing"));
  }

  function filteredItems(snapshot) {
    if (state.filter === "attention") return attentionItems(snapshot.items);
    if (state.filter === "done") return snapshot.items.filter((item) => statusOf(item) === "done");
    return snapshot.items;
  }

  function renderWork(snapshot) {
    const list = $("#work-list");
    const items = filteredItems(snapshot);
    const attentionCount = attentionItems(snapshot.items).length;
    const shown = items.slice(0, MAX_WORK_ROWS);
    const filterLabel = state.filter === "all" ? "all work" : state.filter;
    $("#work-summary").textContent = `${items.length} ${items.length === 1 ? "item" : "items"} in ${filterLabel} · ${attentionCount} needing attention`;
    list.replaceChildren();
    list.setAttribute("aria-busy", "false");
    if (shown.length === 0) {
      list.appendChild(emptyState(state.filter === "all" ? "No work items in this milestone" : "Nothing in this view", state.filter === "all" ? "The current milestone has no issue signals yet." : "Try another filter to see more of the milestone."));
      return;
    }
    for (const item of shown) list.appendChild(workRow(item));
    if (items.length > MAX_WORK_ROWS) {
      list.appendChild(element("div", "empty-state", `Showing ${MAX_WORK_ROWS} of ${items.length} items.`));
    }
  }

  function attentionItem(item) {
    const status = statusOf(item);
    const row = element("article", "attention-item");
    const stripe = element("span", "attention-stripe");
    stripe.dataset.status = status;
    const copy = element("div", "");
    copy.append(element("div", "attention-status", statusLabel(status)), element("h3", "attention-title", limited(item.title, "Untitled work item", 150)));
    const meta = [limited(item.id, "Unknown item", 80), clean(item.project_path), clean(item.assignee) || "unassigned"];
    copy.appendChild(element("div", "attention-meta", meta.filter(Boolean).join(" · ")));
    row.append(stripe, copy);
    return row;
  }

  function renderAttention(snapshot) {
    const items = attentionItems(snapshot.items);
    $("#attention-count").textContent = String(items.length);
    const list = $("#attention-list");
    list.replaceChildren();
    list.setAttribute("aria-busy", "false");
    if (items.length === 0) {
      list.appendChild(emptyState("Clear runway", "No work items are currently flagged for attention."));
      return;
    }
    for (const item of items.slice(0, MAX_ATTENTION_ROWS)) list.appendChild(attentionItem(item));
    if (items.length > MAX_ATTENTION_ROWS) {
      list.appendChild(element("div", "empty-state", `+${items.length - MAX_ATTENTION_ROWS} more in the work pulse.`));
    }
  }

  function queueRow(icon, label, entries, kind) {
    const row = element("div", "queue-row");
    row.append(element("span", `queue-icon queue-icon--${kind}`, icon), element("span", "queue-label", label), element("strong", "", String(entries.length)));
    if (entries.length > 0) {
      const details = element("div", "queue-detail-list");
      for (const entry of entries.slice(0, 3)) {
        const requestID = clean(entry.request.id) || "MR";
        const title = limited(entry.request.title, "Untitled merge request", 80);
        const issueID = limited(entry.item.id, "unknown issue", 60);
        details.appendChild(element("span", "queue-detail", `${requestID} · ${title} · ${issueID}`));
      }
      if (entries.length > 3) details.appendChild(element("span", "queue-detail", `+${entries.length - 3} more`));
      row.appendChild(details);
    }
    return row;
  }

  function renderQueues(snapshot) {
    const list = $("#queue-list");
    list.replaceChildren(queueRow("◎", "Review queue", reviewQueue(snapshot.items), "review"), queueRow("⌁", "Pipeline failures", pipelineFailures(snapshot.items), "pipeline"));
    list.setAttribute("aria-busy", "false");
  }

  function contextEntry(entry) {
    const article = element("article", "context-entry");
    const header = element("div", "context-entry-header");
    header.append(element("span", "context-entry-kind", contextKindLabel(entry.kind)), element("time", "context-entry-time", `Recorded ${contextDate(entry.updatedAt)}`));
    const statement = element("p", "context-entry-statement", entry.statement);
    const meta = element("div", "context-entry-meta");
    meta.setAttribute("aria-label", "Human context details");
    if (entry.category) meta.appendChild(element("span", "", entry.category.replace(/_/g, " ")));
    if (entry.reportingFrom && entry.reportingUntil) meta.appendChild(element("span", "", `Window: ${contextWindow(entry)}`));
    if (entry.milestone) meta.appendChild(element("span", "", `Milestone: ${limited(entry.milestone, "", 120)}`));
    if (entry.itemIDs.length > 0) meta.appendChild(element("span", "", `Items: ${entry.itemIDs.map((itemID) => limited(itemID, "", 80)).join(", ")}`));
    if (entry.scopeAction) meta.appendChild(element("span", "", `Action: ${entry.scopeAction}`));
    const actions = element("div", "context-entry-actions");
    const correct = element("button", "context-entry-action", "Correct");
    correct.type = "button";
    correct.setAttribute("aria-label", `Correct ${contextKindLabel(entry.kind).toLowerCase()} ${limited(entry.id, "entry", 80)}`);
    correct.addEventListener("click", () => openContextCorrection(entry));
    const redact = element("button", "context-entry-action context-entry-action--quiet", "Redact");
    redact.type = "button";
    redact.setAttribute("aria-label", `Redact ${contextKindLabel(entry.kind).toLowerCase()} ${limited(entry.id, "entry", 80)}`);
    redact.addEventListener("click", () => openContextRedaction(entry));
    actions.append(correct, redact);
    article.append(header, statement);
    if (meta.childElementCount > 0) article.appendChild(meta);
    article.appendChild(actions);
    return article;
  }

  function contextErrorState(message) {
    const node = element("div", "error-state");
    node.append(element("strong", "", "Context unavailable"), element("span", "", limited(message, "Human context could not be loaded.", 180)));
    return node;
  }

  function renderContext(data) {
    const list = $("#context-list");
    const entries = data.entries.slice(0, 20);
    const count = data.entries.length;
    const coverage = data.coverage || {};
    let summary = `${count} confirmed human-reported ${count === 1 ? "entry" : "entries"}`;
    if (clean(coverage.last_updated_at)) summary += ` · updated ${formatDate(coverage.last_updated_at)}`;
    summary += " · overlay only";
    $("#context-summary").textContent = summary;
    list.replaceChildren();
    list.setAttribute("aria-busy", "false");
    if (entries.length === 0) {
      list.appendChild(emptyState("No confirmed context yet", "Record an observable delay explanation or scope change when the team has agreed on it."));
      return;
    }
    for (const entry of entries) list.appendChild(contextEntry(entry));
    if (count > entries.length) list.appendChild(element("div", "empty-state", `Showing ${entries.length} of ${count} confirmed entries.`));
  }

  function render(snapshot) {
    state.snapshot = snapshot;
    const name = clean(snapshot.sprint.name) || "No active milestone";
    $("#sprint-name").textContent = name;
    const goal = clean(snapshot.sprint.goal);
    $("#sprint-goal").textContent = goal || "No sprint goal recorded in the milestone description.";
    $("#generated-at").textContent = snapshot.generatedAt
      ? state.selectedMilestone ? `Read on demand ${formatDate(snapshot.generatedAt)}` : `Last reconciled ${formatDate(snapshot.generatedAt)}`
      : "Last reconciliation unavailable";
    document.title = `Flux · ${name}`;
    renderMetrics(snapshot);
    renderWork(snapshot);
    renderAttention(snapshot);
    renderQueues(snapshot);
    populateContextItems();
  }

  function resetForError(message) {
    const text = limited(message, "The server did not return a usable snapshot.", 180);
    state.snapshot = null;
    $("#sprint-name").textContent = "Flux is waiting for a snapshot";
    $("#sprint-goal").textContent = text;
    $("#generated-at").textContent = "Last reconciliation unavailable";
    $("#hero-total").textContent = "—";
    for (const id of ["metric-total", "metric-active", "metric-blocked", "metric-review", "metric-pipeline"]) $("#" + id).textContent = "—";
    $("#work-summary").textContent = "No current read model available";
    const workList = $("#work-list");
    workList.replaceChildren(errorState(text));
    workList.setAttribute("aria-busy", "false");
    $("#attention-count").textContent = "—";
    const attentionList = $("#attention-list");
    attentionList.replaceChildren(errorState("Reload the view to try the latest cached snapshot."));
    attentionList.setAttribute("aria-busy", "false");
    const queues = $("#queue-list");
    queues.replaceChildren(errorState("Reload the view to restore delivery queues."));
    queues.setAttribute("aria-busy", "false");
  }

  function syncMilestoneURL() {
    const url = new URL(window.location.href);
    if (state.selectedMilestone) url.searchParams.set("milestone", state.selectedMilestone);
    else url.searchParams.delete("milestone");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  function updateSyncButton() {
    const button = $("#sync-button");
    if (!button) return;
    const selected = Boolean(state.selectedMilestone);
    button.disabled = selected || state.sync.busy;
    button.setAttribute("aria-busy", String(state.sync.busy));
    button.title = selected ? "Sync is available for the rolling view only" : "Pull latest source state";
    button.setAttribute("aria-label", selected ? "Sync unavailable for selected milestone view" : "Pull latest source state");
    const label = button.querySelector("span");
    if (label) label.textContent = state.sync.busy ? "Syncing…" : "Sync now";
  }

  function updateMilestoneNote() {
    const selected = Boolean(state.selectedMilestone);
    $("#milestone-note").textContent = selected ? "Selected milestone · read-only view" : "Rolling current milestone";
    $("#footer-version").textContent = selected ? "selected view read on demand" : "last reconciled snapshot";
    updateSyncButton();
  }

  function renderMilestones(data) {
    const select = $("#milestone-select");
    state.milestones = data.milestones;
    const names = new Set(data.milestones.map((milestone) => milestone.name));
    const current = names.has(data.current) ? data.current : "";
    const requested = names.has(state.selectedMilestone) ? state.selectedMilestone : "";
    const selected = requested || current || data.milestones[0]?.name || "";
    state.currentMilestone = current;
    state.selectedMilestone = selected && selected !== current ? selected : "";
    syncMilestoneURL();

    select.replaceChildren();
    for (const milestone of data.milestones) {
      const label = milestoneOptionText(milestone) + (milestone.name === current ? " · current" : "");
      const option = element("option", "", label);
      option.value = milestone.name;
      if (milestone.goal) option.title = milestone.goal;
      select.appendChild(option);
    }
    if (!selected) {
      select.appendChild(element("option", "", "No active milestones available"));
      select.disabled = true;
      $("#milestone-note").textContent = "No active milestones available";
      updateSyncButton();
      return;
    }
    select.value = selected;
    select.disabled = false;
    updateMilestoneNote();
  }

  async function loadMilestones() {
    const select = $("#milestone-select");
    select.disabled = true;
    try {
      const response = await fetch("/api/milestones", {
        headers: { Accept: "application/json" },
        cache: "no-store",
        credentials: "same-origin",
      });
      if (response.redirected && new URL(response.url, window.location.href).pathname.startsWith("/auth/")) {
        window.location.assign("/auth/login?return_to=%2F");
        return;
      }
      if (!response.ok) throw new Error(`Flux milestone API returned HTTP ${response.status}`);
      renderMilestones(normalizeMilestones(await response.json()));
    } catch (_) {
      state.milestones = [];
      state.currentMilestone = "";
      select.replaceChildren(element("option", "", "Milestones unavailable"));
      select.disabled = true;
      $("#milestone-note").textContent = "Milestone list unavailable";
      updateSyncButton();
    }
  }

  function connection(kind, text) {
    const status = $("#connection-status");
    const dot = element("span", `status-dot${kind === "loading" ? " status-dot--loading" : kind === "error" ? " status-dot--error" : ""}`);
    dot.setAttribute("aria-hidden", "true");
    status.replaceChildren(dot, element("span", "", text));
  }

  async function reloadView() {
    const requestID = ++state.request;
    const reload = $("#reload-button");
    const label = reload.querySelector("span");
    const picker = $("#milestone-select");
    const selected = Boolean(state.selectedMilestone);
    reload.disabled = true;
    if (state.milestones.length > 0) picker.disabled = true;
    reload.setAttribute("aria-busy", "true");
    if (label) label.textContent = "Reloading";
    connection("loading", selected ? "Loading milestone view" : "Reloading cached view");

    try {
      const query = selected ? `?milestone=${encodeURIComponent(state.selectedMilestone)}` : "";
      const response = await fetch(`/api/today${query}`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        credentials: "same-origin",
      });
      if (requestID !== state.request) return;
      if (response.redirected && new URL(response.url, window.location.href).pathname.startsWith("/auth/")) {
        window.location.assign("/auth/login?return_to=%2F");
        return;
      }
      if (!response.ok) throw new Error(`Flux API returned HTTP ${response.status}`);
      const snapshot = normalize(await response.json());
      render(snapshot);
      connection("ok", selected ? `Milestone view loaded ${formatDate(snapshot.generatedAt)}` : `Cached view loaded ${formatDate(snapshot.generatedAt)}`);
    } catch (error) {
      if (requestID !== state.request) return;
      const message = error instanceof Error ? error.message : "The Flux API could not be reached.";
      resetForError(message);
      connection("error", "View reload unavailable");
    } finally {
      if (requestID === state.request) {
        reload.disabled = false;
        reload.removeAttribute("aria-busy");
        if (state.milestones.length > 0) picker.disabled = false;
        if (label) label.textContent = "Reload view";
      }
    }
  }

  function wait(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  async function waitForPull() {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const status = await loadSyncStatus();
      if (status && status.state !== "queued" && status.state !== "syncing") return status;
      await wait(400);
    }
    return null;
  }

  async function syncNow() {
    if (state.selectedMilestone || state.sync.busy) return;
    state.sync.busy = true;
    updateSyncButton();
    connection("loading", "Pulling latest source state");
    try {
      const token = await syncCSRFToken();
      await fluxRequest("/api/sync", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "X-CSRF-Token": token,
        },
      });
      connection("loading", "Pull queued");
      const status = await waitForPull();
      if (!status) {
        connection("error", "Pull still running");
        return;
      }
      await reloadView();
      if (status.state === "error") connection("error", "Pull failed · cached view unchanged");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Flux could not start a pull.";
      connection("error", message);
      await loadSyncStatus();
    } finally {
      state.sync.busy = false;
      updateSyncButton();
    }
  }

  setupThemeToggle();

  $("#milestone-select").addEventListener("change", () => {
    const selected = clean($("#milestone-select").value);
    if (!selected) return;
    state.selectedMilestone = selected === state.currentMilestone ? "" : selected;
    syncMilestoneURL();
    updateMilestoneNote();
    reloadView();
  });

  for (const button of document.querySelectorAll("[data-filter]")) {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter || "all";
      for (const candidate of document.querySelectorAll("[data-filter]")) {
        const selected = candidate === button;
        candidate.classList.toggle("is-selected", selected);
        candidate.setAttribute("aria-pressed", String(selected));
      }
      if (state.snapshot) renderWork(state.snapshot);
    });
  }

  $("#label-dialog").addEventListener("close", () => {
    // Escape and other native dialog closes must clear stale request state too.
    if (state.action.item || state.action.plan || state.action.busy) discardLabelActionState();
  });
  $("#label-dialog-close").addEventListener("click", closeLabelDialog);
  $("#label-cancel").addEventListener("click", closeLabelDialog);
  $("#label-plan-button").addEventListener("click", planLabel);
  $("#label-confirm-button").addEventListener("click", confirmLabel);
  $("#label-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.action.plan) confirmLabel();
    else planLabel();
  });
  $("#label-input").addEventListener("change", () => {
    if (state.action.plan) {
      resetLabelPlan();
      setActionMessage("");
    }
  });

  $("#context-open-button").addEventListener("click", openContextDialog);
  $("#context-panel-open-button").addEventListener("click", openContextDialog);
  $("#context-dialog").addEventListener("close", () => {
    if (state.context.plan || state.context.busy) discardContextState();
  });
  $("#context-dialog-close").addEventListener("click", closeContextDialog);
  $("#context-cancel").addEventListener("click", closeContextDialog);
  $("#context-kind").addEventListener("change", () => {
    if (state.context.plan) resetContextPlan();
    setContextKind();
  });
  for (const field of document.querySelectorAll("#context-form input, #context-form select, #context-form textarea")) {
    field.addEventListener("input", () => {
      if (state.context.plan) {
        resetContextPlan();
        setContextMessage("The plan was discarded because the context changed.");
      }
    });
    field.addEventListener("change", () => {
      if (state.context.plan) {
        resetContextPlan();
        setContextMessage("The plan was discarded because the context changed.");
      }
    });
  }
  $("#context-plan-button").addEventListener("click", planContext);
  $("#context-confirm-button").addEventListener("click", confirmContext);
  $("#context-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.context.plan) confirmContext();
    else planContext();
  });

  $("#reload-button").addEventListener("click", reloadView);
  $("#sync-button").addEventListener("click", syncNow);
  updateSyncButton();
  (async function initialize() {
    await Promise.all([loadActionStatus(), loadSyncStatus(), loadContext()]);
    await loadMilestones();
    await reloadView();
  })();
  window.setInterval(() => {
    // The rolling view reloads the reconciled cache. A picked milestone is
    // fetched on demand to avoid repeatedly fan-out querying GitLab.
    if (!document.hidden && !$("#reload-button").disabled && !state.selectedMilestone) reloadView();
    if (!document.hidden && !state.sync.busy) loadSyncStatus();
  }, 60_000);
})();

const DEFAULT_REQUIRED_MINUTES = 8 * 60 + 30;
const DEFAULT_SHORT_LEAVE_MINUTES = 50;

function minutesToHHMM(mins) {
  mins = ((mins % 1440) + 1440) % 1440; // wrap past midnight / below zero
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

function hhmmToMinutes(text) {
  const match = text.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
}

function formatFetchedAt(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ---------- State kept in the popup for live recompute ----------

let currentRecord = null; // last fetched { fetchedAt, inTime, outTime, alreadyOut, ... }
let currentRequiredMinutes = DEFAULT_REQUIRED_MINUTES;
let currentShortLeaveMinutes = DEFAULT_SHORT_LEAVE_MINUTES;
let currentShortLeaveCount = 0;

// ---------- Required hours ----------

const hoursInput = document.getElementById("requiredHours");
const saveStatus = document.getElementById("saveStatus");

document.getElementById("saveHours").addEventListener("click", () => {
  const minutes = hhmmToMinutes(hoursInput.value);
  if (minutes === null) {
    saveStatus.style.color = "var(--bad)";
    saveStatus.textContent = "Enter time as HH:MM, e.g. 09:00";
    return;
  }
  currentRequiredMinutes = minutes;
  chrome.storage.sync.set({ requiredMinutes: minutes }, () => {
    saveStatus.style.color = "var(--good)";
    saveStatus.textContent = "Saved.";
    setTimeout(() => (saveStatus.textContent = ""), 1500);
    updateDisplay();
  });
});

// ---------- Credentials ----------

const userIdInput = document.getElementById("userId");
const passwordInput = document.getElementById("password");
const credStatus = document.getElementById("credStatus");

chrome.storage.local.get("credentials", ({ credentials }) => {
  if (credentials?.userId) userIdInput.value = credentials.userId;
  if (credentials?.password) passwordInput.value = credentials.password;
});

document.getElementById("saveCreds").addEventListener("click", () => {
  const userId = userIdInput.value.trim();
  const password = passwordInput.value;
  if (!userId || !password) {
    credStatus.style.color = "var(--bad)";
    credStatus.textContent = "Enter both User Id and Password.";
    return;
  }
  chrome.storage.local.set({ credentials: { userId, password } }, () => {
    credStatus.style.color = "var(--good)";
    credStatus.textContent = "Saved.";
    setTimeout(() => (credStatus.textContent = ""), 1500);
  });
});

document.getElementById("clearCreds").addEventListener("click", () => {
  chrome.storage.local.remove("credentials", () => {
    userIdInput.value = "";
    passwordInput.value = "";
    credStatus.style.color = "var(--good)";
    credStatus.textContent = "Cleared.";
    setTimeout(() => (credStatus.textContent = ""), 1500);
  });
});

// ---------- Short leave ----------

const shortLeaveMinutesInput = document.getElementById("shortLeaveMinutesInput");
const shortLeaveStatus = document.getElementById("shortLeaveStatus");
const shortLeaveCountEl = document.getElementById("shortLeaves");
const decreaseBtn = document.getElementById("decreaseShortLeave");
const increaseBtn = document.getElementById("increaseShortLeave");

document.getElementById("saveShortLeaveMinutes").addEventListener("click", () => {
  const minutes = parseInt(shortLeaveMinutesInput.value.trim(), 10);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    shortLeaveStatus.style.color = "var(--bad)";
    shortLeaveStatus.textContent = "Enter a positive number of minutes.";
    return;
  }
  currentShortLeaveMinutes = minutes;
  chrome.storage.sync.set({ shortLeaveMinutes: minutes }, () => {
    shortLeaveStatus.style.color = "var(--good)";
    shortLeaveStatus.textContent = "Saved.";
    setTimeout(() => (shortLeaveStatus.textContent = ""), 1500);
    updateDisplay();
  });
});

function setShortLeaveCount(count) {
  currentShortLeaveCount = Math.max(0, count);
  shortLeaveCountEl.textContent = String(currentShortLeaveCount);
  chrome.storage.local.set({ shortLeaveCount: currentShortLeaveCount });
  updateDisplay();
}

decreaseBtn.addEventListener("click", () => setShortLeaveCount(currentShortLeaveCount - 1));
increaseBtn.addEventListener("click", () => setShortLeaveCount(currentShortLeaveCount + 1));

// ---------- Result display ----------

const getDetailsBtn = document.getElementById("getDetailsBtn");
const resultDiv = document.getElementById("result");

const ERROR_MESSAGES = {
  missing_credentials: "Save your User Id and Password above first.",
  login_form_not_found: "Couldn't find the login form — the homepage may have changed.",
  no_punch_found: "No punch found for today yet.",
};

function updateDisplay() {
  if (!currentRecord) {
    resultDiv.textContent = "No data fetched yet.";
    return;
  }

  const time = formatFetchedAt(currentRecord.fetchedAt);

  if (currentRecord.alreadyOut) {
    resultDiv.innerHTML = `Checked at ${time}: already clocked out at <span class="estimate">${currentRecord.outTimeText}</span>.`;
    return;
  }

  const adjustedMinutes =
    currentRecord.inTime +
    currentRequiredMinutes -
    currentShortLeaveMinutes * currentShortLeaveCount;

  const suffix = currentShortLeaveCount > 0
    ? ` (${currentShortLeaveCount} short leave${currentShortLeaveCount > 1 ? "s" : ""} applied)`
    : "";

  resultDiv.innerHTML = `Checked at ${time} <span class="estimate">Est. Out: ${minutesToHHMM(adjustedMinutes)}</span>${suffix}`;
}

// ---------- Load everything, then render once ----------

chrome.storage.sync.get(
  { requiredMinutes: DEFAULT_REQUIRED_MINUTES, shortLeaveMinutes: DEFAULT_SHORT_LEAVE_MINUTES },
  (settings) => {
    currentRequiredMinutes = settings.requiredMinutes;
    currentShortLeaveMinutes = settings.shortLeaveMinutes;
    hoursInput.value = minutesToHHMM(currentRequiredMinutes).slice(0, 5);
    shortLeaveMinutesInput.value = String(currentShortLeaveMinutes);

    chrome.storage.local.get({ lastResult: null, shortLeaveCount: 0 }, ({ lastResult, shortLeaveCount }) => {
      currentRecord = lastResult;
      currentShortLeaveCount = shortLeaveCount;
      shortLeaveCountEl.textContent = String(currentShortLeaveCount);
      updateDisplay();
    });
  }
);

getDetailsBtn.addEventListener("click", () => {
  getDetailsBtn.disabled = true;
  getDetailsBtn.textContent = "Fetching…";
  resultDiv.textContent = "Logging in and checking today's punch…";

  chrome.runtime.sendMessage({ action: "GET_DETAILS" }, (response) => {
    getDetailsBtn.disabled = false;
    getDetailsBtn.textContent = "Get Details";

    if (chrome.runtime.lastError) {
      resultDiv.innerHTML = `<span class="error">${chrome.runtime.lastError.message}</span>`;
      return;
    }
    if (!response?.ok) {
      const msg = ERROR_MESSAGES[response?.error] || response?.error || "Something went wrong.";
      resultDiv.innerHTML = `<span class="error">${msg}</span>`;
      return;
    }

    // New fetch = new day's data — start the short leave count fresh
    currentRecord = response.result;
    setShortLeaveCount(0);
    updateDisplay();
  });
});

// ---------- DTS filling ----------

const dtsEls = {
  submitAction: document.getElementById("dtsSubmit"),
  mode: document.getElementById("dtsMode"),
  date: document.getElementById("dtsDate"),
  maxHours: document.getElementById("dtsMaxHours"),
  project: document.getElementById("dtsProject"),
  module: document.getElementById("dtsModule"),
  activityType: document.getElementById("dtsActivityType"),
  activity: document.getElementById("dtsActivity"),
  status: document.getElementById("dtsStatus"),
};
const dtsRowsEl = document.getElementById("dtsRows");
const dtsErrorsEl = document.getElementById("dtsErrors");
const dtsResultEl = document.getElementById("dtsResult");
const fillDtsBtn = document.getElementById("fillDtsBtn");

const DTS_ERROR_MESSAGES = {
  missing_credentials: "Save your User Id and Password above first.",
  login_form_not_found: "Couldn't find the login form — the homepage may have changed.",
  it_services_link_not_found: "Couldn't find the IT Services link on the HRIS homepage.",
};

const DTS_FROM_OPTIONS = [
  ["time", "Custom time"],
  ["intime", "System in-time"],
  ["prev", "After previous"],
];
const DTS_TO_OPTIONS = [
  ["time", "Custom time"],
  ["outtime", "System out-time"],
  ["hours", "Length (hours)"],
];

function dtsReadRow(el) {
  return {
    fromType: el.querySelector(".fromType").value,
    from: el.querySelector(".from").value,
    gap: parseFloat(el.querySelector(".gap").value),
    toType: el.querySelector(".toType").value,
    to: el.querySelector(".to").value,
    hours: parseFloat(el.querySelector(".hours").value),
    comment: el.querySelector(".comment").value,
  };
}

function readDtsConfig() {
  return {
    submitAction: dtsEls.submitAction.value,
    mode: dtsEls.mode.value,
    date: dtsEls.date.value,
    maxHours: parseFloat(dtsEls.maxHours.value),
    project: dtsEls.project.value.trim(),
    module: dtsEls.module.value.trim(),
    activityType: dtsEls.activityType.value.trim(),
    activity: dtsEls.activity.value.trim(),
    status: dtsEls.status.value.trim(),
    rows: Array.from(dtsRowsEl.querySelectorAll(".dts-row")).map(dtsReadRow),
  };
}

function refreshDtsValidation() {
  const cfg = readDtsConfig();
  const office = cfg.mode === "office";
  const resolved = dtsResolveRows(dtsEffectiveRows(cfg), null, cfg.maxHours).rows;
  dtsRowsEl.querySelectorAll(".dts-row").forEach((el, i) => {
    const row = office ? cfg.rows[i] : { ...cfg.rows[i], fromType: "time", toType: "time" };
    // the source dropdowns only exist in office mode
    el.querySelector(".fromType").style.display = office ? "" : "none";
    el.querySelector(".toType").style.display = office ? "" : "none";
    // show only the input that matches each dropdown
    el.querySelector(".from").style.display = row.fromType === "time" ? "" : "none";
    el.querySelector(".gapWrap").style.display = row.fromType === "prev" ? "" : "none";
    el.querySelector(".to").style.display = row.toType === "time" ? "" : "none";
    el.querySelector(".hoursWrap").style.display = row.toType === "hours" ? "" : "none";

    const { fromMin, toMin } = resolved[i];
    const dur = el.querySelector(".dur");
    const known = fromMin !== null && toMin !== null;
    const d = known ? toMin - fromMin : null;
    dur.textContent = known
      ? d > 0 ? `${Math.floor(d / 60)}h ${String(d % 60).padStart(2, "0")}m` : "invalid"
      : "set at run time";
    dur.classList.toggle("bad", known && (d <= 0 || d > Math.round((cfg.maxHours || 0) * 60)));
  });
  const errors = dtsValidate(cfg);
  dtsErrorsEl.textContent = errors.join(" ");
  return { cfg, errors };
}

function dtsSelect(cls, options, value) {
  const sel = document.createElement("select");
  sel.className = cls;
  options.forEach(([v, label]) => sel.add(new Option(label, v)));
  sel.value = value;
  return sel;
}

function dtsInput(type, cls, value, extra = {}) {
  const input = document.createElement("input");
  input.type = type;
  input.className = cls;
  input.value = value ?? "";
  Object.assign(input, extra);
  return input;
}

function dtsLabeled(wrapCls, text, input) {
  const wrap = document.createElement("div");
  wrap.className = wrapCls;
  const lbl = document.createElement("span");
  lbl.className = "lbl";
  lbl.textContent = text;
  wrap.append(lbl, input);
  return wrap;
}

function addDtsRow(row) {
  const el = document.createElement("div");
  el.className = "dts-row";

  const fromCell = document.createElement("div");
  fromCell.className = "cell";
  fromCell.append(
    dtsSelect("fromType", DTS_FROM_OPTIONS, row.fromType || "time"),
    dtsInput("time", "from", row.from),
    dtsLabeled("gapWrap", "minutes after previous row", dtsInput("number", "gap", row.gap ?? 30, { min: 0, step: 5 }))
  );

  const toCell = document.createElement("div");
  toCell.className = "cell";
  toCell.append(
    dtsSelect("toType", DTS_TO_OPTIONS, row.toType || "time"),
    dtsInput("time", "to", row.to),
    dtsLabeled("hoursWrap", "hours long", dtsInput("number", "hours", row.hours ?? 4, { min: 0.5, step: 0.5 }))
  );

  const comment = dtsInput("text", "comment", row.comment, { placeholder: "Comment" });

  const dur = document.createElement("span");
  dur.className = "dur";
  const rm = document.createElement("button");
  rm.className = "rm";
  rm.textContent = "✕ Remove";
  rm.addEventListener("click", () => {
    el.remove();
    refreshDtsValidation();
  });
  const foot = document.createElement("div");
  foot.className = "foot";
  foot.append(dur, rm);

  el.append(fromCell, toCell, comment, foot);
  el.addEventListener("input", refreshDtsValidation);
  el.addEventListener("change", refreshDtsValidation);
  dtsRowsEl.appendChild(el);
}

function renderDtsConfig(cfg) {
  dtsEls.mode.value = cfg.mode || "wfh";
  dtsEls.submitAction.value = cfg.submitAction || "none";
  dtsEls.date.value = cfg.date || "";
  dtsEls.maxHours.value = cfg.maxHours;
  for (const k of ["project", "module", "activityType", "activity"]) dtsEls[k].value = cfg[k];
  dtsEls.status.value = /complete/i.test(cfg.status || "") ? "complete" : "progress";
  dtsRowsEl.textContent = "";
  cfg.rows.forEach(addDtsRow);
  refreshDtsValidation();
}

function saveDtsConfig() {
  return new Promise((resolve) => {
    const { cfg, errors } = refreshDtsValidation();
    if (errors.length) return resolve(false);
    chrome.storage.local.set({ dtsConfig: cfg }, () => resolve(true));
  });
}

function showDtsRun(run) {
  if (!run) {
    dtsResultEl.textContent = "";
    return;
  }
  const time = formatFetchedAt(run.at || new Date().toISOString());
  if (run.ok) {
    dtsResultEl.style.color = "var(--good)";
    const done = `added ${run.added} entr${run.added === 1 ? "y" : "ies"}`;
    dtsResultEl.textContent = run.submitted
      ? `${time} — ${done} and clicked "${run.submitted}". Check the DTS tab.`
      : `${time} — ${done}. Review and save in the DTS tab.`;
  } else {
    dtsResultEl.style.color = "var(--bad)";
    const msg = DTS_ERROR_MESSAGES[run.error] || run.detail || run.error || "Something went wrong.";
    dtsResultEl.textContent = `${time} — ${msg}`;
  }
}

document.getElementById("dtsAddRow").addEventListener("click", () => {
  const maxHours = parseFloat(dtsEls.maxHours.value) || 4;
  const cfg = readDtsConfig();
  const last = cfg.rows.at(-1);
  const lastTo = last && last.toType === "time" ? dtsToMin(last.to) : null;
  if (cfg.mode !== "office") {
    // WFH: plain times, 30 min after the previous row, for the maximum length
    const start = lastTo !== null ? lastTo + 30 : 9 * 60 + 30;
    addDtsRow({ fromType: "time", from: dtsFromMin(start), toType: "time", to: dtsFromMin(start + Math.round(maxHours * 60)), comment: "" });
    refreshDtsValidation();
    return;
  }
  // Office: "30 min after the previous row, for the maximum length"
  addDtsRow(
    last
      ? { fromType: "prev", gap: 30, toType: "hours", hours: maxHours, comment: "" }
      : { fromType: "time", from: "09:30", toType: "hours", hours: maxHours, comment: "" }
  );
  refreshDtsValidation();
});

document.getElementById("dtsSave").addEventListener("click", async () => {
  const ok = await saveDtsConfig();
  dtsResultEl.style.color = ok ? "var(--good)" : "var(--bad)";
  dtsResultEl.textContent = ok ? "Config saved." : "Fix the errors above first.";
  if (ok) setTimeout(() => (dtsResultEl.textContent = ""), 1500);
});

document.getElementById("dtsReset").addEventListener("click", () => {
  renderDtsConfig(DTS_DEFAULTS);
  chrome.storage.local.remove("dtsConfig");
});

Object.values(dtsEls).forEach((el) => el.addEventListener("input", refreshDtsValidation));

fillDtsBtn.addEventListener("click", async () => {
  if (!(await saveDtsConfig())) {
    dtsResultEl.style.color = "var(--bad)";
    dtsResultEl.textContent = "Fix the errors above first.";
    return;
  }
  fillDtsBtn.disabled = true;
  fillDtsBtn.textContent = "Filling… (keep this browser open)";
  dtsResultEl.style.color = "";
  dtsResultEl.textContent = "Logging in and opening DTS — this takes about a minute.";

  chrome.runtime.sendMessage({ action: "FILL_DTS" }, (response) => {
    fillDtsBtn.disabled = false;
    fillDtsBtn.textContent = "Fill DTS";
    if (chrome.runtime.lastError) {
      dtsResultEl.style.color = "var(--bad)";
      dtsResultEl.textContent = chrome.runtime.lastError.message;
      return;
    }
    showDtsRun({ ...response, at: new Date().toISOString() });
  });
});

chrome.storage.local.get({ dtsConfig: null, dtsLastRun: null }, ({ dtsConfig, dtsLastRun }) => {
  // Configs saved by older versions (global office/WFH mode) keep only their rows' plain times.
  const saved = dtsConfig && Array.isArray(dtsConfig.rows) ? dtsConfig : {};
  renderDtsConfig({ ...DTS_DEFAULTS, ...saved });
  showDtsRun(dtsLastRun);
});

// ---------- Tabs ----------

(function setupTabs() {
  const tabs = Array.from(document.querySelectorAll(".tab"));
  function show(panelId) {
    tabs.forEach((t) => t.setAttribute("aria-selected", String(t.dataset.panel === panelId)));
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === panelId));
    try { localStorage.setItem("lastTab", panelId); } catch (e) { /* storage unavailable */ }
  }
  tabs.forEach((t) => t.addEventListener("click", () => show(t.dataset.panel)));
  try {
    const last = localStorage.getItem("lastTab");
    if (last && document.getElementById(last)) show(last);
  } catch (e) { /* storage unavailable */ }
})();

// ---------- Notifications toggle ----------

(function setupNotifyToggle() {
  const toggle = document.getElementById("notifyToggle");
  chrome.storage.sync.get({ notifications: true }, ({ notifications }) => {
    toggle.checked = notifications;
  });
  toggle.addEventListener("change", () => chrome.storage.sync.set({ notifications: toggle.checked }));
})();

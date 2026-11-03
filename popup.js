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
    saveStatus.style.color = "#cc0000";
    saveStatus.textContent = "Enter time as HH:MM, e.g. 09:00";
    return;
  }
  currentRequiredMinutes = minutes;
  chrome.storage.sync.set({ requiredMinutes: minutes }, () => {
    saveStatus.style.color = "#007700";
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
    credStatus.style.color = "#cc0000";
    credStatus.textContent = "Enter both User Id and Password.";
    return;
  }
  chrome.storage.local.set({ credentials: { userId, password } }, () => {
    credStatus.style.color = "#007700";
    credStatus.textContent = "Saved.";
    setTimeout(() => (credStatus.textContent = ""), 1500);
  });
});

document.getElementById("clearCreds").addEventListener("click", () => {
  chrome.storage.local.remove("credentials", () => {
    userIdInput.value = "";
    passwordInput.value = "";
    credStatus.style.color = "#007700";
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
    shortLeaveStatus.style.color = "#cc0000";
    shortLeaveStatus.textContent = "Enter a positive number of minutes.";
    return;
  }
  currentShortLeaveMinutes = minutes;
  chrome.storage.sync.set({ shortLeaveMinutes: minutes }, () => {
    shortLeaveStatus.style.color = "#007700";
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
    resultDiv.innerHTML = `Checked at ${time} — already clocked out at <span class="estimate">${currentRecord.outTimeText}</span>.`;
    return;
  }

  const adjustedMinutes =
    currentRecord.inTime +
    currentRequiredMinutes -
    currentShortLeaveMinutes * currentShortLeaveCount;

  const suffix = currentShortLeaveCount > 0
    ? ` (${currentShortLeaveCount} short leave${currentShortLeaveCount > 1 ? "s" : ""} applied)`
    : "";

  resultDiv.innerHTML = `Checked at ${time} — <span class="estimate">Est. Out: ${minutesToHHMM(adjustedMinutes)}</span>${suffix}`;
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
  mode: document.getElementById("dtsMode"),
  startSource: document.getElementById("dtsStartSource"),
  customStart: document.getElementById("dtsCustomStart"),
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

function dtsDurationLabel(from, to) {
  const f = dtsToMin(from);
  const t = dtsToMin(to);
  if (f === null || t === null) return "";
  const d = t - f;
  if (d <= 0) return "invalid";
  return `${Math.floor(d / 60)}h ${String(d % 60).padStart(2, "0")}m`;
}

function readDtsConfig() {
  return {
    wfh: dtsEls.mode.value === "wfh",
    startSource: dtsEls.startSource.value,
    customStart: dtsEls.customStart.value,
    date: dtsEls.date.value,
    maxHours: parseFloat(dtsEls.maxHours.value),
    project: dtsEls.project.value.trim(),
    module: dtsEls.module.value.trim(),
    activityType: dtsEls.activityType.value.trim(),
    activity: dtsEls.activity.value.trim(),
    status: dtsEls.status.value.trim(),
    rows: Array.from(dtsRowsEl.querySelectorAll(".dts-row")).map((el) => ({
      from: el.querySelector(".from").value,
      to: el.querySelector(".to").value,
      comment: el.querySelector(".comment").value,
    })),
  };
}

function refreshDtsValidation() {
  const cfg = readDtsConfig();
  document.getElementById("dtsStartWrap").style.display = cfg.wfh ? "none" : "block";
  dtsEls.customStart.style.display = cfg.startSource === "custom" ? "block" : "none";
  const maxMinutes = Math.round((cfg.maxHours || 0) * 60);
  dtsRowsEl.querySelectorAll(".dts-row").forEach((el, i) => {
    const row = cfg.rows[i];
    const dur = el.querySelector(".dur");
    dur.textContent = dtsDurationLabel(row.from, row.to);
    const f = dtsToMin(row.from);
    const t = dtsToMin(row.to);
    dur.classList.toggle("bad", f !== null && t !== null && t - f > maxMinutes);
  });
  const errors = dtsValidate(cfg);
  dtsErrorsEl.textContent = errors.join(" ");
  return { cfg, errors };
}

function addDtsRow(row) {
  const el = document.createElement("div");
  el.className = "dts-row";

  const from = document.createElement("input");
  from.type = "time";
  from.className = "from";
  from.value = row.from || "";

  const to = document.createElement("input");
  to.type = "time";
  to.className = "to";
  to.value = row.to || "";

  const dur = document.createElement("span");
  dur.className = "dur";

  const comment = document.createElement("input");
  comment.type = "text";
  comment.className = "comment";
  comment.placeholder = "Comment";
  comment.value = row.comment || "";

  const rm = document.createElement("button");
  rm.className = "rm";
  rm.textContent = "✕";
  rm.title = "Remove row";
  rm.addEventListener("click", () => {
    el.remove();
    refreshDtsValidation();
  });

  [from, to, comment].forEach((i) => i.addEventListener("input", refreshDtsValidation));
  el.append(from, to, dur, comment, rm);
  dtsRowsEl.appendChild(el);
}

function renderDtsConfig(cfg) {
  dtsEls.mode.value = cfg.wfh ? "wfh" : "office";
  dtsEls.startSource.value = cfg.startSource;
  dtsEls.customStart.value = cfg.customStart || "";
  dtsEls.date.value = cfg.date || "";
  dtsEls.maxHours.value = cfg.maxHours;
  for (const k of ["project", "module", "activityType", "activity", "status"]) dtsEls[k].value = cfg[k];
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
    dtsResultEl.style.color = "#007700";
    dtsResultEl.textContent = `${time} — added ${run.added} entr${run.added === 1 ? "y" : "ies"}. Review and save in the DTS tab.`;
  } else {
    dtsResultEl.style.color = "#cc0000";
    const msg = DTS_ERROR_MESSAGES[run.error] || run.detail || run.error || "Something went wrong.";
    dtsResultEl.textContent = `${time} — ${msg}`;
  }
}

document.getElementById("dtsAddRow").addEventListener("click", () => {
  // Suggest the next slot: 30 min after the previous row, same length as it (at least the minimum)
  const rows = readDtsConfig().rows;
  const last = rows[rows.length - 1];
  const lastTo = last ? dtsToMin(last.to) : null;
  const maxMinutes = Math.round((parseFloat(dtsEls.maxHours.value) || 4) * 60);
  if (lastTo !== null) {
    const start = lastTo + 30;
    addDtsRow({ from: dtsFromMin(start), to: dtsFromMin(start + maxMinutes), comment: "" });
  } else {
    addDtsRow({ from: "09:30", to: dtsFromMin(9 * 60 + 30 + maxMinutes), comment: "" });
  }
  refreshDtsValidation();
});

document.getElementById("dtsSave").addEventListener("click", async () => {
  const ok = await saveDtsConfig();
  dtsResultEl.style.color = ok ? "#007700" : "#cc0000";
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
    dtsResultEl.style.color = "#cc0000";
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
      // Popup may have been closed/reopened mid-run; the last run is stored by the background.
      dtsResultEl.style.color = "#cc0000";
      dtsResultEl.textContent = chrome.runtime.lastError.message;
      return;
    }
    showDtsRun({ ...response, at: new Date().toISOString() });
  });
});

chrome.storage.local.get({ dtsConfig: null, dtsLastRun: null }, ({ dtsConfig, dtsLastRun }) => {
  renderDtsConfig({ ...DTS_DEFAULTS, ...(dtsConfig || {}) });
  showDtsRun(dtsLastRun);
});

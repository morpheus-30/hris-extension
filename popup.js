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

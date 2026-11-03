// Background service worker — drives the "Get Details" automation:
//   1. Open the HRIS homepage in a hidden (inactive) background tab.
//   2. Click "Sign in", fill in the saved User Id / Password, submit.
//   3. Click the "HRIS" dropdown link for real (native .click()), which
//      opens hrisyna.yamaha-motor.in in a new tab (target="_blank") and
//      lets that navigation's response set its own JSESSIONID cookie.
//      That new tab is immediately forced back to inactive so it doesn't
//      steal focus (which would otherwise close the extension popup).
//   4. Navigate that new tab to the attendance calendar page.
//   5. Scrape today's in-time (same logic as content.js).
//   6. Save the result to chrome.storage.local and close both tabs.
//
// Nothing here runs on its own — it only runs when the popup's
// "Get Details" button sends a GET_DETAILS message.
//
// NOTE: watch this flow in the SERVICE WORKER console, not the popup:
// chrome://extensions -> this extension -> "Inspect views: service worker"
// The popup can close mid-flow (e.g. if a new tab steals focus), which
// kills sendResponse, but these logs will still show you what happened.

importScripts("dts-common.js");

const HOMEPAGE_URL = "https://hris.yamaha-motor.in:3333/Pages/homepage.aspx";
const CALENDAR_URL = "https://hrisyna.yamaha-motor.in/hris/lmr/lmr03/initial";
const DEFAULT_REQUIRED_MINUTES = 8 * 60 + 30;
const TAB_TIMEOUT_MS = 20000;

function log(...args) {
  console.log("[GetDetails]", ...args);
}

function minutesToTime(mins) {
  mins = ((mins % 1440) + 1440) % 1440;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

function waitForTabComplete(tabId, timeoutMs = TAB_TIMEOUT_MS) {
  log(`waitForTabComplete: waiting on tab ${tabId}`);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      log(`waitForTabComplete: TIMED OUT on tab ${tabId}`);
      reject(new Error("Timed out waiting for the page to load."));
    }, timeoutMs);

    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        log(`waitForTabComplete: tab ${tabId} complete`);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);

    // In case the tab is already done loading by the time we attach
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) return;
      if (tab && tab.status === "complete" && !settled) {
        settled = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        log(`waitForTabComplete: tab ${tabId} was already complete`);
        resolve();
      }
    });
  });
}

// Waits for a *new* tab whose URL matches hrisyna, by diffing tab lists —
// more reliable than openerTabId, which can point to whatever tab was
// focused rather than the tab that actually ran the click.
async function waitForNewHrisTab(timeoutMs = TAB_TIMEOUT_MS) {
  const before = await chrome.tabs.query({});
  const beforeIds = new Set(before.map((t) => t.id));
  log("waitForNewHrisTab: snapshot before click has", beforeIds.size, "tabs");

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 200));
    const after = await chrome.tabs.query({});
    const candidate = after.find(
      (t) => !beforeIds.has(t.id) && t.url && t.url.includes("hrisyna.yamaha-motor.in")
    );
    if (candidate) {
      log("waitForNewHrisTab: found new tab", candidate.id, candidate.url);
      return candidate.id;
    }
    // Also catch tabs still on about:blank/loading before the URL resolves
    const pending = after.find((t) => !beforeIds.has(t.id));
    if (pending) {
      log("waitForNewHrisTab: new tab detected, waiting for its URL to resolve:", pending.id, pending.url);
    }
  }
  throw new Error("Timed out waiting for the HRIS tab to open.");
}

// ---- Injected into the homepage tab ----
function performLogin(userId, password) {
  return new Promise((resolve) => {
    console.log("[GetDetails][page] performLogin: starting");
    const openLink = document.querySelector("#openlogin");
    if (openLink) openLink.click();

    const start = Date.now();
    const timeoutMs = 5000;

    function tryFill() {
      const userField = document.querySelector("#UserName");
      const passField = document.querySelector("#Password");
      const loginBtn = document.querySelector("#LoginButton");

      if (userField && passField && loginBtn) {
        userField.value = userId;
        passField.value = password;
        userField.dispatchEvent(new Event("input", { bubbles: true }));
        passField.dispatchEvent(new Event("input", { bubbles: true }));
        userField.dispatchEvent(new Event("change", { bubbles: true }));
        passField.dispatchEvent(new Event("change", { bubbles: true }));
        console.log("[GetDetails][page] performLogin: fields found, submitting");
        loginBtn.click();
        resolve({ ok: true });
        return;
      }

      if (Date.now() - start < timeoutMs) {
        setTimeout(tryFill, 200);
      } else {
        console.log("[GetDetails][page] performLogin: fields NOT found, giving up");
        resolve({ ok: false, reason: "login_fields_not_found" });
      }
    }

    tryFill();
  });
}

// ---- Injected into the homepage tab, right after login succeeds ----
// Real native click on the "HRIS" dropdown link — lets onclick="UpdateCookieValue(this)"
// run exactly as the page author wired it, AND lets target="_blank" open a real new tab
// that navigates to hrisyna, whose own response sets the JSESSIONID cookie for that domain.
// Polls briefly because the dropdown link can render slightly after page "complete".
function clickHrisDropdownLink() {
  return new Promise((resolve) => {
    const start = Date.now();
    const timeoutMs = 5000;

    function tryFind() {
      console.log("[GetDetails][page] clickHrisDropdownLink: searching for link");
      const link = Array.from(document.querySelectorAll("a[href*='/hris/']")).find(
        (a) => a.textContent.trim().toUpperCase().includes("HRIS")
      );

      if (link) {
        console.log("[GetDetails][page] clickHrisDropdownLink: found link, href =", link.href);
        link.click(); // native anchor activation, not a synthetic MouseEvent
        resolve({ ok: true, href: link.href });
        return;
      }

      if (Date.now() - start < timeoutMs) {
        setTimeout(tryFind, 200);
      } else {
        console.log("[GetDetails][page] clickHrisDropdownLink: link NOT found after retries");
        resolve({ ok: false, reason: "hris_link_not_found" });
      }
    }

    tryFind();
  });
}

// ---- Injected into the calendar page — mirrors content.js's scraping logic ----
function extractAttendanceForInjection() {
  const MONTHS = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };

  function isToday(day, month, year) {
    const t = new Date();
    return day === t.getDate() && month === t.getMonth() && year === t.getFullYear();
  }

  function parseTimeToMinutes(text) {
    if (!text) return null;
    const m = text.replace(/\u00a0/g, " ").trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }

  function findTodayCell() {
    const t = new Date();
    const selector = `[onclick*="getDayDetails('${t.getDate()}','${t.getMonth() + 1}','${t.getFullYear()}')"]`;
    return document.querySelector(selector);
  }

  function readCalendarCell(cell) {
    const rows = cell.querySelectorAll("table tr");
    if (rows.length < 2) return { inTime: null, outTime: null };
    const inText = rows[0].querySelector("td")?.textContent || "";
    const outText = rows[1].querySelector("td")?.textContent || "";
    return { inTime: parseTimeToMinutes(inText), outTime: parseTimeToMinutes(outText) };
  }

  function parsePunch(text) {
    const match = text.trim().match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/);
    if (!match) return null;
    const [, d, mon, y, h, mi] = match;
    const month = MONTHS[mon.toLowerCase()];
    if (month === undefined) return null;
    return {
      day: parseInt(d, 10),
      month,
      year: parseInt(y, 10),
      minutesOfDay: parseInt(h, 10) * 60 + parseInt(mi, 10),
    };
  }

  function findPunchWidget() {
    const boldCells = Array.from(document.querySelectorAll("td b")).filter((b) =>
      /\d{1,2}-[A-Za-z]{3}-\d{4}\s+\d{1,2}:\d{2}:\d{2}/.test(b.textContent)
    );
    if (boldCells.length === 0) return null;
    const punches = boldCells
      .map((b) => {
        const p = parsePunch(b.textContent);
        return p ? { ...p } : null;
      })
      .filter(Boolean);
    if (punches.length === 0) return null;
    punches.sort(
      (a, b) =>
        new Date(b.year, b.month, b.day, 0, b.minutesOfDay) -
        new Date(a.year, a.month, a.day, 0, a.minutesOfDay)
    );
    const latest = punches[0];
    if (!isToday(latest.day, latest.month, latest.year)) return null;
    return { inTime: latest.minutesOfDay };
  }

  console.log("[GetDetails][page] extractAttendanceForInjection: scraping calendar page");

  const cell = findTodayCell();
  if (cell) {
    const { inTime, outTime } = readCalendarCell(cell);
    if (inTime !== null || outTime !== null) {
      console.log("[GetDetails][page] extractAttendanceForInjection: found via cell", { inTime, outTime });
      return { kind: "cell", inTime, outTime };
    }
  }

  const widget = findPunchWidget();
  if (widget) {
    console.log("[GetDetails][page] extractAttendanceForInjection: found via widget", widget);
    return { kind: "widget", inTime: widget.inTime, outTime: null };
  }

  console.log("[GetDetails][page] extractAttendanceForInjection: nothing found");
  return null;
}

async function runGetDetails() {
  log("runGetDetails: starting");

  const { credentials } = await chrome.storage.local.get("credentials");
  if (!credentials?.userId || !credentials?.password) {
    log("runGetDetails: missing credentials");
    return { ok: false, error: "missing_credentials" };
  }

  let tab;
  let hrisTabId;
  try {
    log("runGetDetails: opening homepage tab", HOMEPAGE_URL);
    tab = await chrome.tabs.create({ url: HOMEPAGE_URL, active: false });
    log("runGetDetails: homepage tab created, id =", tab.id);
    await waitForTabComplete(tab.id);

    log("runGetDetails: injecting performLogin");
    const [loginRun] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: performLogin,
      args: [credentials.userId, credentials.password],
    });
    log("runGetDetails: performLogin result =", loginRun?.result);

    if (!loginRun?.result?.ok) {
      return { ok: false, error: "login_form_not_found" };
    }

    // Login is a full-page postback — wait for the reload it triggers
    await waitForTabComplete(tab.id);
    log("runGetDetails: post-login reload complete");

    // Click the real "HRIS" dropdown link. This lets UpdateCookieValue(this) run
    // as the page intends AND opens hrisyna in a new tab via target="_blank",
    // so hrisyna's own response sets its JSESSIONID cookie the normal way.
    // Click the real "HRIS" dropdown link. This lets UpdateCookieValue(this) run
    // as the page intends AND opens hrisyna in a new tab via target="_blank",
    // so hrisyna's own response sets its JSESSIONID cookie the normal way.
    //
    // On a cold service-worker start (first run after idle), this injection can
    // occasionally return null instead of our resolved object — retry once.
    let clickRun;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const newTabPromise = waitForNewHrisTab();

      log(`runGetDetails: injecting clickHrisDropdownLink (attempt ${attempt})`);
      [clickRun] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: clickHrisDropdownLink,
      });
      log("runGetDetails: clickHrisDropdownLink result =", clickRun?.result);

      if (clickRun?.result?.ok) {
        hrisTabId = await newTabPromise;
        break;
      }

      if (attempt === 2) {
        return { ok: false, error: "hris_link_not_found", detail: clickRun?.result };
      }

      log("runGetDetails: click attempt failed, retrying shortly");
      await new Promise((r) => setTimeout(r, 500));
    }

    log("runGetDetails: new HRIS tab id =", hrisTabId);

    try {
      await chrome.tabs.update(hrisTabId, { active: false });
      const [activeNow] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      log("runGetDetails: forced HRIS tab inactive; currently active tab is", activeNow?.id, activeNow?.url);
    } catch (e) {
      log("runGetDetails: failed to set HRIS tab inactive:", e?.message || e);
    }

    await waitForTabComplete(hrisTabId);
    log("runGetDetails: HRIS tab finished initial load");

    // Now drive the NEW tab (this is where the hrisyna session cookie lives)
    log("runGetDetails: navigating HRIS tab to calendar", CALENDAR_URL);
    await chrome.tabs.update(hrisTabId, { url: CALENDAR_URL });
    await waitForTabComplete(hrisTabId);
    log("runGetDetails: calendar page loaded");

    log("runGetDetails: injecting extractAttendanceForInjection");
    const [scrapeRun] = await chrome.scripting.executeScript({
      target: { tabId: hrisTabId },
      func: extractAttendanceForInjection,
    });
    log("runGetDetails: scrape result =", scrapeRun?.result);

    const attendance = scrapeRun?.result;
    if (!attendance || attendance.inTime === null) {
      return { ok: false, error: "no_punch_found" };
    }

    const { requiredMinutes } = await chrome.storage.sync.get({
      requiredMinutes: DEFAULT_REQUIRED_MINUTES,
    });

    const record = {
      fetchedAt: new Date().toISOString(),
      inTime: attendance.inTime,
      outTime: attendance.outTime,
      alreadyOut: attendance.outTime !== null,
      estimateText:
        attendance.outTime === null ? minutesToTime(attendance.inTime + requiredMinutes) : null,
      outTimeText: attendance.outTime !== null ? minutesToTime(attendance.outTime) : null,
    };

    log("runGetDetails: final record =", record);
    await chrome.storage.local.set({ lastResult: record });
    return { ok: true, result: record };
  } catch (e) {
    log("runGetDetails: ERROR", e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  } finally {
    log("runGetDetails: cleaning up tabs", { tabId: tab?.id, hrisTabId });
    if (tab?.id) chrome.tabs.remove(tab.id).catch(() => { });
    if (hrisTabId) chrome.tabs.remove(hrisTabId).catch(() => { });
  }
}

// =====================================================================
// DTS (Daily Time Sheet) auto-fill
//   1. Log in on the homepage (hidden tab), click the "IT Services" link
//      (opens a new tab on hrisyna).
//   2. In that tab click the clock icon (changeModule?moduleCd=901) to open
//      the DTS form.
//   3. Fill the form in the page's MAIN world (the form's own JS helpers
//      such as showduration() are only reachable from there) and leave the
//      tab open and focused so the result can be reviewed and saved.
// The final Save/Submit is intentionally NOT clicked.
// =====================================================================

const DTS_LINK_SELECTOR = "a[href*='changeModule?moduleCd=901']";

// ---- Injected into the homepage tab ----
function clickHomepageLinkByText(needle) {
  return new Promise((resolve) => {
    const start = Date.now();
    function tryFind() {
      const link = Array.from(document.querySelectorAll("a")).find((a) =>
        a.textContent.trim().toUpperCase().includes(needle)
      );
      if (link) {
        link.click();
        resolve({ ok: true, href: link.href });
      } else if (Date.now() - start < 5000) {
        setTimeout(tryFind, 200);
      } else {
        resolve({ ok: false, reason: "link_not_found" });
      }
    }
    tryFind();
  });
}

// ---- Injected into the IT Services tab ----
function clickDtsLink(selector) {
  return new Promise((resolve) => {
    const start = Date.now();
    function tryFind() {
      const link = document.querySelector(selector);
      if (link) {
        link.click();
        resolve({ ok: true, href: link.href });
      } else if (Date.now() - start < 5000) {
        setTimeout(tryFind, 200);
      } else {
        resolve({ ok: false, reason: "dts_link_not_found" });
      }
    }
    tryFind();
  });
}

function dtsFormPresent() {
  return Boolean(document.getElementById("resultModel.applyDate"));
}

// ---- Injected into the DTS tab (world: MAIN). Must be self-contained. ----
async function fillDtsInPage(cfg) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const matches = (text, needle) => (text || "").toLowerCase().includes(needle.toLowerCase());
  const trigger = (el) => el.dispatchEvent(new Event("change", { bubbles: true }));
  const call = (name, ...args) => {
    try {
      if (typeof window[name] === "function") window[name](...args);
    } catch (e) {
      console.warn("[DTS fill]", name, "failed:", e);
    }
  };
  const waitFor = async (fn, timeoutMs = 8000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const v = fn();
      if (v) return v;
      await sleep(200);
    }
    return null;
  };
  const to12h = (mins) => {
    const h24 = Math.floor(mins / 60) % 24;
    const m = mins % 60;
    return `${String(h24 % 12 || 12).padStart(2, "0")}:${String(m).padStart(2, "0")} ${h24 >= 12 ? "PM" : "AM"}`;
  };
  const from12h = (text) => {
    const m = (text || "").match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const ap = m[3].toUpperCase();
    if (ap === "PM" && h !== 12) h += 12;
    if (ap === "AM" && h === 12) h = 0;
    return h * 60 + parseInt(m[2], 10);
  };

  async function pick(id, needle, label, hooks) {
    const opt = await waitFor(() => {
      const sel = document.getElementById(id);
      return sel && Array.from(sel.options).find((o) => matches(o.text, needle));
    });
    if (!opt) throw new Error(`No "${needle}" option found for ${label}.`);
    const sel = document.getElementById(id);
    sel.value = opt.value;
    trigger(sel);
    // A trailing ":" means "call with no arguments" (as the original script did)
    hooks.forEach((name) => (name.endsWith(":") ? call(name.slice(0, -1)) : call(name, sel)));
    await sleep(1500); // let dependent dropdowns load via AJAX
  }

  function findStatusRadio() {
    const radios = Array.from(document.querySelectorAll('input[type="radio"]')).filter(
      (r) => (r.id || "").startsWith("resultModel.status") || (r.name || "").includes("status")
    );
    for (const radio of radios) {
      let text = "";
      if (radio.id) {
        const lbl = document.querySelector(`label[for="${radio.id}"]`);
        if (lbl) text += " " + lbl.textContent;
      }
      if (radio.closest("label")) text += " " + radio.closest("label").textContent;
      if (radio.nextSibling && radio.nextSibling.textContent) text += " " + radio.nextSibling.textContent;
      text += " " + (radio.value || "");
      if (matches(text, cfg.status)) return radio;
    }
    return document.getElementById("resultModel.status2");
  }

  let offset = 0;
  function setTimes(fromMin, toMin, withDuration = true) {
    const f = document.getElementById("timepicker1");
    const t = document.getElementById("timepicker2");
    if (!f || !t) throw new Error("Time fields not found.");
    if (!Number.isFinite(fromMin) || !Number.isFinite(toMin)) {
      throw new Error(
        `Invalid row times (${fromMin} - ${toMin}). Debug: ${JSON.stringify({ wfh: cfg.wfh, customStartMin: cfg.customStartMin, offset, rows: cfg.rows })}`
      );
    }
    f.value = to12h(fromMin);
    t.value = to12h(toMin);
    if (withDuration) call("showduration");
  }
  const timesIntact = (fromMin, toMin) => {
    const f = document.getElementById("timepicker1").value;
    const t = document.getElementById("timepicker2").value;
    return f === to12h(fromMin) && t === to12h(toMin);
  };

  try {
    // Date (also triggers the lookup of the system in-time / out-time)
    const dateField = document.getElementById("resultModel.applyDate");
    if (!dateField) throw new Error("DTS form not found on this page.");
    if (cfg.date) {
      dateField.value = cfg.date;
    } else {
      const d = new Date();
      dateField.value = `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
    }
    call("searchDtsInTimeOutTime", dateField);
    await sleep(2500);

    // Office mode: shift every row so the first one starts at the system in-time
    // (or at the user-defined start time)
    offset = 0;
    if (!cfg.wfh) {
      let startMin = cfg.customStartMin;
      if (typeof startMin !== "number" || !Number.isFinite(startMin)) { // null/undefined = use system in-time
        // Same as the original script: read the in-time the form loads for the date
        await waitFor(() => from12h((document.getElementById("resultModel.inTime") || {}).value) !== null);
        startMin = from12h((document.getElementById("resultModel.inTime") || {}).value);
        if (startMin === null || !Number.isFinite(startMin)) throw new Error("Office mode needs a system in-time, but none was found for this date.");
      }
      offset = startMin - cfg.rows[0].fromMin;
    }

    let added = 0;
    for (const row of cfg.rows) {
      const fromMin = row.fromMin + offset;
      const toMin = row.toMin + offset;

      setTimes(fromMin, toMin);
      await sleep(1000); // same breathing room the original console script had
      await pick("resultModel.project", cfg.project, "Project", [
        "setHiddentoBlank:", "searchModuleMapAjax", "searchActivityTypeMapAjax", "setProject",
      ]);
      await pick("resultModel.module", cfg.module, "Module", ["setModule"]);
      await pick("resultModel.activityType", cfg.activityType, "Type of Activity", [
        "setActivityType", "setCrList", "searchActivityDescMapAjax",
      ]);
      await pick("resultModel.activity", cfg.activity, "Activity Code & Desc", ["setRequestDescription"]);

      const radio = findStatusRadio();
      if (radio) {
        radio.checked = true;
        trigger(radio);
        call("setStatusHidden", radio);
      }
      const comments = document.getElementById("resultModel.comments");
      if (comments) comments.value = row.comment || "";

      // The dropdown handlers can overwrite the time fields (seen as "12:NaN AM").
      // Re-assert them if so, without calling showduration() again, then verify.
      if (!timesIntact(fromMin, toMin)) {
        console.warn("[DTS fill] time fields were changed by the page, re-setting them");
        setTimes(fromMin, toMin, false);
      }
      await sleep(1000);
      if (!timesIntact(fromMin, toMin)) {
        const f = document.getElementById("timepicker1").value;
        const t = document.getElementById("timepicker2").value;
        throw new Error(`Row ${added + 1}: the page changed the time fields to "${f} - ${t}"; not adding the entry.`);
      }

      const addBtn = document.getElementById("addEntry");
      if (!addBtn || addBtn.style.display === "none") {
        throw new Error(`Add Entry button not available for row ${added + 1}.`);
      }
      addBtn.click();
      added++;
      await sleep(3000); // let the entry be added and the form reset
    }
    return { ok: true, added };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function findDtsTab(candidateIds, beforeIds, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tabs = await chrome.tabs.query({});
    const ids = tabs
      .filter((t) => candidateIds.includes(t.id) || (!beforeIds.has(t.id) && (t.url || "").includes("hrisyna.yamaha-motor.in")))
      .map((t) => t.id);
    for (const id of ids) {
      try {
        const [r] = await chrome.scripting.executeScript({ target: { tabId: id }, func: dtsFormPresent });
        if (r?.result) return id;
      } catch (e) {
        // tab mid-navigation or not scriptable yet
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Timed out waiting for the DTS form to open.");
}

async function runFillDts() {
  log("runFillDts: starting");

  const { credentials } = await chrome.storage.local.get("credentials");
  if (!credentials?.userId || !credentials?.password) return { ok: false, error: "missing_credentials" };

  const { dtsConfig } = await chrome.storage.local.get("dtsConfig");
  const cfg = { ...DTS_DEFAULTS, ...(dtsConfig || {}) };
  const problems = dtsValidate(cfg);
  if (problems.length) return { ok: false, error: "invalid_config", detail: problems.join(" ") };

  // A long-running injected script doesn't count as activity for the service
  // worker's idle timer, so ping an extension API while we work.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);

  let homeTab;
  let itTabId;
  let dtsTabId;
  let keepDtsTab = false;
  try {
    homeTab = await chrome.tabs.create({ url: HOMEPAGE_URL, active: false });
    await waitForTabComplete(homeTab.id);

    const [loginRun] = await chrome.scripting.executeScript({
      target: { tabId: homeTab.id },
      func: performLogin,
      args: [credentials.userId, credentials.password],
    });
    if (!loginRun?.result?.ok) return { ok: false, error: "login_form_not_found" };
    await waitForTabComplete(homeTab.id);

    // Step 1: "IT Services" link -> new hrisyna tab
    for (let attempt = 1; attempt <= 2 && !itTabId; attempt++) {
      const newTabPromise = waitForNewHrisTab();
      newTabPromise.catch(() => {});
      const [click] = await chrome.scripting.executeScript({
        target: { tabId: homeTab.id },
        func: clickHomepageLinkByText,
        args: ["IT SERVICE"],
      });
      log("runFillDts: IT Services click =", click?.result);
      if (click?.result?.ok) {
        itTabId = await newTabPromise;
      } else if (attempt === 2) {
        return { ok: false, error: "it_services_link_not_found" };
      } else {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    await chrome.tabs.update(itTabId, { active: false }).catch(() => {});
    await waitForTabComplete(itTabId);

    // Step 2: the clock icon -> DTS form (same tab or a new one)
    const before = new Set((await chrome.tabs.query({})).map((t) => t.id));
    const [dtsClick] = await chrome.scripting.executeScript({
      target: { tabId: itTabId },
      func: clickDtsLink,
      args: [DTS_LINK_SELECTOR],
    });
    log("runFillDts: DTS link click =", dtsClick?.result);
    if (!dtsClick?.result?.ok) {
      // Fall back to navigating straight to the module switch URL
      const itTab = await chrome.tabs.get(itTabId);
      const origin = new URL(itTab.url).origin;
      await chrome.tabs.update(itTabId, { url: origin + "/smsexternal/changeModule?moduleCd=901" });
    }

    dtsTabId = await findDtsTab([itTabId], before);
    log("runFillDts: DTS tab =", dtsTabId);
    keepDtsTab = true; // from here on the user may want to see the tab, even on failure
    await chrome.tabs.update(dtsTabId, { active: true });
    await new Promise((r) => setTimeout(r, 1000));

    const [fillRun] = await chrome.scripting.executeScript({
      target: { tabId: dtsTabId },
      world: "MAIN",
      func: fillDtsInPage,
      args: [
        {
          wfh: cfg.wfh,
          customStartMin: cfg.startSource === "custom" ? dtsToMin(cfg.customStart) : null,
          date: dtsDateLabel(cfg.date),
          project: cfg.project,
          module: cfg.module,
          activityType: cfg.activityType,
          activity: cfg.activity,
          status: cfg.status,
          rows: cfg.rows.map((r) => ({ fromMin: dtsToMin(r.from), toMin: dtsToMin(r.to), comment: r.comment })),
        },
      ],
    });
    log("runFillDts: fill result =", fillRun?.result);
    return fillRun?.result || { ok: false, error: "Fill script returned nothing." };
  } catch (e) {
    log("runFillDts: ERROR", e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  } finally {
    clearInterval(keepAlive);
    if (homeTab?.id) chrome.tabs.remove(homeTab.id).catch(() => {});
    if (itTabId && itTabId !== dtsTabId) chrome.tabs.remove(itTabId).catch(() => {});
    if (dtsTabId && !keepDtsTab) chrome.tabs.remove(dtsTabId).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action === "GET_DETAILS") {
    log("onMessage: GET_DETAILS received");
    runGetDetails()
      .then((result) => {
        log("onMessage: sending response", result);
        sendResponse(result);
      })
      .catch((e) => {
        log("onMessage: unexpected error", e?.message || e);
        sendResponse({ ok: false, error: e?.message || String(e) });
      });
    return true; // keep the message channel open for the async response
  }
  if (message?.action === "FILL_DTS") {
    log("onMessage: FILL_DTS received");
    runFillDts()
      .then(async (result) => {
        await chrome.storage.local.set({ dtsLastRun: { at: new Date().toISOString(), ...result } });
        sendResponse(result);
      })
      .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
    return true;
  }
  return false;
});
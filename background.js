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
  return false;
});
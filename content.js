// Estimated Out Time — content script
//
// PRIMARY SOURCE: the calendar's day cells look like:
//   <td onclick="getDayDetails('7','8','2026')">
//     <button ...>
//       <table><tbody>
//         <tr><td>IN-TIME</td> <td>DAY-NUM</td></tr>
//         <tr><td>OUT-TIME</td><td>STATUS</td></tr>
//         <tr><td>WORKED-HRS</td><td>OT/SHORTFALL</td></tr>
//       </tbody></table>
//     </button>
//   </td>
//
// FALLBACK SOURCE: if today's cell can't be found or has no in-time yet
// (e.g. the calendar hasn't refreshed, or the widget isn't on this page),
// fall back to the "last punch" widget:
//   <div class="col-md-3">
//     <table><tbody>
//       <tr>
//         <td><b>22-Sep-2026 19:05:00</b></td>
//         <td><b>23-Sep-2026 10:37:00</b></td>
//       </tr>
//     </tbody></table>
//   </div>
// Both cells are read and sorted chronologically rather than assumed to be
// in a fixed order. If the most recent of the two is dated today, it's
// treated as an open in-punch (you're still clocked in).
//
// Either way: if there's an in-time for today with no matching out-time yet,
// the script shows "in-time + required duration" as a small badge.

(function () {
  const DEFAULT_REQUIRED_MINUTES = 8 * 60 + 30; 
  const MONTHS = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };

  function today() {
    return new Date();
  }

  function isToday(day, month, year) {
    const t = today();
    return day === t.getDate() && month === t.getMonth() && year === t.getFullYear();
  }

  function minutesToTime(mins) {
    mins = ((mins % 1440) + 1440) % 1440; // wrap past midnight, just in case
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
  }
  
  // ---------- Primary source: calendar cell ----------

  function parseTimeToMinutes(text) {
    if (!text) return null;
    const match = text.replace(/\u00a0/g, " ").trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
  }

  function findTodayCell() {
    const t = today();
    const selector = `[onclick*="getDayDetails('${t.getDate()}','${t.getMonth() + 1}','${t.getFullYear()}')"]`;
    return document.querySelector(selector);
  }

  function readCalendarCell(cell) {
    const rows = cell.querySelectorAll("table tr");
    if (rows.length < 2) return { inTime: null, outTime: null };
    const inCellText = rows[0].querySelector("td")?.textContent || "";
    const outCellText = rows[1].querySelector("td")?.textContent || "";
    return {
      inTime: parseTimeToMinutes(inCellText),
      outTime: parseTimeToMinutes(outCellText),
    };
  }

  // ---------- Fallback source: last-punch widget ----------

  function parsePunch(text) {
    const match = text
      .trim()
      .match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/);
    if (!match) return null;
    const [, dayStr, monStr, yearStr, hStr, mStr] = match;
    const month = MONTHS[monStr.toLowerCase()];
    if (month === undefined) return null;
    const day = parseInt(dayStr, 10);
    const year = parseInt(yearStr, 10);
    return {
      day,
      month,
      year,
      minutesOfDay: parseInt(hStr, 10) * 60 + parseInt(mStr, 10),
    };
  }

  function findPunchWidget() {
    const boldCells = Array.from(document.querySelectorAll("td b")).filter((b) =>
      /\d{1,2}-[A-Za-z]{3}-\d{4}\s+\d{1,2}:\d{2}:\d{2}/.test(b.textContent)
    );
    if (boldCells.length === 0) return null;

    const punches = boldCells
      .map((b) => {
        const parsed = parsePunch(b.textContent);
        return parsed ? { ...parsed, td: b.closest("td") } : null;
      })
      .filter(Boolean);
    if (punches.length === 0) return null;

    // Most recent punch first
    punches.sort((a, b) => {
      const da = new Date(a.year, a.month, a.day, 0, a.minutesOfDay);
      const db = new Date(b.year, b.month, b.day, 0, b.minutesOfDay);
      return db - da;
    });

    const latest = punches[0];
    if (!isToday(latest.day, latest.month, latest.year)) return null;

    const table = latest.td.closest("table");
    const container = table?.closest(".col-md-3") || table?.parentElement || table;
    if (!container) return null;

    return { container, inTime: latest.minutesOfDay };
  }

  // ---------- Badge injection ----------

  function injectCellBadge(cell, estimateText) {
    const button = cell.querySelector("button");
    if (!button) return;
    let badge = button.querySelector(".est-out-badge");
    if (!badge) {
      badge = document.createElement("div");
      badge.className = "est-out-badge";
      button.appendChild(badge);
    }
    badge.textContent = `Est. Out: ${estimateText}`;
  }

  function injectWidgetBadge(container, estimateText) {
    let badge = container.querySelector(".est-out-fallback-badge");
    if (!badge) {
      badge = document.createElement("div");
      badge.className = "est-out-fallback-badge";
      container.appendChild(badge);
    }
    badge.textContent = `Estimated Out: ${estimateText}`;
  }

  function clearAllBadges() {
    document.querySelectorAll(".est-out-badge, .est-out-fallback-badge").forEach((el) => el.remove());
  }

  // ---------- Orchestration ----------

  function getTodayAttendance() {
    const cell = findTodayCell();
    if (cell) {
      const { inTime, outTime } = readCalendarCell(cell);
      if (inTime !== null || outTime !== null) {
        return { kind: "cell", target: cell, inTime, outTime };
      }
      // Cell exists but has no times yet — fall through to the punch widget
    }

    const widget = findPunchWidget();
    if (widget) {
      return { kind: "widget", target: widget.container, inTime: widget.inTime, outTime: null };
    }

    return null;
  }

  // The extension gets a fresh "context" every time it's reloaded/updated in
  // chrome://extensions. A tab that was already open is still running the
  // *old* script, whose chrome.* calls now throw "Extension context
  // invalidated." That's expected — it just means this tab needs a refresh
  // to pick up the new version — so we detect it and shut ourselves down
  // quietly instead of letting the error repeat every minute.

  let stopped = false;
  let observer = null;
  let intervalId = null;

  function isContextValid() {
    try {
      return Boolean(chrome?.runtime?.id);
    } catch (e) {
      return false;
    }
  }

  function shutdown() {
    if (stopped) return;
    stopped = true;
    if (observer) observer.disconnect();
    if (intervalId) clearInterval(intervalId);
  }

  function run() {
    if (stopped) return;
    if (!isContextValid()) {
      shutdown();
      return;
    }

    try {
      chrome.storage.sync.get({ requiredMinutes: DEFAULT_REQUIRED_MINUTES }, (settings) => {
        if (chrome.runtime.lastError || !isContextValid()) {
          shutdown();
          return;
        }

        const attendance = getTodayAttendance();

        if (!attendance || attendance.inTime === null || attendance.outTime !== null) {
          clearAllBadges();
          return;
        }

        const estimateText = minutesToTime(attendance.inTime + settings.requiredMinutes);
        if (attendance.kind === "cell") {
          injectCellBadge(attendance.target, estimateText);
        } else {
          injectWidgetBadge(attendance.target, estimateText);
        }
      });
    } catch (e) {
      // Thrown synchronously if the context was invalidated mid-call
      shutdown();
    }
  }

  run();

  // The page likely re-renders parts of this via AJAX — reapply when it does
  observer = new MutationObserver(() => run());
  observer.observe(document.body, { childList: true, subtree: true });

  // Also refresh periodically in case settings change or data loads late
  intervalId = setInterval(run, 60 * 1000);

  // React immediately if the user changes the required-hours setting
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (!isContextValid()) {
        shutdown();
        return;
      }
      if (area === "sync" && changes.requiredMinutes) run();
    });
  } catch (e) {
    shutdown();
  }
})();

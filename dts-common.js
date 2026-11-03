// Shared by popup.js (via <script>) and background.js (via importScripts).
// Everything is prefixed "dts" / "DTS" to avoid clashing with names in those files.

const DTS_DEFAULTS = {
  wfh: true, // true: use the row times as-is. false: shift rows so row 1 starts at the system in-time.
  startSource: "intime", // office mode only: "intime" (system in-time) or "custom"
  customStart: "09:30", // used when startSource is "custom"
  date: "", // "" = today, otherwise "YYYY-MM-DD" (from <input type="date">)
  maxHours: 4, // maximum duration of a single row, in hours
  project: "YME",
  module: "SAP",
  activityType: "Coding",
  activity: "Coding",
  status: "progress", // matches the "Work In Progress" radio
  rows: [
    { from: "09:30", to: "13:30", comment: "Coursera" },
    { from: "14:00", to: "17:00", comment: "Handover Call and EHC Dashboard changes" },
  ],
};

function dtsToMin(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec((hhmm || "").trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

function dtsFromMin(mins) {
  mins = ((mins % 1440) + 1440) % 1440;
  return String(Math.floor(mins / 60)).padStart(2, "0") + ":" + String(mins % 60).padStart(2, "0");
}

// "2026-11-02" -> "02/11/2026" (the format the DTS form expects); "" stays "" (= today)
function dtsDateLabel(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

// Returns a list of human-readable problems; empty list = valid.
function dtsValidate(cfg) {
  const errors = [];
  const maxMinutes = Math.round((Number(cfg.maxHours) || 0) * 60);

  if (!Array.isArray(cfg.rows) || cfg.rows.length === 0) {
    return ["Add at least one time row."];
  }
  if (cfg.date && !dtsDateLabel(cfg.date)) errors.push("Date is invalid.");
  for (const key of ["project", "module", "activityType", "activity", "status"]) {
    if (!String(cfg[key] || "").trim()) errors.push(`"${key}" match text can't be empty.`);
  }

  if (!cfg.wfh && cfg.startSource === "custom" && dtsToMin(cfg.customStart) === null) {
    errors.push("Enter a valid custom start time.");
  }

  let prevTo = null;
  cfg.rows.forEach((row, i) => {
    const n = i + 1;
    const from = dtsToMin(row.from);
    const to = dtsToMin(row.to);
    if (from === null || to === null) {
      errors.push(`Row ${n}: enter both From and To times.`);
      return;
    }
    if (to <= from) {
      errors.push(`Row ${n}: To must be after From.`);
    } else if (to - from > maxMinutes) {
      errors.push(`Row ${n}: can't be longer than ${cfg.maxHours} hour(s).`);
    }
    if (prevTo !== null && from < prevTo) {
      errors.push(`Row ${n}: starts before row ${n - 1} ends.`);
    }
    prevTo = to;
  });
  return errors;
}

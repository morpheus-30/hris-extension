// Shared by popup.js (via <script>) and background.js (via importScripts).
// Everything is prefixed "dts" / "DTS" to avoid clashing with names in those files.
//
// A row looks like:
//   { fromType: "time" | "intime" | "prev", from: "HH:MM", gap: 30,
//     toType:   "time" | "outtime" | "hours", to: "HH:MM", hours: 4,
//     comment: "..." }
//  fromType "time"   -> use `from`
//  fromType "intime" -> the in-time the DTS form shows for the date
//  fromType "prev"   -> `gap` minutes after the previous row ends
//  toType   "time"   -> use `to`
//  toType   "outtime"-> the out-time the DTS form shows for the date
//  toType   "hours"  -> `hours` after this row's From

const DTS_DEFAULTS = {
  mode: "wfh", // "wfh": rows use plain custom times. "office": rows may use system in/out-time, gaps, durations.
  date: "", // "" = today, otherwise "YYYY-MM-DD" (from <input type="date">)
  maxHours: 4, // maximum duration of a single row, in hours
  project: "YME",
  module: "SAP",
  activityType: "Coding",
  activity: "Coding",
  status: "progress", // matches the "Work In Progress" radio
  rows: [
    { fromType: "time", from: "09:30", toType: "time", to: "13:30", hours: 4, gap: 30, comment: "Coursera" },
    { fromType: "time", from: "14:00", toType: "time", to: "17:00", hours: 3, gap: 30, comment: "Handover Call and EHC Dashboard changes" },
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

// In WFH mode every row is a plain custom From/To time, whatever was picked in office mode.
function dtsEffectiveRows(cfg) {
  if (cfg.mode === "office") return cfg.rows;
  return cfg.rows.map((r) => ({ ...r, fromType: "time", toType: "time" }));
}

function dtsNeedsSystemTimes(rows) {
  return {
    inTime: rows.some((r) => r.fromType === "intime"),
    outTime: rows.some((r) => r.toType === "outtime"),
  };
}

// Turns rows into concrete minutes.
//   ctx = null                      -> static check (popup): system times are "unknown", not an error
//   ctx = { inMin, outMin }         -> run-time resolution; a needed but missing system time is an error
// Returns { rows: [{fromMin, toMin, comment}], errors: [...] } (fromMin/toMin are null when unknown).
function dtsResolveRows(rows, ctx, maxHours) {
  const errors = [];
  const out = [];
  const maxMinutes = Math.round((Number(maxHours) || 0) * 60);
  let prevTo = null; // null = unknown or no previous row

  rows.forEach((row, i) => {
    const n = i + 1;
    const fromType = row.fromType || "time";
    const toType = row.toType || "time";
    let from = null;
    let to = null;

    if (fromType === "time") {
      from = dtsToMin(row.from);
      if (from === null) errors.push(`Row ${n}: enter a From time.`);
    } else if (fromType === "intime") {
      from = ctx ? (Number.isFinite(ctx.inMin) ? ctx.inMin : null) : null;
      if (ctx && from === null) errors.push(`Row ${n}: the form has no in-time for this date.`);
    } else if (fromType === "prev") {
      const gap = Number(row.gap);
      if (i === 0) errors.push("Row 1: can't start 'after previous row'.");
      else if (!Number.isFinite(gap) || gap < 0) errors.push(`Row ${n}: enter a valid gap in minutes.`);
      else from = prevTo === null ? null : prevTo + gap;
    }

    if (toType === "time") {
      to = dtsToMin(row.to);
      if (to === null) errors.push(`Row ${n}: enter a To time.`);
    } else if (toType === "outtime") {
      to = ctx ? (Number.isFinite(ctx.outMin) ? ctx.outMin : null) : null;
      if (ctx && to === null) errors.push(`Row ${n}: the form has no out-time for this date.`);
    } else if (toType === "hours") {
      const h = Number(row.hours);
      if (!Number.isFinite(h) || h <= 0) errors.push(`Row ${n}: enter a valid number of hours.`);
      else to = from === null ? null : from + Math.round(h * 60);
    }

    if (from !== null && to !== null) {
      if (to <= from) {
        errors.push(`Row ${n}: FromTime cannot be more than or equal to ToTime.`);
      } else if (to - from > maxMinutes) {
        errors.push(`Row ${n}: can't be longer than ${maxHours} hour(s).`);
      }
    }
    if (from !== null && prevTo !== null && from < prevTo) {
      errors.push(`Row ${n}: starts before row ${n - 1} ends.`);
    }
    prevTo = to;
    out.push({ fromMin: from, toMin: to, comment: row.comment || "" });
  });
  return { rows: out, errors };
}

// Static validation of the whole config (what the popup can know before running).
function dtsValidate(cfg) {
  if (!Array.isArray(cfg.rows) || cfg.rows.length === 0) return ["Add at least one time row."];
  const errors = [];
  if (cfg.date && !dtsDateLabel(cfg.date)) errors.push("Date is invalid.");
  if (!(Number(cfg.maxHours) > 0)) errors.push("Maximum hours per row must be more than 0.");
  for (const key of ["project", "module", "activityType", "activity", "status"]) {
    if (!String(cfg[key] || "").trim()) errors.push(`"${key}" match text can't be empty.`);
  }
  errors.push(...dtsResolveRows(dtsEffectiveRows(cfg), null, cfg.maxHours).errors);
  return errors;
}

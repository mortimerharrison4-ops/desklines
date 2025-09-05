import express from "express";
import * as chrono from "chrono-node";
import moment from "moment-timezone";

const app = express();
app.use(express.json());

const BUSINESS_TZ = process.env.BUSINESS_TZ || "America/Los_Angeles";

function timeOfDay(h) {
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 17) return "afternoon";
  if (h >= 17 && h < 21) return "evening";
  return "night";
}

// Parse a natural-language time (e.g., "11 am") *as if it was spoken in BUSINESS_TZ*
function normalizeLocalTime(rawTime, dateStr, fallbackMoment) {
  if (!rawTime) return fallbackMoment.format("HH:mm");

  // 1) Already 24h format? Keep as-is
  if (/^\d{2}:\d{2}$/.test(rawTime)) return rawTime;

  // 2) Common AM/PM patterns -> parse directly in BUSINESS_TZ
  const ampm = moment.tz(rawTime.trim(), ["h a", "h:mm a", "h.mm a"], BUSINESS_TZ, true);
  if (ampm.isValid()) return ampm.format("HH:mm");

  // 3) Fallback: use chrono to get hour/minute, then apply in BUSINESS_TZ
  const parsed = chrono.parse(rawTime);
  if (parsed?.[0]?.start) {
    const comp = parsed[0].start;
    // Get concrete or implied time components from chrono
    const hour =
      comp.knownValues().hour ??
      comp.impliedValues().hour ?? 
      9; // default 9am if time was missing
    const minute =
      comp.knownValues().minute ??
      comp.impliedValues().minute ?? 
      0;

    const m = moment.tz(`${dateStr} 00:00`, "YYYY-MM-DD HH:mm", BUSINESS_TZ)
      .hour(hour)
      .minute(minute)
      .second(0)
      .millisecond(0);
    return m.format("HH:mm");
  }

  // 4) Last resort: fallback time (call time)
  return fallbackMoment.format("HH:mm");
}

app.get("/", (_req, res) => res.send("ok"));

app.post("/tools/check-availability", (req, res) => {
  const body = req.body || {};
  console.log("Got body:", body);

  // Call timestamp (when tool was invoked)
  const rawCallTs = body.callTimestamp || req.header("X-Telnyx-Timestamp") || new Date().toISOString();
  let callMoment = moment(rawCallTs);
  if (!callMoment.isValid()) callMoment = moment();
  callMoment = callMoment.tz(BUSINESS_TZ);

  // Inputs (accept a few aliases)
  let rawDate = body.date || body.Date || body["appointment_date"] || body["date_requested"];
  let rawTime = body.time || body.Time || body["appointment_time"] || body["time_requested"];
  let rawDuration = body.durationMinutes || body.duration || body["duration_minutes"] || body["appointment_duration"];

  const customerName = body.customerName || body["customer_name"] || body["customer name"];
  const customerEmail = body.customerEmail || body["customer_email"] || body["customer email"];
  const customerPhone = body.customerPhone || body["customer_phone"] || body["customer phone"];

  // Date (YYYY-MM-DD) in BUSINESS_TZ
  let dateStr;
  if (rawDate) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
      dateStr = rawDate;
    } else {
      const parsedDate = chrono.parseDate(rawDate, callMoment.toDate());
      dateStr = parsedDate
        ? moment(parsedDate).tz(BUSINESS_TZ).format("YYYY-MM-DD")
        : callMoment.format("YYYY-MM-DD");
    }
  } else {
    dateStr = callMoment.format("YYYY-MM-DD");
  }

  // Time (HH:mm) — interpret the spoken time as LOCAL BUSINESS_TZ, not UTC
  const timeStr = normalizeLocalTime(rawTime, dateStr, callMoment);

  // Duration minutes (default 30)
  let duration = 30;
  if (rawDuration != null) {
    if (typeof rawDuration === "number") duration = rawDuration;
    else if (typeof rawDuration === "string") {
      const num = parseInt(rawDuration.replace(/\D/g, ""), 10);
      if (!isNaN(num)) duration = num;
    }
  }

  // Compose appointment moment in BUSINESS_TZ using the normalized date+time
  const apptMoment = moment.tz(`${dateStr} ${timeStr}`, "YYYY-MM-DD HH:mm", BUSINESS_TZ);

  // Friendly message
  const msg =
    `Echo: ${customerName || "Unknown"} wants ${duration} mins ` +
    `on ${apptMoment.format("YYYY-MM-DD")} at ${apptMoment.format("h:mm a")} (${timeOfDay(apptMoment.hour())}). ` +
    `Phone: ${customerPhone || "??"}`;

  res.json({
    isFree: true, // placeholder until you add Google/Outlook checks
    eventId: null,
    message: msg,
    call: {
      iso: callMoment.toISOString(),
      local: callMoment.format("YYYY-MM-DD HH:mm"),
      timeOfDay: timeOfDay(callMoment.hour()),
      timezone: BUSINESS_TZ
    },
    appointment: {
      date: apptMoment.format("YYYY-MM-DD"),
      time24: apptMoment.format("HH:mm"),
      time12: apptMoment.format("h:mm a"),
      local: apptMoment.format("YYYY-MM-DD HH:mm"),
      iso: apptMoment.toISOString(),
      timeOfDay: timeOfDay(apptMoment.hour()),
      durationMinutes: duration,
      timezone: BUSINESS_TZ
    },
    received: body
  });
});

app.listen(3000, () =>
  console.log(`Server running on port 3000, TZ=${BUSINESS_TZ}`)
);

import express from "express";
import * as chrono from "chrono-node";      // natural language parsing
import moment from "moment-timezone";       // timezone-aware formatting

const app = express();
app.use(express.json());

// Change this to your business timezone if needed
const BUSINESS_TZ = process.env.BUSINESS_TZ || "America/Los_Angeles";

// Small helper: label time of day
function timeOfDay(h) {
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 17) return "afternoon";
  if (h >= 17 && h < 21) return "evening";
  return "night";
}

// Health check
app.get("/", (_req, res) => res.send("ok"));

// Tool endpoint
app.post("/tools/check-availability", (req, res) => {
  const body = req.body || {};
  console.log("Got body:", body);

  // ---------- Call timestamp (time of day the call/tool happened) ----------
  // Prefer an explicit timestamp if provided; else use now.
  const rawCallTs =
    body.callTimestamp ||
    req.header("X-Telnyx-Timestamp") || // if Telnyx sends one
    new Date().toISOString();

  let callMoment = moment(rawCallTs);
  if (!callMoment.isValid()) callMoment = moment(); // fallback
  callMoment = callMoment.tz(BUSINESS_TZ);

  // ---------- Normalize appointment inputs ----------
  // Accept multiple possible key names to be forgiving
  let rawDate =
    body.date ||
    body.Date ||
    body["appointment_date"] ||
    body["date_requested"];
  let rawTime =
    body.time ||
    body.Time ||
    body["appointment_time"] ||
    body["time_requested"];

  let rawDuration =
    body.durationMinutes ||
    body.duration ||
    body["duration_minutes"] ||
    body["appointment_duration"];

  const customerName =
    body.customerName || body["customer_name"] || body["customer name"];
  const customerEmail =
    body.customerEmail || body["customer_email"] || body["customer email"];
  const customerPhone =
    body.customerPhone || body["customer_phone"] || body["customer phone"];

  // Date -> YYYY-MM-DD (default: today's date in business TZ)
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

  // Time -> HH:mm 24h (default: current time in business TZ)
  let timeStr;
  if (rawTime) {
    if (/^\d{2}:\d{2}$/.test(rawTime)) {
      timeStr = rawTime;
    } else {
      const parsedTime = chrono.parseDate(rawTime, callMoment.toDate(), {
        forwardDate: true
      });
      timeStr = parsedTime
        ? moment(parsedTime).tz(BUSINESS_TZ).format("HH:mm")
        : callMoment.format("HH:mm");
    }
  } else {
    timeStr = callMoment.format("HH:mm");
  }

  // Duration -> minutes (default: 30)
  let duration = 30;
  if (rawDuration != null) {
    if (typeof rawDuration === "number") {
      duration = rawDuration;
    } else if (typeof rawDuration === "string") {
      const num = parseInt(rawDuration.replace(/\D/g, ""), 10);
      if (!isNaN(num)) duration = num;
    }
  }

  // Compose a moment for the appointment in business TZ
  const apptMoment = moment.tz(
    `${dateStr} ${timeStr}`,
    "YYYY-MM-DD HH:mm",
    BUSINESS_TZ
  );

  // Build a friendly message (you’ll replace this once you hook calendars)
  const msg = `Echo: ${customerName || "Unknown"} wants ${duration} mins on ${apptMoment.format(
    "YYYY-MM-DD"
  )} at ${apptMoment.format("HH:mm")} (${timeOfDay(apptMoment.hour())}). Phone: ${
    customerPhone || "??"
  }`;

  // Respond including both call-time and appointment-time details
  res.json({
    isFree: true,            // placeholder until you add calendar checks
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
      time: apptMoment.format("HH:mm"),
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

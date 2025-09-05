import express from "express";
import moment from "moment-timezone";
import * as chrono from "chrono-node";

const app = express();
app.use(express.json());

// ---- Config ----
const DEFAULT_TZ = "America/Los_Angeles";
const TZ = moment.tz.zone(process.env.BUSINESS_TZ || DEFAULT_TZ)
  ? (process.env.BUSINESS_TZ || DEFAULT_TZ)
  : DEFAULT_TZ;

// label morning/afternoon/evening/night
function timeOfDay(h) {
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 17) return "afternoon";
  if (h >= 17 && h < 21) return "evening";
  return "night";
}

// Parse a local time string in TZ using only moment (no chrono here)
function parseLocalTimeToHHmm(raw, fallbackMoment) {
  if (!raw) return fallbackMoment.format("HH:mm");

  // already HH:mm?
  if (/^\d{2}:\d{2}$/.test(raw)) return raw;

  // Try a bunch of common formats in strict mode in our TZ
  const formats = [
    "h a", "h:mm a", "h.mm a",
    "ha", "h:mma",
    "H", "H:mm", "H.mm"
  ];
  const m = moment.tz(raw.trim(), formats, TZ, true);
  if (m.isValid()) return m.format("HH:mm");

  // last resort: just use fallback
  return fallbackMoment.format("HH:mm");
}

app.get("/", (_req, res) => res.send("ok"));

app.post("/tools/check-availability", (req, res) => {
  const body = req.body || {};
  try {
    // When the tool was invoked
    const rawCallTs =
      body.callTimestamp ||
      req.header("X-Telnyx-Timestamp") ||
      new Date().toISOString();

    let callMoment = moment(rawCallTs);
    if (!callMoment.isValid()) callMoment = moment();
    callMoment = callMoment.tz(TZ);

    // Accept a few aliases (be forgiving)
    const rawDate =
      body.date || body.Date || body["appointment_date"] || body["date_requested"];
    const rawTime =
      body.time || body.Time || body["appointment_time"] || body["time_requested"];
    const rawDuration =
      body.durationMinutes || body.duration || body["duration_minutes"] || body["appointment_duration"];

    const customerName =
      body.customerName || body["customer_name"] || body["customer name"];
    const customerEmail =
      body.customerEmail || body["customer_email"] || body["customer email"];
    const customerPhone =
      body.customerPhone || body["customer_phone"] || body["customer phone"];

    // ---- Date -> YYYY-MM-DD (assume caller speaks in TZ) ----
    let dateStr;
    if (rawDate) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
        dateStr = rawDate;
      } else {
        const parsedDate = chrono.parseDate(rawDate, callMoment.toDate());
        dateStr = parsedDate
          ? moment(parsedDate).tz(TZ).format("YYYY-MM-DD")
          : callMoment.format("YYYY-MM-DD");
      }
    } else {
      dateStr = callMoment.format("YYYY-MM-DD");
    }

    // ---- Time -> HH:mm (interpret as local TZ) ----
    const timeStr = parseLocalTimeToHHmm(rawTime, callMoment);

    // ---- Duration -> minutes (default 30) ----
    let duration = 30;
    if (rawDuration != null) {
      if (typeof rawDuration === "number") duration = rawDuration;
      else if (typeof rawDuration === "string") {
        const num = parseInt(rawDuration.replace(/\D/g, ""), 10);
        if (!isNaN(num)) duration = num;
      }
    }

    // Compose appointment moment in TZ
    const apptMoment = moment.tz(`${dateStr} ${timeStr}`, "YYYY-MM-DD HH:mm", TZ);

    // Friendly message (calendar check comes later)
    const msg =
      `Echo: ${customerName || "Unknown"} wants ${duration} mins ` +
      `on ${apptMoment.format("YYYY-MM-DD")} at ${apptMoment.format("h:mm a")} (${timeOfDay(apptMoment.hour())}). ` +
      `Phone: ${customerPhone || "??"}`;

    return res.json({
      isFree: true,    // placeholder until Google/Outlook check is wired
      eventId: null,
      message: msg,
      call: {
        iso: callMoment.toISOString(),
        local: callMoment.format("YYYY-MM-DD HH:mm"),
        timeOfDay: timeOfDay(callMoment.hour()),
        timezone: TZ
      },
      appointment: {
        date: apptMoment.format("YYYY-MM-DD"),
        time24: apptMoment.format("HH:mm"),
        time12: apptMoment.format("h:mm a"),
        local: apptMoment.format("YYYY-MM-DD HH:mm"),
        iso: apptMoment.toISOString(),
        timeOfDay: timeOfDay(apptMoment.hour()),
        durationMinutes: duration,
        timezone: TZ
      },
      received: body
    });
  } catch (err) {
    console.error("Handler error:", err);
    // Return JSON (not HTML) so Telnyx tool UI shows a clear error
    return res.status(200).json({
      isFree: false,
      eventId: null,
      message: "Sorry, I hit an error interpreting that time. Try another time.",
      error: String(err?.message || err)
    });
  }
});

app.listen(3000, () => {
  console.log(`Server running on port 3000, TZ=${TZ}`);
});

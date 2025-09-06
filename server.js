import express from "express";
import moment from "moment-timezone";
import * as chrono from "chrono-node";

const app = express();
app.use(express.json());

// -------- Config (set your tz in Render as BUSINESS_TZ if needed) ----------
const DEFAULT_TZ = "America/Los_Angeles";
const envTZ = process.env.BUSINESS_TZ;
const TZ = (typeof envTZ === "string" && moment.tz.zone(envTZ)) ? envTZ : DEFAULT_TZ;

// -------- Helpers -----------------------------------------------------------
function timeOfDay(h) {
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 17) return "afternoon";
  if (h >= 17 && h < 21) return "evening";
  return "night";
}

// Parse a local time string in TZ using moment only (no chrono here)
function parseLocalTimeToHHmm(raw, fallbackMoment) {
  try {
    if (raw == null) return fallbackMoment.format("HH:mm");
    const s = String(raw).trim();
    if (s === "") return fallbackMoment.format("HH:mm");

    // Already HH:mm?
    if (/^\d{2}:\d{2}$/.test(s)) return s;

    const formats = [
      "h a", "h:mm a", "h.mm a",
      "ha", "h:mma",
      "H", "H:mm", "H.mm"
    ];
    const m = moment.tz(s, formats, TZ, true); // strict
    return m.isValid() ? m.format("HH:mm") : fallbackMoment.format("HH:mm");
  } catch {
    return fallbackMoment.format("HH:mm");
  }
}

// Safe chrono date parse → YYYY-MM-DD. Falls back to callMoment's date.
function parseDateToYYYYMMDD(raw, callMoment) {
  try {
    if (raw == null) return callMoment.format("YYYY-MM-DD");
    const s = String(raw).trim();
    if (s === "") return callMoment.format("YYYY-MM-DD");
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; // already normalized

    const dt = chrono.parseDate(s, callMoment.toDate());
    if (!dt) return callMoment.format("YYYY-MM-DD");
    return moment(dt).tz(TZ).format("YYYY-MM-DD");
  } catch {
    return callMoment.format("YYYY-MM-DD");
  }
}

// ---------------------------------------------------------------------------
app.get("/", (_req, res) => res.send("ok"));

app.post("/tools/check-availability", (req, res) => {
  try {
    const body = req.body || {};
    console.log("Got body:", body);

    // When the tool was invoked (prefer explicit header if Telnyx sends it)
    const headerTs = req.header("X-Telnyx-Timestamp");
    let callMoment = moment(headerTs ?? body.callTimestamp ?? new Date().toISOString());
    if (!callMoment.isValid()) callMoment = moment();
    callMoment = callMoment.tz(TZ);

    // Accept a few aliases and force-string everything
    const rawDate =
      body.date ?? body.Date ?? body["appointment_date"] ?? body["date_requested"];
    const rawTime =
      body.time ?? body.Time ?? body["appointment_time"] ?? body["time_requested"];
    const rawDuration =
      body.durationMinutes ?? body.duration ?? body["duration_minutes"] ?? body["appointment_duration"];

    const customerName =
      body.customerName ?? body["customer_name"] ?? body["customer name"] ?? "";
    const customerEmail =
      body.customerEmail ?? body["customer_email"] ?? body["customer email"] ?? "";
    const customerPhone =
      body.customerPhone ?? body["customer_phone"] ?? body["customer phone"] ?? "";

    // Normalize date/time/duration
    const dateStr = parseDateToYYYYMMDD(rawDate, callMoment);
    const timeStr = parseLocalTimeToHHmm(rawTime, callMoment);

    let duration = 30;
    if (rawDuration != null) {
      if (typeof rawDuration === "number") duration = rawDuration;
      else {
        const n = parseInt(String(rawDuration).replace(/\D/g, ""), 10);
        if (!isNaN(n)) duration = n;
      }
    }

    // Appointment moment in your business TZ
    const apptMoment = moment.tz(`${dateStr} ${timeStr}`, "YYYY-MM-DD HH:mm", TZ);

    const msg =
      `Echo: ${String(customerName || "Unknown")} wants ${duration} mins ` +
      `on ${apptMoment.format("YYYY-MM-DD")} at ${apptMoment.format("h:mm a")} (${timeOfDay(apptMoment.hour())}). ` +
      `Phone: ${String(customerPhone || "??")}`;

    return res.json({
      isFree: true,     // still a placeholder; we’ll wire calendar next
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
    // Always return JSON (not HTML) so Telnyx UI shows a clear error
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

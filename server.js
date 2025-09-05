import express from "express";
import * as chrono from "chrono-node";
import moment from "moment-timezone";

const app = express();
app.use(express.json());

// ---- Config ----
const DEFAULT_TZ = "America/Los_Angeles";
const TZ = moment.tz.zone(process.env.BUSINESS_TZ || DEFAULT_TZ)
  ? (process.env.BUSINESS_TZ || DEFAULT_TZ)
  : DEFAULT_TZ;

// ---- Helpers ----
function timeOfDay(h) {
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 17) return "afternoon";
  if (h >= 17 && h < 21) return "evening";
  return "night";
}

// Parse a spoken time (e.g., "11 am") **as local BUSINESS TZ**
function normalizeLocalTime(rawTime, dateStr, fallbackMoment) {
  try {
    if (!rawTime) return fallbackMoment.format("HH:mm");

    // Already HH:mm?
    if (/^\d{2}:\d{2}$/.test(rawTime)) return rawTime;

    // Parse common am/pm patterns in BUSINESS TZ
    const ampm = moment.tz(rawTime.trim(), ["h a", "h:mm a", "h.mm a"], TZ, true);
    if (ampm.isValid()) return ampm.format("HH:mm");

    // Fallback: use chrono to extract hour/min
    const parsed = chrono.parse(rawTime);
    const comp = parsed?.[0]?.start;
    if (comp) {
      const known = comp.knownValues?.() ?? {};
      const implied = comp.impliedValues?.() ?? {};
      const hour = (known.hour ?? implied.hour ?? 9);
      const minute = (known.minute ?? implied.minute ?? 0);

      const m = moment.tz(`${dateStr} 00:00`, "YYYY-MM-DD HH:mm", TZ)
        .hour(hour).minute(minute).second(0).millisecond(0);
      return m.format("HH:mm");
    }
    return fallbackMoment.format("HH:mm");
  } catch {
    return fallbackMoment.format("HH:mm");
  }
}

app.get("/", (_req, res) => res.send("ok"));

app.post("/tools/check-availability", (req, res) => {
  try {
    const body = req.body || {};
    console.log("Got body:", body);

    // Call timestamp (when tool invoked)
    const rawCallTs = body.callTimestamp || req.header("X-Telnyx-Timestamp") || new Date().toISOString();
    let callMoment = moment(rawCallTs);
    if (!callMoment.isValid()) callMoment = moment();
    callMoment = callMoment.tz(TZ);

    // Inputs (accept aliases)
    const rawDate = body.date || body.Date || body["appointment_date"] || body["date_requested"];
    const rawTime = body.time || body.Time || body["appointment_time"] || body["time_requested"];
    const rawDuration = body.durationMinutes || body.duration || body["duration_minutes"] || body["appointment_duration"];

    const customerName = body.customerName || body["customer_name"] || body["customer name"];
    const customerEmail = body.customerEmail || body["customer_email"] || body["customer email"];
    const customerPhone = body.customerPhone || body["customer_phone"] || body["customer phone"];

    // Date → YYYY-MM-DD (assume caller speaks in TZ)
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

    // Time → HH:mm (interpret as local TZ)
    const timeStr = normalizeLocalTime(rawTime, dateStr, callMoment);

    // Duration → minutes (default 30)
    let duration = 30;
    if (rawDuration != null) {
      if (typeof rawDuration === "number") duration = rawDuration;
      else if (typeof rawDuration === "string") {
        const num = parseInt(rawDuration.replace(/\D/g, ""), 10);
        if (!isNaN(num)) duration = num;
      }
    }

    // Compose appointment in TZ
    const apptMoment = moment.tz(`${dateStr} ${timeStr}`, "YYYY-MM-DD HH:mm", TZ);

    const msg =
      `Echo: ${customerName || "Unknown"} wants ${duration} mins ` +
      `on ${apptMoment.format("YYYY-MM-DD")} at ${apptMoment.format("h:mm a")} (${timeOfDay(apptMoment.hour())}). ` +
      `Phone: ${customerPhone || "??"}`;

    return res.json({
      isFree: true,         // placeholder until calendar check is added
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
    return res.status(200).json({
      isFree: false,
      eventId: null,
      message: "Sorry, I hit an error interpreting that time. Try another time.",
      error: String(err?.message || err)
    });
  }
});

app.listen(3000, () => console.log(`Server running on port 3000, TZ=${TZ}`));

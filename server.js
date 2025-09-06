// server.js
import express from "express";
import moment from "moment-timezone";
import * as chrono from "chrono-node";
import { google } from "googleapis";

const app = express();
app.use(express.json());

// ------------- Config / Env -----------------
const DEFAULT_TZ = "America/Los_Angeles";
const envTZ = process.env.BUSINESS_TZ;
const TZ = (typeof envTZ === "string" && moment.tz.zone(envTZ)) ? envTZ : DEFAULT_TZ;

const TOOL_SECRET = process.env.TOOL_SECRET || ""; // must match Telnyx header

// Google API Client
const oauth2 = new google.auth.OAuth2(
  process.env.GCAL_CLIENT_ID,
  process.env.GCAL_CLIENT_SECRET
);
if (process.env.GCAL_REFRESH_TOKEN) {
  oauth2.setCredentials({ refresh_token: process.env.GCAL_REFRESH_TOKEN });
}
const gcal = google.calendar({ version: "v3", auth: oauth2 });
const CALENDAR_ID = process.env.CALENDAR_ID || "primary";

// ------------- Helpers ----------------------
function timeOfDay(h) {
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 17) return "afternoon";
  if (h >= 17 && h < 21) return "evening";
  return "night";
}

// Natural language date -> YYYY-MM-DD (safe)
function parseDateToYYYYMMDD(raw, callMoment) {
  try {
    if (raw == null) return callMoment.format("YYYY-MM-DD");
    const s = String(raw).trim();
    if (s === "") return callMoment.format("YYYY-MM-DD");
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const dt = chrono.parseDate(s, callMoment.toDate());
    if (!dt) return callMoment.format("YYYY-MM-DD");
    return moment(dt).tz(TZ).format("YYYY-MM-DD");
  } catch {
    return callMoment.format("YYYY-MM-DD");
  }
}

// Local time text -> "HH:mm" (regex only; no tz parsing)
function parseLocalTimeToHHmm(raw, fallbackMoment) {
  try {
    if (raw == null) return fallbackMoment.format("HH:mm");
    const s = String(raw).trim();
    if (s === "") return fallbackMoment.format("HH:mm");

    if (/^\d{2}:\d{2}$/.test(s)) return s; // already 24h

    const ampm = s.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]m)$/i);
    if (ampm) {
      let hour = parseInt(ampm[1], 10);
      const minute = ampm[2] ? parseInt(ampm[2], 10) : 0;
      const mer = ampm[3].toLowerCase();
      if (mer === "pm" && hour < 12) hour += 12;
      if (mer === "am" && hour === 12) hour = 0;
      return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    }

    const hourOnly = s.match(/^(\d{1,2})$/);
    if (hourOnly) {
      const hour = Math.max(0, Math.min(23, parseInt(hourOnly[1], 10)));
      return `${String(hour).padStart(2, "0")}:00`;
    }

    return fallbackMoment.format("HH:mm");
  } catch {
    return fallbackMoment.format("HH:mm");
  }
}

// Google helpers
async function gcalIsFreeISO(startISO, endISO, tz) {
  const fb = await gcal.freebusy.query({
    requestBody: {
      timeMin: startISO,
      timeMax: endISO,
      timeZone: tz,
      items: [{ id: CALENDAR_ID }]
    }
  });
  const busy = fb.data.calendars?.[CALENDAR_ID]?.busy || [];
  return busy.length === 0;
}

async function gcalCreateEventISO({ startISO, endISO, tz, summary, description, attendees = [] }) {
  const ev = await gcal.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: {
      summary,
      description,
      start: { dateTime: startISO, timeZone: tz },
      end:   { dateTime: endISO,   timeZone: tz },
      attendees: attendees.filter(Boolean).map(e => ({ email: e })),
      reminders: { useDefault: true }
    }
  });
  return ev.data.id || null;
}

// ------------- Debug routes -----------------
app.get("/", (_req, res) => res.send("ok"));

app.get("/debug/env", (_req, res) => {
  res.json({
    tz: TZ,
    hasClientId: !!process.env.GCAL_CLIENT_ID,
    hasClientSecret: !!process.env.GCAL_CLIENT_SECRET,
    hasRefreshToken: !!process.env.GCAL_REFRESH_TOKEN,
    calendarId: CALENDAR_ID,
    hasToolSecret: !!TOOL_SECRET
  });
});

app.get("/debug/freebusy", async (_req, res) => {
  try {
    const now = moment().tz(TZ);
    const end = now.clone().add(30, "minutes");
    const ok = await gcalIsFreeISO(now.toISOString(), end.toISOString(), TZ);
    res.json({ ok: true, free: ok });
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
});

// ------------- Main webhook -----------------
app.post("/tools/check-availability", async (req, res) => {
  try {
    // Optional: lock down with shared secret
    if (TOOL_SECRET && req.get("X-Auth-Token") !== TOOL_SECRET) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const body = req.body || {};
    console.log("Got body:", body);

    // When the tool was invoked
    const headerTs = req.header("X-Telnyx-Timestamp");
    let callMoment = moment(headerTs ?? body.callTimestamp ?? new Date().toISOString());
    if (!callMoment.isValid()) callMoment = moment();
    callMoment = callMoment.tz(TZ);

    // Accept aliases
    const rawDate = body.date ?? body.Date ?? body["appointment_date"] ?? body["date_requested"];
    const rawTime = body.time ?? body.Time ?? body["appointment_time"] ?? body["time_requested"];
    const rawDuration = body.durationMinutes ?? body.duration ?? body["duration_minutes"] ?? body["appointment_duration"];

    const customerName = body.customerName ?? body["customer_name"] ?? body["customer name"] ?? "";
    const customerEmail = body.customerEmail ?? body["customer_email"] ?? body["customer email"] ?? "";
    const customerPhone = body.customerPhone ?? body["customer_phone"] ?? body["customer phone"] ?? "";
    const autoBook = Boolean(body.autoBook);

    // Normalize
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

    // Appointment
    const apptMoment = moment.tz(`${dateStr} ${timeStr}`, "YYYY-MM-DD HH:mm", TZ);
    const startISO = apptMoment.toISOString();
    const endISO   = apptMoment.clone().add(duration, "minutes").toISOString();

    // --- Google: free/busy ---
    let isFree = false;
    try {
      isFree = await gcalIsFreeISO(startISO, endISO, TZ);
    } catch (err) {
      console.error("freebusy error:", err);
      return res.status(200).json({
        isFree: false,
        eventId: null,
        message: "I couldn't check the calendar right now. Please try again.",
        error: String(err?.message || err)
      });
    }

    if (!isFree) {
      return res.json({
        isFree: false,
        eventId: null,
        message: `Sorry, ${apptMoment.format("YYYY-MM-DD")} at ${apptMoment.format("h:mm a")} is already booked.`
      });
    }

    // --- Auto-book if requested ---
    let eventId = null;
    if (autoBook) {
      try {
        const summary = `Appointment – ${String(customerName || "Customer")}`;
        const description =
          `Booked by AI receptionist.\nPhone: ${String(customerPhone || "")}\nEmail: ${String(customerEmail || "")}`;
        const attendees = customerEmail ? [customerEmail] : [];
        eventId = await gcalCreateEventISO({
          startISO, endISO, tz: TZ, summary, description, attendees
        });
      } catch (err) {
        console.error("create event error:", err);
        // continue; we'll still return that it's free
      }
    }

    // Success response
    return res.json({
      isFree: true,
      eventId,
      message: eventId
        ? `Booked ${apptMoment.format("YYYY-MM-DD")} at ${apptMoment.format("h:mm a")} for ${duration} minutes.`
        : `That slot is free. Would you like me to book it?`,
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
        iso: startISO,
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
      message: "Sorry, I hit an error. Try another time.",
      error: String(err?.message || err)
    });
  }
});

app.listen(3000, () => {
  console.log(`Server running on port 3000, TZ=${TZ}`);
});

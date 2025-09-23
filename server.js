import express from "express";
import moment from "moment-timezone";
import * as chrono from "chrono-node";
import { google } from "googleapis";

const app = express();
app.use(express.json());

// ---------- Config ----------
const DEFAULT_TZ = "America/Los_Angeles";
const envTZ = process.env.BUSINESS_TZ;
const TZ = (typeof envTZ === "string" && moment.tz.zone(envTZ)) ? envTZ : DEFAULT_TZ;

const TOOL_SECRET = (process.env.TOOL_SECRET || "").trim();
const CALENDAR_ID = (process.env.CALENDAR_ID || "primary").trim();

// ---------- Helpers ----------
function timeOfDay(h) {
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 17) return "afternoon";
  if (h >= 17 && h < 21) return "evening";
  return "night";
}

// Robust date normalization: try to parse; if we can't, return null so we NEVER fall back to now
function normalizeDate(raw, callMoment) {
  try {
    if (raw == null) return null; // force caller to provide one
    const s = String(raw).trim();
    if (s === "") return null;

    // already ISO
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { value: s, source: "iso" };

    // chrono with future bias
    const dt = chrono.parseDate(s, callMoment.toDate(), { forwardDate: true });
    if (dt) return { value: moment(dt).tz(TZ).format("YYYY-MM-DD"), source: "chrono" };

    // strict fallbacks (assume current year, roll forward if in past)
    const formats = ["MMMM D", "MMM D", "D MMMM", "D MMM", "M/D", "M-D", "MM/DD", "MM-DD"]; 
    for (const f of formats) {
      const tmp = moment.tz(s, f, TZ, true);
      if (tmp.isValid()) {
        let m2 = tmp.year(callMoment.year());
        if (m2.endOf("day").isBefore(callMoment)) m2 = m2.add(1, "year");
        return { value: m2.format("YYYY-MM-DD"), source: "fallback" };
      }
    }

    return null; // unknown phrase → require clarification
  } catch {
    return null;
  }
}

function parseLocalTimeToHHmm(raw, _fallbackMoment) {
  try {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (s === "") return null;
    if (/^\d{2}:\d{2}$/.test(s)) return s;

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

    return null; // don't fall back to now
  } catch {
    return null;
  }
}

function makeGcalClientOrThrow() {
  const cid  = (process.env.GCAL_CLIENT_ID || "").trim();
  const csec = (process.env.GCAL_CLIENT_SECRET || "").trim();
  const rtok = (process.env.GCAL_REFRESH_TOKEN || "").trim();

  const missing = {
    GCAL_CLIENT_ID: !!cid,
    GCAL_CLIENT_SECRET: !!csec,
    GCAL_REFRESH_TOKEN: !!rtok
  };
  if (!missing.GCAL_CLIENT_ID || !missing.GCAL_CLIENT_SECRET || !missing.GCAL_REFRESH_TOKEN) {
    throw new Error("Missing Google creds: " + JSON.stringify(missing));
  }

  const oauth2 = new google.auth.OAuth2(cid, csec);
  oauth2.setCredentials({ refresh_token: rtok });
  return google.calendar({ version: "v3", auth: oauth2 });
}

// ---------- Debug routes ----------
app.get("/", (_req, res) => res.send("ok"));

app.get("/debug/env", (_req, res) => {
  res.json({
    tz: TZ,
    hasClientId: !!(process.env.GCAL_CLIENT_ID || "").trim(),
    hasClientSecret: !!(process.env.GCAL_CLIENT_SECRET || "").trim(),
    hasRefreshToken: !!(process.env.GCAL_REFRESH_TOKEN || "").trim(),
    calendarId: CALENDAR_ID,
    hasToolSecret: !!TOOL_SECRET
  });
});

app.get("/debug/env/strict", (_req, res) => {
  const cid  = (process.env.GCAL_CLIENT_ID || "");
  const csec = (process.env.GCAL_CLIENT_SECRET || "");
  const rtok = (process.env.GCAL_REFRESH_TOKEN || "");
  res.json({
    cid_len: cid.length,
    cid_start: cid.slice(0, 8),
    csec_len: csec.length,
    csec_start: csec.slice(0, 6),
    rtok_len: rtok.length,
    rtok_start: rtok.slice(0, 6),
    note: "Lengths shown so you can detect accidental blanks/newlines without revealing secrets."
  });
});

app.get("/debug/freebusy", async (_req, res) => {
  try {
    const gcal = makeGcalClientOrThrow();
    const now = moment().tz(TZ);
    const end = now.clone().add(30, "minutes");
    const fb = await gcal.freebusy.query({
      requestBody: {
        timeMin: now.toISOString(),
        timeMax: end.toISOString(),
        timeZone: TZ,
        items: [{ id: CALENDAR_ID }]
      }
    });
    const busy = fb.data.calendars?.[CALENDAR_ID]?.busy || [];
    res.json({ ok: true, free: busy.length === 0, busy });
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
});

// ---------- Main webhook ----------
app.post("/tools/check-availability", async (req, res) => {
  try {
    if (TOOL_SECRET && req.get("X-Auth-Token") !== TOOL_SECRET) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const body = req.body || {};
    console.log("Got body:", body);

    const headerTs = req.header("X-Telnyx-Timestamp");
    let callMoment = moment(headerTs ?? body.callTimestamp ?? new Date().toISOString());
    if (!callMoment.isValid()) callMoment = moment();
    callMoment = callMoment.tz(TZ);

    const rawDate = body.date ?? body.Date ?? body["appointment_date"] ?? body["date_requested"];
    const rawTime = body.time ?? body.Time ?? body["appointment_time"] ?? body["time_requested"];
    const rawDuration = body.durationMinutes ?? body.duration ?? body["duration_minutes"] ?? body["appointment_duration"];
    const customerName = body.customerName ?? body["customer_name"] ?? body["customer name"] ?? "";
    const customerEmail = body.customerEmail ?? body["customer_email"] ?? body["customer email"] ?? "";
    const customerPhone = body.customerPhone ?? body["customer_phone"] ?? body["customer phone"] ?? "";

    // Always auto-book
    const autoBook = true;

    // Parse inputs safely — never default to NOW when unclear
    const dateObj = normalizeDate(rawDate, callMoment); // {value, source} | null
    const dateStr = dateObj?.value || null;
    const timeStr = parseLocalTimeToHHmm(rawTime, callMoment); // string | null

    if (!dateStr || !timeStr) {
      return res.status(200).json({
        isFree: false,
        eventId: null,
        message: !dateStr && !timeStr
          ? "I couldn't understand the date and time. Please say a date like 'October 1' and a time like '3 pm'."
          : !dateStr
            ? "I couldn't understand the date. Please say a date like 'October 1' or '2025-10-01'."
            : "I couldn't understand the time. Please say a time like '3 pm' or '15:00'.",
        need: { date: !dateStr, time: !timeStr }
      });
    }

    // Duration (minutes) default 30
    let duration = 30;
    if (rawDuration != null) {
      if (typeof rawDuration === "number") duration = rawDuration;
      else {
        const n = parseInt(String(rawDuration).replace(/\D/g, ""), 10);
        if (!isNaN(n)) duration = n;
      }
    }

    let apptMoment = moment.tz(`${dateStr} ${timeStr}`, "YYYY-MM-DD HH:mm", TZ);
    if (!apptMoment.isValid()) {
      return res.status(200).json({
        isFree: false,
        eventId: null,
        message: "That didn't look like a valid date/time. Try '2025-10-01 at 3 pm'."
      });
    }

    // If phrase-derived date/time ended up in the past, nudge forward one day (do NOT use call time)
    if (apptMoment.isBefore(callMoment)) {
      if (!(dateObj && dateObj.source === "iso")) {
        apptMoment = apptMoment.add(1, "day");
      }
    }

    const startISO = apptMoment.toISOString();
    const endISO   = apptMoment.clone().add(duration, "minutes").toISOString();

    let isFree = false;
    try {
      const gcal = makeGcalClientOrThrow();
      const fb = await gcal.freebusy.query({
        requestBody: {
          timeMin: startISO,
          timeMax: endISO,
          timeZone: TZ,
          items: [{ id: CALENDAR_ID }]
        }
      });
      const busy = fb.data.calendars?.[CALENDAR_ID]?.busy || [];
      isFree = busy.length === 0;

      if (!isFree) {
        return res.json({
          isFree: false,
          eventId: null,
          message: `Sorry, ${apptMoment.format("YYYY-MM-DD")} at ${apptMoment.format("h:mm a")} is already booked. Would you like a different time that day?`
        });
      }
    } catch (err) {
      console.error("freebusy error:", err);
      return res.status(200).json({
        isFree: false,
        eventId: null,
        message: "Google auth is not ready. Check env or refresh token.",
        error: String(err?.message || err)
      });
    }

    let eventId = null;
    try {
      const gcal = makeGcalClientOrThrow();
      const summary = `Appointment – ${String(customerName || "Customer")}`;
      const description = `Booked by AI receptionist.\nPhone: ${String(customerPhone || "")}\nEmail: ${String(customerEmail || "")}`;
      const attendees = customerEmail ? [customerEmail] : [];

      const ev = await gcal.events.insert({
        calendarId: CALENDAR_ID,
        requestBody: {
          summary,
          description,
          start: { dateTime: startISO, timeZone: TZ },
          end:   { dateTime: endISO,   timeZone: TZ },
          attendees: attendees.map(e => ({ email: e })),
          reminders: { useDefault: true }
        }
      });

      eventId = ev.data.id || null;
    } catch (err) {
      console.error("create event error:", err);
      return res.status(200).json({
        isFree: true,
        eventId: null,
        message: "Slot is free, but I couldn't create the event.",
        createError: String(err?.message || err)
      });
    }

    return res.json({
      isFree: true,
      eventId,
      message: `Booked ${apptMoment.format("YYYY-MM-DD")} at ${apptMoment.format("h:mm a")} for ${duration} minutes.`,
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
      }
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

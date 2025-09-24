import express from "express";
import moment from "moment-timezone";
import * as chrono from "chrono-node";
import { google } from "googleapis";

const app = express();
app.use(express.json());

// ---------- Config ----------
const DEFAULT_TZ = "America/Los_Angeles";
const envTZ = process.env.BUSINESS_TZ;
const TZ =
  typeof envTZ === "string" && moment.tz.zone(envTZ) ? envTZ : DEFAULT_TZ;

const TOOL_SECRET = (process.env.TOOL_SECRET || "").trim();
const CALENDAR_ID = (process.env.CALENDAR_ID || "primary").trim();

// ---------- Helpers ----------
function timeOfDay(h) {
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 17) return "afternoon";
  if (h >= 17 && h < 21) return "evening";
  return "night";
}

function normalizeDate(raw, callMoment) {
  try {
    if (!raw) return null;
    const s = String(raw).trim();
    if (!s) return null;

    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { value: s, source: "iso" };

    const dt = chrono.parseDate(s, callMoment.toDate(), { forwardDate: true });
    if (dt)
      return { value: moment(dt).tz(TZ).format("YYYY-MM-DD"), source: "chrono" };

    const formats = [
      "MMMM D",
      "MMM D",
      "D MMMM",
      "D MMM",
      "M/D",
      "M-D",
      "MM/DD",
      "MM-DD",
    ];
    for (const f of formats) {
      const tmp = moment.tz(s, f, TZ, true);
      if (tmp.isValid()) {
        let m2 = tmp.year(callMoment.year());
        if (m2.endOf("day").isBefore(callMoment)) m2 = m2.add(1, "year");
        return { value: m2.format("YYYY-MM-DD"), source: "fallback" };
      }
    }
    return null;
  } catch {
    return null;
  }
}

function parseLocalTimeToHHmm(raw) {
  try {
    if (!raw) return null;
    const s = String(raw).trim();
    if (!s) return null;
    if (/^\d{2}:\d{2}$/.test(s)) return s;

    const cleaned = s.replace(/\./g, "");
    const ampm = cleaned.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]m)$/i);
    if (ampm) {
      let hour = parseInt(ampm[1], 10);
      const minute = ampm[2] ? parseInt(ampm[2], 10) : 0;
      const mer = ampm[3].toLowerCase();
      if (mer === "pm" && hour < 12) hour += 12;
      if (mer === "am" && hour === 12) hour = 0;
      return `${String(hour).padStart(2, "0")}:${String(minute).padStart(
        2,
        "0"
      )}`;
    }

    const hourOnly = s.match(/^(\d{1,2})$/);
    if (hourOnly) {
      const hour = Math.max(0, Math.min(23, parseInt(hourOnly[1], 10)));
      return `${String(hour).padStart(2, "0")}:00`;
    }

    return null;
  } catch {
    return null;
  }
}

function makeGcalClientOrThrow() {
  const cid = (process.env.GCAL_CLIENT_ID || "").trim();
  const csec = (process.env.GCAL_CLIENT_SECRET || "").trim();
  const rtok = (process.env.GCAL_REFRESH_TOKEN || "").trim();
  if (!cid || !csec || !rtok) {
    throw new Error("Missing Google credentials");
  }
  const oauth2 = new google.auth.OAuth2(cid, csec);
  oauth2.setCredentials({ refresh_token: rtok });
  return google.calendar({ version: "v3", auth: oauth2 });
}

// ---------- Debug ----------
app.get("/", (_req, res) => res.send("ok"));

app.get("/debug/parse", (req, res) => {
  const callMoment = moment().tz(TZ);
  const dateObj = normalizeDate(req.query.date, callMoment);
  const timeStr = parseLocalTimeToHHmm(req.query.time);
  res.json({ input: req.query, dateObj, timeStr });
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
        items: [{ id: CALENDAR_ID }],
      },
    });
    res.json(fb.data);
  } catch (e) {
    res.json({ error: String(e) });
  }
});

// 🔥 New probe route: confirms calendar access & lists events
app.get("/debug/probe-schedule", async (_req, res) => {
  try {
    const gcal = makeGcalClientOrThrow();
    const meta = await gcal.calendars.get({ calendarId: CALENDAR_ID });
    const now = moment().tz(TZ).toISOString();
    const events = await gcal.events.list({
      calendarId: CALENDAR_ID,
      timeMin: now,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 10,
    });

    res.json({
      ok: true,
      calendarId: CALENDAR_ID,
      calendarSummary: meta.data.summary,
      tz: TZ,
      upcoming: (events.data.items || []).map((e) => ({
        id: e.id,
        summary: e.summary,
        start: e.start?.dateTime || e.start?.date,
        end: e.end?.dateTime || e.end?.date,
      })),
    });
  } catch (err) {
    res.status(200).json({ ok: false, error: String(err?.message || err) });
  }
});

// ---------- Main webhook ----------
app.post("/tools/check-availability", async (req, res) => {
  try {
    if (TOOL_SECRET && req.get("X-Auth-Token") !== TOOL_SECRET) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const body = req.body || {};
    const headerTs = req.header("X-Telnyx-Timestamp");
    let callMoment = moment(headerTs ?? new Date().toISOString());
    if (!callMoment.isValid()) callMoment = moment();
    callMoment = callMoment.tz(TZ);

    const rawDate = body.date;
    const rawTime = body.time;
    const rawDuration = body.durationMinutes;

    const customerName = body.customerName || "";
    const customerEmail = body.customerEmail || "";
    const customerPhone = body.customerPhone || "";

    const dateObj = normalizeDate(rawDate, callMoment);
    const timeStr = parseLocalTimeToHHmm(rawTime);
    if (!dateObj || !timeStr) {
      return res.json({
        isFree: false,
        message:
          "I need both a valid date and time. Example: 'October 1 at 3 pm'.",
      });
    }

    let duration = 30;
    if (rawDuration) {
      const n = parseInt(String(rawDuration).replace(/\D/g, ""), 10);
      if (!isNaN(n)) duration = n;
    }

    const apptMoment = moment.tz(
      `${dateObj.value} ${timeStr}`,
      "YYYY-MM-DD HH:mm",
      TZ
    );
    if (!apptMoment.isValid() || apptMoment.isBefore(callMoment)) {
      return res.json({
        isFree: false,
        message: "That appointment time is invalid or in the past.",
      });
    }

    const startISO = apptMoment.toISOString();
    const endISO = apptMoment.clone().add(duration, "minutes").toISOString();

    const gcal = makeGcalClientOrThrow();
    const fb = await gcal.freebusy.query({
      requestBody: {
        timeMin: startISO,
        timeMax: endISO,
        timeZone: TZ,
        items: [{ id: CALENDAR_ID }],
      },
    });
    const calendars = fb.data.calendars || {};
    const keys = Object.keys(calendars);
    const key = calendars[CALENDAR_ID] ? CALENDAR_ID : keys[0] || null;
    const busy = key ? calendars[key].busy || [] : [];

    if (busy.length > 0) {
      return res.json({
        isFree: false,
        message: `Sorry, ${apptMoment.format(
          "YYYY-MM-DD"
        )} at ${apptMoment.format("h:mm a")} is already booked.`,
      });
    }

    const ev = await gcal.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: `Appointment – ${customerName}`,
        description: `Booked by AI.\nPhone: ${customerPhone}\nEmail: ${customerEmail}`,
        start: { dateTime: startISO, timeZone: TZ },
        end: { dateTime: endISO, timeZone: TZ },
        attendees: customerEmail ? [{ email: customerEmail }] : [],
      },
    });

    return res.json({
      isFree: true,
      eventId: ev.data.id,
      message: `Booked ${apptMoment.format(
        "YYYY-MM-DD h:mm a"
      )} for ${duration} minutes.`,
    });
  } catch (err) {
    console.error(err);
    return res.json({
      isFree: false,
      message: "Error: " + String(err.message || err),
    });
  }
});

app.listen(3000, () => {
  console.log(`Server running on port 3000, TZ=${TZ}`);
});

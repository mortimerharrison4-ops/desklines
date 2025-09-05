import express from "express";
import moment from "moment";        // npm install moment
import chrono from "chrono-node";   // npm install chrono-node

const app = express();
app.use(express.json());

// Health check (GET /)
app.get("/", (req, res) => {
  res.send("ok");
});

// Tool endpoint (POST /tools/check-availability)
app.post("/tools/check-availability", (req, res) => {
  const body = req.body || {};
  console.log("Got body:", body);

  // --- Normalize keys ---
  let rawDate =
    body.date || body.Date || body["appointment_date"] || body["date_requested"];
  let rawTime =
    body.time || body.Time || body["appointment_time"] || body["time_requested"];
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

  // --- Parse and normalize values ---
  const now = moment();

  // Date normalization (YYYY-MM-DD)
  let date;
  if (rawDate) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
      date = rawDate; // already in YYYY-MM-DD
    } else {
      const parsed = chrono.parseDate(rawDate);
      date = parsed ? moment(parsed).format("YYYY-MM-DD") : now.format("YYYY-MM-DD");
    }
  } else {
    date = now.format("YYYY-MM-DD");
  }

  // Time normalization (HH:mm 24h)
  let time;
  if (rawTime) {
    if (/^\d{2}:\d{2}$/.test(rawTime)) {
      time = rawTime;
    } else {
      const parsed = chrono.parseDate(rawTime, { forwardDate: true });
      time = parsed ? moment(parsed).format("HH:mm") : now.format("HH:mm");
    }
  } else {
    time = now.format("HH:mm");
  }

  // Duration normalization (default 30 mins)
  let duration = 30;
  if (rawDuration) {
    if (typeof rawDuration === "number") {
      duration = rawDuration;
    } else if (typeof rawDuration === "string") {
      const num = parseInt(rawDuration.replace(/\D/g, ""), 10);
      if (!isNaN(num)) duration = num;
    }
  }

  // --- Respond ---
  res.json({
    isFree: true,
    eventId: null,
    message: `Echo: ${customerName || "Unknown"} wants ${duration} mins on ${date} at ${time}. Phone: ${customerPhone || "??"}`,
    normalized: { date, time, duration },
    received: body
  });
});

app.listen(3000, () => console.log("Server running on port 3000"));

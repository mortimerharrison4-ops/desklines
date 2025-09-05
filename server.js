import express from "express";
const app = express();
app.use(express.json());

// Health check (GET /)
app.get("/", (req, res) => {
  res.send("ok");
});

// Tool endpoint (POST /tools/check-availability)
app.post("/tools/check-availability", (req, res) => {
  // Normalize body keys to be more forgiving
  const body = req.body || {};
  console.log("Got body:", body);

  // Grab values with multiple possible key names
  const date = body.date || body.Date || body["appointment_date"];
  const time = body.time || body.Time || body["appointment_time"];

  let duration =
    body.durationMinutes ||
    body.duration ||
    body["duration_minutes"] ||
    body["appointment_duration"];
  if (typeof duration === "string") {
    duration = parseInt(duration.replace(/\D/g, ""), 10); // convert "30 minutes" → 30
  }

  const customerName =
    body.customerName || body["customer_name"] || body["customer name"];
  const customerEmail =
    body.customerEmail || body["customer_email"] || body["customer email"];
  const customerPhone =
    body.customerPhone || body["customer_phone"] || body["customer phone"];

  // Just echo back for now
  res.json({
    isFree: true,
    eventId: null,
    message: `Echo: ${customerName || "Unknown"} wants ${duration || "?"} mins on ${date || "??"} at ${time || "??"}. Phone: ${customerPhone || "??"}`,
    received: body // return raw body for debugging too
  });
});

app.listen(3000, () => console.log("Server running on port 3000"));

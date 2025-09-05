import express from "express";
const app = express();
app.use(express.json());

// Health check (GET /)
app.get("/", (req, res) => {
  res.send("ok");
});

// Tool endpoint (POST /tools/check-availability)
app.post("/tools/check-availability", (req, res) => {
  const { date, time, durationMinutes, customerName, customerPhone } = req.body;
  console.log("Got body:", req.body);

  // Just echo back for now
  res.json({
    isFree: true,
    eventId: null,
    message: `Echo: ${customerName} wants ${durationMinutes} mins on ${date} at ${time}. Phone: ${customerPhone}`
  });
});

app.listen(3000, () => console.log("Server running on port 3000"));

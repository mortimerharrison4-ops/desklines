import express from "express";
const app = express();
app.use(express.json());

const SECRET = process.env.TOOL_SECRET || "change-me";

// health check
app.get("/", (_req, res) => res.send("ok"));

// your webhook tool endpoint
app.post("/tools/check-availability", (req, res) => {
  if (req.header("X-Auth-Token") !== SECRET) {
    return res.status(401).json({ error: "bad token" });
  }
  const { date, time, durationMinutes } = req.body || {};
  // For now, just echo back so we know it works. Replace with calendar later.
  res.json({
    isFree: true,
    eventId: null,
    message: `Echo: ${date} ${time} for ${durationMinutes} minutes looks free.`
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Listening on " + PORT));

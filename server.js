const express = require("express");
const path = require("node:path");

const config = require("./config");
const db = require("./db");
const voiceRoutes = require("./routes/voice");
const processRoutes = require("./routes/process");
const sessionStore = require("./sessionStore");
const tw = require("./services/twilio");
const sarvam = require("./services/sarvam");

const Customer = require("./models/Customer");
const Loan = require("./models/Loan");
const CallLog = require("./models/CallLog");

const app = express();

// Twilio posts application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Serve generated TTS audio for Twilio <Play>
app.use("/audio", express.static(path.join(__dirname, "public", "audio"), {
  setHeaders: (res) => {
    res.setHeader("Cache-Control", "public, max-age=600");
  },
}));

app.use("/", voiceRoutes);
app.use("/", processRoutes);

app.get("/health", (_req, res) => {
  res.json({
    status:         "ok",
    uptime:         process.uptime(),
    activeSessions: sessionStore.all().length,
    publicBaseUrl:  config.publicBaseUrl,
    db:             db.mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  });
});

/**
 * GET /customer/:phone — fetch customer + their active loan(s).
 * Phone must be E.164 (e.g. +918369262375).
 */
app.get("/customer/:phone", async (req, res) => {
  try {
    const customer = await Customer.findOne({ phone: req.params.phone }).lean();
    if (!customer) return res.status(404).json({ error: "customer not found" });
    const loans = await Loan.find({ customerId: customer.customerId }).lean();
    res.json({ customer, loans });
  } catch (err) {
    console.error("[/customer] failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /calllogs?customerId=...&phone=...&limit=20
 * Recent call logs for analytics / debugging.
 */
app.get("/calllogs", async (req, res) => {
  try {
    const q = {};
    if (req.query.customerId) q.customerId = req.query.customerId;
    if (req.query.phone)      q.phone      = req.query.phone;
    const limit = Math.min(parseInt(req.query.limit || "20", 10), 100);
    const logs = await CallLog.find(q).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ count: logs.length, logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /call — trigger an outbound call.
 * Body: { phone }
 * Backend fetches customer + loan from MongoDB by phone — no PII in the request.
 */
app.post("/call", async (req, res) => {
  const phone = req.body?.phone || req.body?.to;
  if (!phone) {
    return res.status(400).json({ error: "'phone' is required (E.164 format, e.g. +918369262375)" });
  }
  if (!config.publicBaseUrl) {
    return res.status(500).json({ error: "PUBLIC_BASE_URL not configured (set ngrok URL in .env)" });
  }

  try {
    const customer = await Customer.findOne({ phone }).lean();
    if (!customer) {
      return res.status(404).json({ error: `no customer found for phone ${phone}` });
    }

    // Pick the most-overdue loan for this customer (if multiple)
    const loan = await Loan.findOne({ customerId: customer.customerId, status: "OVERDUE" })
      .sort({ overdueDays: -1 })
      .lean();
    if (!loan) {
      return res.status(409).json({ error: `no overdue loan for ${customer.customerId}` });
    }

    const call = await tw.placeOutboundCall({ to: phone });
    console.log(`[call] outbound ${call.sid} → ${phone} (${customer.name}, ${loan.loanId})`);

    // Pre-seed the session so /voice has the right loan data without re-querying
    sessionStore.create(call.sid, phone, {
      customerId:   customer.customerId,
      customerName: customer.name,
      loanId:       loan.loanId,
      loanAmount:   loan.loanAmount,
      emiAmount:    loan.emiAmount,
      daysOverdue:  loan.overdueDays,
      dueDate:      loan.dueDate,
      bankName:     config.bankName,
      language:     customer.language || "en",
    });

    res.json({
      ok: true,
      callSid: call.sid,
      to: phone,
      status: call.status,
      customer: { customerId: customer.customerId, name: customer.name },
      loan: { loanId: loan.loanId, emiAmount: loan.emiAmount, overdueDays: loan.overdueDays },
    });
  } catch (err) {
    console.error("[call] failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/sessions/:callSid", (req, res) => {
  const s = sessionStore.get(req.params.callSid);
  if (!s) return res.status(404).json({ error: "not found" });
  res.json(s);
});

sarvam.startCleanupJob();

(async () => {
  try {
    await db.connect();
  } catch (err) {
    console.error("[server] MongoDB connect failed:", err.message);
    console.error("[server] start MongoDB locally or set MONGODB_URI in .env, then restart.");
    process.exit(1);
  }

  app.listen(config.port, () => {
    console.log(`[server] listening on :${config.port}`);
    console.log(`[server] PUBLIC_BASE_URL: ${config.publicBaseUrl || "(not set)"}`);
    console.log(`[server] Bank:            ${config.bankName}`);
    console.log(`[server] Groq model:      ${config.groq.model}`);
    console.log(`[server] Sarvam model:    ${config.sarvam.model}`);
  });
})();

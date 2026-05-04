const express = require("express");
const router = express.Router();

const sessionStore = require("../sessionStore");
const { STATES } = require("../stateMachine");
const llm = require("../services/llm");
const sarvam = require("../services/sarvam");
const tw = require("../services/twilio");
const config = require("../config");
const CallLog = require("../models/CallLog");
const Customer = require("../models/Customer");
const sm = require("../stateMachine");

/**
 * POST /voice — Twilio hits this when the call connects.
 * We greet the caller and ask the verification question (name only).
 */
router.post("/voice", async (req, res) => {
  const callSid = req.body.CallSid;
  const phone   = req.body.To || "";

  const session = sessionStore.getOrCreate(callSid, phone);
  session.state = STATES.VERIFY_USER;
  session.retries = 0;
  sessionStore.update(callSid, session);

  console.log(`[voice] new call ${callSid} → state=${session.state}`);

  let audioUrl = null;
  let replyText = "";

  try {
    replyText = await llm.generateReply({
      state:       STATES.VERIFY_USER,
      language:    session.language || "en",
      session,
      promiseDate: null,
      isRetry:     false,
    });
    const out = await sarvam.tts({ text: replyText, language: session.language || "en" });
    audioUrl = out.url;
  } catch (err) {
    console.error("[voice] reply/tts failed:", err.message);
    replyText = `Hello, this is calling from ${session.bankName || "your bank"}'s loan recovery team. Am I speaking with ${session.customerName}?`;
  }

  sessionStore.appendTranscript(callSid, {
    role: "bot", state: session.state, text: replyText,
  });
  console.log(`[voice] BOT: ${replyText}`);

  const twiml = tw.buildGatherResponse({
    audioUrl,
    fallbackText: replyText,
    callSid,
    language: session.language || "en",
  });

  res.type("text/xml").send(twiml);
});

/**
 * POST /status — Twilio call-status callback.
 * Persists the final CallLog to MongoDB and cleans up the in-memory session.
 */
router.post("/status", async (req, res) => {
  const callSid = req.body.CallSid;
  const status  = req.body.CallStatus;
  console.log(`[status] ${callSid} → ${status}`);

  const isFinal = ["completed", "failed", "no-answer", "busy", "canceled"].includes(status);
  if (!isFinal) return res.sendStatus(200);

  const session = sessionStore.get(callSid);
  if (!session) return res.sendStatus(200);

  let outcome = sm.outcomeFor(session.state);

  // Carrier-side terminal states (call never reached a meaningful outcome)
  if (["no-answer", "busy", "failed", "canceled"].includes(status) && outcome === "INCOMPLETE") {
    outcome = "UNREACHABLE";
  }
  if (session.escalateReason === "wrong_person") outcome = "WRONG_PERSON";

  try {
    await CallLog.create({
      callId:       callSid,
      customerId:   session.customerId,
      loanId:       session.loanId,
      phone:        session.phone,
      conversation: session.transcript,
      outcome,
      finalState:   session.state,
      language:     session.language,
      promiseDate:  session.promiseDate,
      verified:     !!session.verified,
      durationMs:   Date.now() - session.createdAt,
    });

    if (session.customerId) {
      await Customer.updateOne(
        { customerId: session.customerId },
        { $set: { lastCallStatus: outcome } }
      );
    }
    console.log(`[status] CallLog saved for ${callSid} (outcome=${outcome})`);
  } catch (err) {
    console.error("[status] failed to persist CallLog:", err.message);
  }

  sessionStore.remove(callSid);
  res.sendStatus(200);
});

module.exports = router;

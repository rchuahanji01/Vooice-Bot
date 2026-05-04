const express = require("express");
const router = express.Router();

const sessionStore = require("../sessionStore");
const sm = require("../stateMachine");
const llm = require("../services/llm");
const sarvam = require("../services/sarvam");
const tw = require("../services/twilio");
const config = require("../config");

/**
 * POST /process — invoked by <Gather action> on each speech turn.
 *
 * Per-turn pipeline:
 *   1. get caller's speech (Sarvam STT preferred; Twilio's SpeechResult as fallback)
 *   2. classify intent via Groq (structured JSON)
 *   3. compute next state via state machine
 *   4. generate reply via Groq (controlled, language-matched)
 *   5. synthesize voice via Sarvam TTS
 *   6. TwiML <Play> + <Gather> for the next turn (or hang up if terminal)
 */
router.post("/process", async (req, res) => {
  const callSid = req.body.CallSid || req.query.callSid;
  const session = sessionStore.get(callSid);

  if (!session) {
    console.warn(`[process] no session for ${callSid} — hanging up`);
    const twiml = new tw.VoiceResponse();
    twiml.say("Sorry, the session has expired. Please call back later.");
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  // ── 1. Get caller's speech ──────────────────────────────────
  let speech = "";
  let detectedLang = null;

  const recordingUrl = req.body.RecordingUrl;
  if (recordingUrl) {
    try {
      const stt = await sarvam.sttFromTwilioRecording(recordingUrl);
      speech = stt.transcript;
      detectedLang = stt.language;
      console.log(`[process] Sarvam STT → "${speech}" (lang=${stt.language})`);
    } catch (err) {
      console.error("[process] Sarvam STT failed, falling back to Twilio:", err.message);
    }
  }

  if (!speech) {
    speech = (req.body.SpeechResult || "").trim();
    if (speech) console.log(`[process] Twilio STT → "${speech}"`);
  }

  console.log(`[process] ${callSid} state=${session.state} speech="${speech}"`);

  // ── 1a. Empty speech → retry / escalate ─────────────────────
  if (!speech) {
    return await respondWithRetry(res, callSid, session,
      "I couldn't hear you, could you please repeat?");
  }

  sessionStore.appendTranscript(callSid, {
    role: "user", state: session.state, text: speech,
  });

  // ── 2. Classify intent based on current state ───────────────
  let intent = "UNKNOWN";
  let language = detectedLang || session.language || "en";
  let promiseDate = session.promiseDate;

  try {
    if (session.state === sm.STATES.VERIFY_USER) {
      const r = await llm.detectVerifyIntent(speech, session.customerName);
      intent   = r.intent || "UNKNOWN";
      language = r.language || language;
      if (intent === "VERIFIED") {
        sessionStore.update(callSid, { verified: true });
      }
    } else {
      const r = await llm.detectIntent(speech);
      intent      = r.intent || "UNKNOWN";
      language    = r.language || language;
      promiseDate = r.promise_date || promiseDate;
    }
    console.log(`[process] intent=${intent} lang=${language} promiseDate=${promiseDate || "-"}`);
  } catch (err) {
    console.error("[process] intent classification failed:", err.message);
    intent = "UNKNOWN";
  }

  sessionStore.update(callSid, { language, lastIntent: intent, promiseDate });

  // ── 3. Compute next state ───────────────────────────────────
  const { nextState, retry, escalateReason } = sm.transition(
    session.state, intent, session, config.maxRetries
  );

  if (retry) {
    sessionStore.update(callSid, {
      retries: (session.retries || 0) + 1, state: nextState,
    });
  } else {
    sessionStore.update(callSid, { state: nextState, retries: 0 });
  }

  if (escalateReason) {
    sessionStore.update(callSid, { escalateReason });
    console.log(`[process] escalating: ${escalateReason}`);
  }

  // ── 4. Generate reply ───────────────────────────────────────
  let updated = sessionStore.get(callSid);
  let speakState = updated.state;

  // INTRODUCE_LOAN is informational + asks for payment in one breath.
  // After speaking it, advance the session to ASK_PAYMENT so the user's
  // next reply is classified under the payment intent.
  let advanceAfterSpeak = null;
  if (speakState === sm.STATES.INTRODUCE_LOAN) {
    advanceAfterSpeak = sm.STATES.ASK_PAYMENT;
  }

  let replyText = "Thank you. We will follow up shortly.";
  let audioUrl = null;

  try {
    replyText = await llm.generateReply({
      state:       speakState,
      language:    updated.language,
      session:     updated,
      promiseDate: updated.promiseDate,
      isRetry:     !!retry,
    });
    const out = await sarvam.tts({ text: replyText, language: updated.language });
    audioUrl = out.url;
  } catch (err) {
    console.error("[process] reply/tts failed:", err.message);
  }

  if (advanceAfterSpeak) {
    sessionStore.update(callSid, { state: advanceAfterSpeak, retries: 0 });
    updated = sessionStore.get(callSid);
  }

  sessionStore.appendTranscript(callSid, {
    role: "bot", state: speakState, text: replyText, intent,
  });
  console.log(`[process] BOT (${speakState}, ${updated.language}): ${replyText}`);

  // ── 5. Build TwiML — terminal states hang up after speaking ─
  const twiml = tw.buildGatherResponse({
    audioUrl,
    fallbackText: replyText,
    callSid,
    language:     updated.language,
    finalTurn:    sm.isTerminal(speakState),
  });

  res.type("text/xml").send(twiml);
});

/**
 * Empty-speech retry — counts toward retries and escalates after max.
 */
async function respondWithRetry(res, callSid, session, fallbackText) {
  if ((session.retries || 0) >= config.maxRetries) {
    sessionStore.update(callSid, { state: sm.STATES.ESCALATE, escalateReason: "no_speech_max_retries" });
    const text = "I'm having trouble hearing you. A human agent will call you back shortly. Thank you.";
    let url = null;
    try {
      const out = await sarvam.tts({ text, language: session.language });
      url = out.url;
    } catch {}
    sessionStore.appendTranscript(callSid, {
      role: "bot", state: "ESCALATE", text,
    });
    const twiml = tw.buildGatherResponse({
      audioUrl: url, fallbackText: text, callSid,
      language: session.language, finalTurn: true,
    });
    return res.type("text/xml").send(twiml);
  }

  sessionStore.update(callSid, { retries: (session.retries || 0) + 1 });

  let url = null;
  try {
    const out = await sarvam.tts({ text: fallbackText, language: session.language });
    url = out.url;
  } catch {}

  sessionStore.appendTranscript(callSid, {
    role: "bot", state: session.state, text: fallbackText,
  });

  const twiml = tw.buildGatherResponse({
    audioUrl: url, fallbackText, callSid, language: session.language,
  });
  res.type("text/xml").send(twiml);
}

module.exports = router;

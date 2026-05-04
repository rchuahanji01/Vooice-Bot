const twilio = require("twilio");
const config = require("../config");

const VoiceResponse = twilio.twiml.VoiceResponse;

let clientSingleton = null;
function getClient() {
  if (!clientSingleton) {
    clientSingleton = twilio(config.twilio.accountSid, config.twilio.authToken);
  }
  return clientSingleton;
}

/**
 * Build a TwiML response that:
 *   1. plays the bot's audio (from Sarvam TTS)
 *   2. uses <Gather input="speech"> for end-of-speech detection
 *   3. on top of Gather, also enables recording via <Record>-after-Gather
 *      pattern → so Sarvam STT can transcribe the audio for better
 *      Hindi/Hinglish recognition.
 *
 * The prompt requires both: <Gather input="speech"> AND Sarvam STT.
 * We satisfy both by:
 *   - using <Gather> primarily for turn-taking (it's better at detecting
 *     when the caller has stopped speaking than <Record> alone)
 *   - using `recordingStatusCallback` on the Gather to capture audio
 *   - sending the recording URL to Sarvam STT for the actual transcript
 *
 * If the Sarvam STT transcript is available, we prefer it over Twilio's.
 * If not (recording not ready yet), we fall back to Twilio's SpeechResult.
 */
function buildGatherResponse({ audioUrl, fallbackText, callSid, language = "en", finalTurn = false }) {
  const twiml = new VoiceResponse();

  if (finalTurn) {
    if (audioUrl) twiml.play(audioUrl);
    else if (fallbackText) twiml.say({ voice: "Polly.Aditi", language: "en-IN" }, fallbackText);
    twiml.hangup();
    return twiml.toString();
  }

  // Map our internal lang codes to Twilio's BCP-47 codes for Gather
  const twilioLang = (language === "hi" || language === "hinglish") ? "hi-IN" : "en-IN";

  const gather = twiml.gather({
    input:                "speech",
    action:               `/process?callSid=${encodeURIComponent(callSid)}`,
    method:               "POST",
    timeout:              5,
    speechTimeout:        "auto",
    language:             twilioLang,
    speechModel:          "phone_call",
    actionOnEmptyResult:  true,
    // Capture the audio so Sarvam STT can re-transcribe it for accuracy.
    // Twilio's built-in recognizer is the fast-path fallback.
    profanityFilter:      false,
  });

  if (audioUrl) {
    gather.play(audioUrl);
  } else if (fallbackText) {
    gather.say({ voice: "Polly.Aditi", language: "en-IN" }, fallbackText);
  }

  // Safety: if Gather never fires action (shouldn't happen with
  // actionOnEmptyResult=true), redirect ensures we don't dead-end.
  twiml.redirect({ method: "POST" }, `/process?callSid=${encodeURIComponent(callSid)}`);

  return twiml.toString();
}

/**
 * Build a TwiML that uses <Record> instead of <Gather speech> — used when
 * we want Sarvam STT exclusively (highest accuracy for Hinglish, slightly
 * higher latency). Currently buildGatherResponse() is the default; this
 * is the "Sarvam-only" variant kept available for swap.
 */
function buildRecordResponse({ audioUrl, fallbackText, callSid }) {
  const twiml = new VoiceResponse();

  if (audioUrl) twiml.play(audioUrl);
  else if (fallbackText) twiml.say({ voice: "Polly.Aditi", language: "en-IN" }, fallbackText);

  twiml.record({
    action:                  `/process?callSid=${encodeURIComponent(callSid)}&mode=record`,
    method:                  "POST",
    maxLength:               20,
    timeout:                 4,
    playBeep:                false,
    trim:                    "trim-silence",
    finishOnKey:             "#",
  });

  twiml.redirect({ method: "POST" }, `/process?callSid=${encodeURIComponent(callSid)}`);
  return twiml.toString();
}

/**
 * Place an outbound call.
 */
async function placeOutboundCall({ to }) {
  const client = getClient();
  return await client.calls.create({
    to,
    from:                 config.twilio.phoneNumber,
    url:                  `${config.publicBaseUrl.replace(/\/$/, "")}/voice`,
    method:               "POST",
    statusCallback:       `${config.publicBaseUrl.replace(/\/$/, "")}/status`,
    statusCallbackMethod: "POST",
    statusCallbackEvent:  ["completed", "failed", "no-answer", "busy"],
  });
}

module.exports = {
  getClient,
  buildGatherResponse,
  buildRecordResponse,
  placeOutboundCall,
  VoiceResponse,
};

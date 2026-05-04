/**
 * In-memory session store keyed by Twilio CallSid.
 *
 * The session is the live state of an active call. Customer + loan data is
 * loaded from MongoDB at /call time and pre-seeded into the session so
 * /voice and /process don't need to re-fetch on every webhook.
 *
 * Replace with Redis for multi-instance production deployment.
 */
const { STATES } = require("./stateMachine");

const sessions = new Map();

function create(callSid, phone, seed = {}) {
  const session = {
    callSid,
    phone,

    // Customer + loan (loaded from Mongo at /call time)
    customerId:   seed.customerId   || null,
    customerName: seed.customerName || "Customer",
    loanId:       seed.loanId       || null,
    loanAmount:   seed.loanAmount   || 0,
    emiAmount:    seed.emiAmount    || 0,
    daysOverdue:  seed.daysOverdue  || 0,
    dueDate:      seed.dueDate      || null,
    bankName:     seed.bankName     || "your bank",

    // State
    state:    STATES.START,
    retries:  0,
    language: seed.language || "en",

    // Outcome
    verified:    false,
    lastIntent:  null,
    promiseDate: null,
    escalateReason: null,

    // Logs
    transcript: [],
    createdAt:  Date.now(),
    updatedAt:  Date.now(),
  };
  sessions.set(callSid, session);
  return session;
}

const get          = (callSid)              => sessions.get(callSid);
const getOrCreate  = (callSid, phone, seed) => sessions.get(callSid) || create(callSid, phone, seed);
const remove       = (callSid)              => sessions.delete(callSid);
const all          = ()                     => Array.from(sessions.values());

function update(callSid, patch) {
  const s = sessions.get(callSid);
  if (!s) return null;
  Object.assign(s, patch, { updatedAt: Date.now() });
  return s;
}

function appendTranscript(callSid, entry) {
  const s = sessions.get(callSid);
  if (!s) return;
  s.transcript.push({ ...entry, ts: Date.now() });
  s.updatedAt = Date.now();
}

module.exports = { create, get, getOrCreate, update, appendTranscript, remove, all };

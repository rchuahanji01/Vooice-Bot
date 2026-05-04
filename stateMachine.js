/**
 * Loan recovery state machine.
 *
 * The state machine is the only thing that decides "what happens next."
 * The LLM only:
 *   1. classifies user speech into intent (structured JSON)
 *   2. generates the wording of the bot's reply
 *
 * Safety boundary: the LLM cannot waive a loan, change the amount,
 * hang up, or escalate. Those are all expressed as transitions in code below.
 *
 * Flow:
 *   START
 *     → VERIFY_USER (name only, no OTP / no account digits)
 *         → INTRODUCE_LOAN (state the EMI + overdue days)
 *             → ASK_PAYMENT
 *                 → HANDLE_RESPONSE
 *                     → PAID | PROMISE_TO_PAY | REFUSE | DISPUTE
 *     → ESCALATE (after MAX_RETRIES UNKNOWN intents)
 *     → END
 */

const STATES = Object.freeze({
  START:           "START",
  VERIFY_USER:     "VERIFY_USER",
  INTRODUCE_LOAN:  "INTRODUCE_LOAN",
  ASK_PAYMENT:     "ASK_PAYMENT",
  HANDLE_RESPONSE: "HANDLE_RESPONSE",
  PAID:            "PAID",
  PROMISE_TO_PAY:  "PROMISE_TO_PAY",
  REFUSE:          "REFUSE",
  DISPUTE:         "DISPUTE",
  ESCALATE:        "ESCALATE",
  END:             "END",
});

const TERMINAL = new Set([
  STATES.PAID, STATES.PROMISE_TO_PAY, STATES.REFUSE,
  STATES.DISPUTE, STATES.ESCALATE, STATES.END,
]);

/**
 * Map a terminal state to a CallLog outcome string.
 */
function outcomeFor(state) {
  switch (state) {
    case STATES.PAID:           return "PAID";
    case STATES.PROMISE_TO_PAY: return "PROMISE_TO_PAY";
    case STATES.REFUSE:         return "REFUSE";
    case STATES.DISPUTE:        return "DISPUTE";
    case STATES.ESCALATE:       return "ESCALATE";
    default:                    return "INCOMPLETE";
  }
}

/**
 * Compute the next state.
 * Inputs:
 *   currentState — current state of the call
 *   intent       — VERIFIED | NOT_ME | PAID | WILL_PAY | REFUSE | DISPUTE | UNKNOWN
 *                  (WILL_PAY from intent classifier maps to PROMISE_TO_PAY state)
 *   session      — for retry counting
 *   maxRetries   — escalate after this many UNKNOWNs
 *
 * Returns: { nextState, retry?, escalateReason? }
 */
function transition(currentState, intent, session, maxRetries) {
  switch (currentState) {
    case STATES.START:
      return { nextState: STATES.VERIFY_USER };

    case STATES.VERIFY_USER:
      if (intent === "VERIFIED") return { nextState: STATES.INTRODUCE_LOAN };
      if (intent === "NOT_ME")   return { nextState: STATES.END, escalateReason: "wrong_person" };
      if ((session.retries || 0) >= maxRetries) {
        return { nextState: STATES.ESCALATE, escalateReason: "verify_failed_max_retries" };
      }
      return { nextState: STATES.VERIFY_USER, retry: true };

    case STATES.INTRODUCE_LOAN:
      // INTRODUCE_LOAN is a one-shot informational state — after the bot
      // states the EMI / overdue days, we move straight to ASK_PAYMENT.
      // (process.js advances this without waiting for user speech.)
      return { nextState: STATES.ASK_PAYMENT };

    case STATES.ASK_PAYMENT:
    case STATES.HANDLE_RESPONSE:
      switch (intent) {
        case "PAID":     return { nextState: STATES.PAID };
        case "WILL_PAY": return { nextState: STATES.PROMISE_TO_PAY };
        case "REFUSE":   return { nextState: STATES.REFUSE };
        case "DISPUTE":  return { nextState: STATES.DISPUTE };
        default:
          if ((session.retries || 0) >= maxRetries) {
            return { nextState: STATES.ESCALATE, escalateReason: "intent_unknown_max_retries" };
          }
          return { nextState: STATES.HANDLE_RESPONSE, retry: true };
      }

    case STATES.PAID:
    case STATES.PROMISE_TO_PAY:
    case STATES.REFUSE:
    case STATES.DISPUTE:
    case STATES.ESCALATE:
    case STATES.END:
      return { nextState: STATES.END };

    default:
      return { nextState: STATES.END };
  }
}

const isTerminal = (state) => TERMINAL.has(state);

module.exports = { STATES, transition, isTerminal, outcomeFor };

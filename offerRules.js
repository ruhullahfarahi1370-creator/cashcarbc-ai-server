// offerRules.js
// Rules for "old (<=2001) + non-drivable" cars with accept/decline + capped negotiation.
// Initial offer: $300 (free towing)
// Toyota/Honda max: $350 (free towing)

export function normalizeMake(make) {
  return String(make || "").trim().toLowerCase();
}

export function isOldNonDrivableEligible({ drives, year }) {
  const y = parseInt(year, 10);
  return drives === false && Number.isFinite(y) && y <= 2001;
}

export function getInitialOffer() {
  return 300;
}

export function getMaxOffer(make) {
  const m = normalizeMake(make);
  if (m.includes("toyota") || m.includes("honda")) return 350;
  return 300;
}

// Return a NUMBER or null (server code becomes much simpler)
export function parseDesiredPrice(inputDigitsOrText) {
  const raw = String(inputDigitsOrText || "").replace(/,/g, "");
  const match = raw.match(/\d{2,7}/);
  if (!match) return null;

  const value = parseInt(match[0], 10);
  if (!Number.isFinite(value) || value <= 0) return null;

  return value;
}

/**
 * If caller rejects $300, we ask "how much do you want?"
 * - If desired <= maxOffer -> accept at desired
 * - If desired > maxOffer -> counter at maxOffer (300 or 350)
 */
export function evaluateCounterOffer({ make, desiredPrice }) {
  const maxOffer = getMaxOffer(make);

  if (!Number.isFinite(desiredPrice)) {
    return {
      ok: false,
      maxOffer,
      finalOffer: null,
      decision: "INVALID_DESIRED",
      message: "Could not parse desired price.",
    };
  }

  if (desiredPrice <= maxOffer) {
    return {
      ok: true,
      maxOffer,
      finalOffer: desiredPrice,
      decision: "ACCEPT_DESIRED",
      message: `Accepted at $${desiredPrice}.`,
    };
  }

  return {
    ok: true,
    maxOffer,
    finalOffer: maxOffer,
    decision: "COUNTER_MAX",
    message: `Desired $${desiredPrice} is above cap. Counter at $${maxOffer}.`,
  };
}

/**
 * Manager review only if caller rejects the FINAL offer you gave them.
 * Call like: needsManagerReview({ acceptedFinal: false })
 */
export function needsManagerReview({ acceptedFinal }) {
  return acceptedFinal === false;
}

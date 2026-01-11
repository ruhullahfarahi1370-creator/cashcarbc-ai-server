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

export function parseDesiredPrice(inputDigitsOrText) {
  const raw = String(inputDigitsOrText || "").replace(/,/g, "");
  const match = raw.match(/\d{2,7}/);
  if (!match) return { ok: false, value: null, raw };

  const value = parseInt(match[0], 10);
  if (!Number.isFinite(value) || value <= 0) return { ok: false, value: null, raw };

  return { ok: true, value, raw };
}

/**
 * If caller rejects $300, we ask "how much do you want?"
 * - If desired <= maxOffer -> accept at desired
 * - If desired > maxOffer -> cap final offer to maxOffer (300 or 350)
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
    decision: "CAP_AT_MAX",
    message: `Desired price $${desiredPrice} is above cap. Final offer is $${maxOffer}.`,
  };
}

// If caller rejects even the capped max offer, manager review is needed.
export function needsManagerReview({ acceptedFinal }) {
  return acceptedFinal === false;
}

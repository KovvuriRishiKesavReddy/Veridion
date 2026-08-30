// Standard Indian GSTIN format: 15 characters — 2-digit state code, 10-character PAN,
// 1-digit entity number, literal 'Z', 1 checksum character.
const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

// Standard Indian PAN format: 10 characters — 5 letters, 4 digits, 1 letter.
const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;

function isValidGstin(gstin) {
  return typeof gstin === 'string' && GSTIN_REGEX.test(gstin.trim().toUpperCase());
}

function isValidPan(pan) {
  return typeof pan === 'string' && PAN_REGEX.test(pan.trim().toUpperCase());
}

module.exports = { isValidGstin, isValidPan, GSTIN_REGEX, PAN_REGEX };

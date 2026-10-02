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

// Password policy, enforced identically on the server as on the two registration
// pages (frontend/vendor/register.html, frontend/company/register.html) — the
// frontend check is for a good experience, this one is what's actually trusted,
// since a request can always bypass the browser.
const PASSWORD_MIN_LENGTH = 8;
function isStrongPassword(password) {
  return typeof password === 'string'
    && password.length >= PASSWORD_MIN_LENGTH
    && /[A-Z]/.test(password)
    && /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?`~]/.test(password);
}

module.exports = { isValidGstin, isValidPan, GSTIN_REGEX, PAN_REGEX, isStrongPassword, PASSWORD_MIN_LENGTH };

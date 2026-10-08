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

// Vendors typed their phone number by hand at registration, so it may or may not carry a
// country code. E.164 is required ("+" + country code). Returns the normalised
// number, or null if it can't be made into a plausible one.
function normalizePhoneNumber(raw, defaultCountryCode = process.env.DEFAULT_COUNTRY_CODE || '+91') {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim().replace(/[\s\-().]/g, '');
  if (!s) return null;
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (!s.startsWith('+')) {
    s = s.replace(/^0+/, ''); // national trunk prefix, e.g. 09876543210
    const cc = String(defaultCountryCode).replace(/\D/g, '');
    // Already includes the default country code without the "+" (e.g. 919876543210)?
    if (cc && s.startsWith(cc) && s.length >= cc.length + 10) s = '+' + s;
    else s = '+' + cc + s;
  }
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}

module.exports = { normalizePhoneNumber, isValidGstin, isValidPan, GSTIN_REGEX, PAN_REGEX, isStrongPassword, PASSWORD_MIN_LENGTH };

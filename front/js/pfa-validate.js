/*!
 * pfa-validate.js — one set of field rules, used by the browser and the server.
 *
 * Load in a page:   <script src="front/js/pfa-validate.js"></script>
 * Use on the server: const { validate } = require("./pfa-validate.js");
 *
 * The point of shipping one file to both is that the rules cannot drift. A
 * browser check is a courtesy to the person filling the form; it stops typos,
 * not attackers. Anyone can POST straight to /api/submit-form with curl, so
 * the server must run validate() on every request and reject on failure.
 *
 * This is not hypothetical here. The supporter database already contains
 * "union select", "<script", "1=1", "sleep(", "waitfor delay" and
 * URL-encoded quote payloads — import.js carries a list to strip them out.
 * Those rows were posted directly. No amount of client-side code would have
 * prevented them.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PFAValidate = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---- helpers ----------------------------------------------------------
  var digits = function (v) { return String(v == null ? "" : v).replace(/\D/g, ""); };
  var trim = function (v) { return String(v == null ? "" : v).trim().replace(/\s+/g, " "); };

  /* Payloads seen in the live data. Checked on every free-text field. A real
     supporter never types any of these; a scanner types nothing else. */
  var INJECTION = /(<\s*script|<\s*\/\s*script|javascript\s*:|onerror\s*=|onload\s*=|<\s*iframe|<\?php|\bunion\s+select\b|\bselect\b.{0,20}\bfrom\b|\bdrop\s+table\b|\binsert\s+into\b|\bwaitfor\s+delay\b|\bsleep\s*\(|\b1\s*=\s*1\b|\bor\s+\d+\s*=\s*\d+\b|\{\{|\$\{)/i;

  var URLISH = /(https?:\/\/|www\.[a-z0-9-]+\.[a-z]{2,})/i;

  // ---- individual checks ------------------------------------------------
  // Indian mobile: ten digits beginning 6-9. Accepts +91, 0091 and a leading 0.
  function checkMobile(raw, opts) {
    opts = opts || {};
    var d = digits(raw);
    if (!d) return opts.required ? "Enter a mobile number." : null;
    if (d.length === 12 && d.indexOf("91") === 0) d = d.slice(2);
    else if (d.length === 14 && d.indexOf("0091") === 0) d = d.slice(4);
    else if (d.length === 11 && d.charAt(0) === "0") d = d.slice(1);
    if (d.length !== 10) return "A mobile number is 10 digits. You entered " + d.length + ".";
    if (!/^[6-9]/.test(d)) return "Indian mobile numbers start with 6, 7, 8 or 9.";
    if (/^(\d)\1{9}$/.test(d)) return "That does not look like a real number.";
    return null;
  }
  function normaliseMobile(raw) {
    var d = digits(raw);
    if (d.length === 12 && d.indexOf("91") === 0) d = d.slice(2);
    else if (d.length === 14 && d.indexOf("0091") === 0) d = d.slice(4);
    else if (d.length === 11 && d.charAt(0) === "0") d = d.slice(1);
    return d.slice(0, 10);
  }

  function checkEmail(raw, opts) {
    opts = opts || {};
    var v = trim(raw).toLowerCase();
    if (!v) return opts.required ? "Enter an email address." : null;
    if (v.length > 254) return "That email address is too long.";
    if (!/^[^\s@,;:<>()\[\]\\]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(v))
      return "Check the email address — it should look like name@example.com.";
    if (/\.{2,}/.test(v)) return "Check the email address.";
    if (!/\.[a-z]{2,}$/.test(v)) return "Check the part after the dot.";
    return null;
  }

  // PAN: five letters, four digits, one letter. Fourth letter is the holder type.
  function checkPan(raw, opts) {
    opts = opts || {};
    var v = trim(raw).toUpperCase().replace(/\s/g, "");
    if (!v) return opts.required ? "Enter a PAN number." : null;
    if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v))
      return "A PAN looks like ABCDE1234F — five letters, four digits, one letter.";
    if (!/^[A-Z]{3}[PCHFATBLJG]/.test(v)) return "Check the fourth letter of the PAN.";
    return null;
  }

  function checkPincode(raw, opts) {
    opts = opts || {};
    var d = digits(raw);
    if (!d) return opts.required ? "Enter a PIN code." : null;
    if (d.length !== 6) return "An Indian PIN code is 6 digits.";
    if (d.charAt(0) === "0") return "A PIN code does not start with 0.";
    return null;
  }

  function checkName(raw, opts) {
    opts = opts || {};
    var v = trim(raw);
    if (!v) return opts.required ? "Enter a name." : null;
    if (v.length < 2) return "That name is too short.";
    if (v.length > 100) return "That name is too long.";
    if (INJECTION.test(v) || URLISH.test(v)) return "Enter a name, not a link.";
    if (/\d/.test(v)) return "A name should not contain numbers.";
    // phones autocorrect ' to ’, so accept both, and ‐-― dash variants
    if (!/^[\p{L}][\p{L}\s.'\u2019\u02bc\-\u2010-\u2015]*$/u.test(v))
      return "Use letters, spaces, apostrophes and hyphens only.";
    return null;
  }

  function checkAmount(raw, opts) {
    opts = opts || {};
    var min = opts.min == null ? 1 : opts.min;
    var max = opts.max == null ? 1000000 : opts.max;
    var v = String(raw == null ? "" : raw).replace(/[,\s\u20b9]/g, "");
    if (!v) return opts.required ? "Enter an amount." : null;
    if (!/^\d+(\.\d{1,2})?$/.test(v)) return "Enter an amount in numbers, for example 500.";
    var n = parseFloat(v);
    if (n < min) return "The smallest amount is " + min + ".";
    if (n > max) return "For amounts above " + max.toLocaleString("en-IN") + ", please contact us directly.";
    return null;
  }

  function checkText(raw, opts) {
    opts = opts || {};
    var v = trim(raw);
    var maxLen = opts.max || 2000;
    if (!v) return opts.required ? "This field is required." : null;
    if (v.length < (opts.min || 0)) return "Please write a little more.";
    if (v.length > maxLen) return "Please keep this under " + maxLen + " characters.";
    if (INJECTION.test(v)) return "Remove any code or script tags from this field.";
    return null;
  }

  function checkAddress(raw, opts) {
    opts = opts || {};
    var v = trim(raw);
    if (!v) return opts.required ? "Enter an address." : null;
    if (v.length < 5) return "That address looks too short.";
    if (v.length > 250) return "That address is too long.";
    if (INJECTION.test(v) || URLISH.test(v)) return "Enter an address, not a link.";
    return null;
  }

  function checkPlace(raw, opts) {
    opts = opts || {};
    var v = trim(raw);
    if (!v) return opts.required ? "This field is required." : null;
    if (v.length > 80) return "That is too long.";
    if (INJECTION.test(v) || URLISH.test(v)) return "Enter a place name.";
    if (/\d/.test(v)) return "A place name should not contain numbers.";
    return null;
  }

  // ---- which rule applies to which field name ---------------------------
  var FIELDS = {
    phone:          { check: checkMobile,  normalise: normaliseMobile, required: true,  maxlength: 10 },
    mobile:         { check: checkMobile,  normalise: normaliseMobile, required: true,  maxlength: 10 },
    billing_tel:    { check: checkMobile,  normalise: normaliseMobile, required: true,  maxlength: 10 },
    email:          { check: checkEmail,   required: true,  maxlength: 254 },
    billing_email:  { check: checkEmail,   required: true,  maxlength: 254 },
    pan:            { check: checkPan,     normalise: function (v) { return trim(v).toUpperCase().replace(/\s/g, "").slice(0, 10); }, required: false, maxlength: 10 },
    pincode:        { check: checkPincode, normalise: function (v) { return digits(v).slice(0, 6); }, required: false, maxlength: 6 },
    pin:            { check: checkPincode, normalise: function (v) { return digits(v).slice(0, 6); }, required: false, maxlength: 6 },
    billing_zip:    { check: checkPincode, normalise: function (v) { return digits(v).slice(0, 6); }, required: false, maxlength: 6 },
    name:           { check: checkName,    required: true,  maxlength: 100 },
    billing_name:   { check: checkName,    required: true,  maxlength: 100 },
    cname:          { check: checkName,    required: false, maxlength: 100 },
    amount:         { check: checkAmount,  required: true },
    custom_amount:  { check: checkAmount,  required: false },
    address:        { check: checkAddress, required: false, maxlength: 250 },
    billing_address:{ check: checkAddress, required: false, maxlength: 250 },
    city:           { check: checkPlace,   required: false, maxlength: 80 },
    billing_city:   { check: checkPlace,   required: false, maxlength: 80 },
    state:          { check: checkPlace,   required: false, maxlength: 80 },
    billing_state:  { check: checkPlace,   required: false, maxlength: 80 },
    message:        { check: checkText,    required: false, maxlength: 2000 },
    question:       { check: checkText,    required: true,  maxlength: 2000, min: 10 },
    remarks:        { check: checkText,    required: false, maxlength: 2000 },
    bank_name:      { check: checkPlace,   required: false, maxlength: 80 },
    bank_details:   { check: checkText,    required: false, maxlength: 200 },
    designation:    { check: checkPlace,   required: false, maxlength: 80 }
  };

  /* Validate a whole submission. Returns {} when clean, otherwise a map of
     field name to message. Give the server the same object the browser sent. */
  function validate(data, opts) {
    opts = opts || {};
    var errors = {};
    Object.keys(FIELDS).forEach(function (field) {
      if (!(field in data)) return;
      var rule = FIELDS[field];
      var required = opts.required ? opts.required.indexOf(field) !== -1 : rule.required;
      var msg = rule.check(data[field], {
        required: required,
        max: rule.maxlength,
        min: rule.min,
        min: rule.min
      });
      if (msg) errors[field] = msg;
    });
    // a submission with no way to reach the person is not useful
    if (opts.requireContact && !errors.email && !errors.phone &&
        !trim(data.email) && !digits(data.phone) && !digits(data.mobile))
      errors.email = "Give an email address or a phone number so we can reply.";
    return errors;
  }

  return {
    FIELDS: FIELDS,
    validate: validate,
    checkMobile: checkMobile,
    checkEmail: checkEmail,
    checkPan: checkPan,
    checkPincode: checkPincode,
    checkName: checkName,
    checkAmount: checkAmount,
    checkText: checkText,
    normaliseMobile: normaliseMobile,
    INJECTION: INJECTION
  };
});

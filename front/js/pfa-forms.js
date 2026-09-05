/*!
 * pfa-forms.js — applies pfa-validate.js rules to every form on the page.
 *
 * Load after pfa-validate.js:
 *   <script src="front/js/pfa-validate.js"></script>
 *   <script src="front/js/pfa-forms.js"></script>
 *
 * No jQuery. Nothing to configure per page — fields are matched on their name
 * attribute, which is already consistent across the site.
 *
 * This stops typos. It is not a security control: the same rules must run in
 * the /api route, because a POST does not have to come from this page.
 */
(function () {
  "use strict";
  var V = window.PFAValidate;
  if (!V) { console.error("pfa-forms.js: load pfa-validate.js first"); return; }

  var STYLE =
    ".pfa-err{display:block;color:#b3261e;font-size:13px;line-height:1.4;margin-top:4px}" +
    ".pfa-invalid{border-color:#b3261e !important;background-image:none !important}" +
    ".pfa-invalid:focus{outline:2px solid #b3261e;outline-offset:-2px}" +
    "@media (prefers-reduced-motion:no-preference){.pfa-shake{animation:pfaShake .25s}}" +
    "@keyframes pfaShake{25%{transform:translateX(-3px)}75%{transform:translateX(3px)}}";
  var st = document.createElement("style");
  st.textContent = STYLE;
  document.head.appendChild(st);

  var uid = 0;

  function errorNode(el) {
    var id = el.getAttribute("aria-describedby");
    var node = id && document.getElementById(id);
    if (!node) {
      node = document.createElement("span");
      node.className = "pfa-err";
      node.id = "pfa-err-" + (++uid);
      node.setAttribute("role", "alert");
      el.setAttribute("aria-describedby", node.id);
      el.parentNode.insertBefore(node, el.nextSibling);
    }
    return node;
  }

  function setError(el, msg) {
    var node = errorNode(el);
    if (msg) {
      node.textContent = msg;
      el.classList.add("pfa-invalid");
      el.setAttribute("aria-invalid", "true");
    } else {
      node.textContent = "";
      el.classList.remove("pfa-invalid");
      el.removeAttribute("aria-invalid");
    }
    return !msg;
  }

  function ruleFor(el) {
    var name = (el.getAttribute("name") || "").replace(/\[\]$/, "");
    return V.FIELDS[name] || null;
  }

  function isRequired(el, rule) {
    return el.hasAttribute("required") || rule.required;
  }

  function checkField(el) {
    var rule = ruleFor(el);
    if (!rule) return true;
    if (el.type === "hidden" || el.type === "radio" || el.type === "checkbox" || el.disabled) return true;
    if (el.offsetParent === null && el.type !== "hidden") return true;
    // a field that is present but empty and not required is fine
    var msg = rule.check(el.value, {
      required: isRequired(el, rule),
      max: rule.maxlength,
      min: rule.min
    });
    return setError(el, msg);
  }

  /* Type is corrected here rather than in the markup so the fix cannot be lost
     when a page is regenerated. type=number is wrong for a phone: it accepts
     1e5 and a leading minus, strips leading zeros, and hands back an empty
     string for anything it cannot parse, so bad input arrives as blank. */
  function prepare(el) {
    var rule = ruleFor(el);
    if (!rule) return;
    var name = (el.getAttribute("name") || "").replace(/\[\]$/, "");
    var numeric = ["phone", "mobile", "billing_tel", "pincode", "pin", "billing_zip"];

    if (numeric.indexOf(name) !== -1) {
      if (el.type === "number") el.type = "tel";
      el.setAttribute("inputmode", "numeric");
      el.setAttribute("autocomplete", name === "billing_zip" || name === "pin" || name === "pincode" ? "postal-code" : "tel");
    }
    if (name === "email" || name === "billing_email") {
      el.setAttribute("inputmode", "email");
      el.setAttribute("autocomplete", "email");
    }
    if (name === "name" || name === "billing_name") el.setAttribute("autocomplete", "name");
    if (rule.maxlength && !el.hasAttribute("maxlength") && el.tagName !== "SELECT")
      el.setAttribute("maxlength", String(rule.maxlength));
    if (name === "pan") el.style.textTransform = "uppercase";

    // keep unwanted characters out as they are typed
    if (rule.normalise) {
      el.addEventListener("input", function () {
        var pos = el.selectionStart, before = el.value, after = rule.normalise(before);
        if (before !== after) {
          el.value = after;
          try { el.setSelectionRange(pos - (before.length - after.length), pos - (before.length - after.length)); } catch (e) {}
        }
      });
    }
    el.addEventListener("blur", function () { checkField(el); });
    el.addEventListener("input", function () {
      if (el.classList.contains("pfa-invalid")) checkField(el);   // clear as soon as it is fixed
    });
  }

  function wireForm(form) {
    var fields = form.querySelectorAll("input[name], select[name], textarea[name]");
    Array.prototype.forEach.call(fields, prepare);

    form.addEventListener("submit", function (e) {
      var bad = null;
      Array.prototype.forEach.call(fields, function (el) {
        if (!checkField(el) && !bad) bad = el;
      });
      if (bad) {
        e.preventDefault();
        e.stopPropagation();
        bad.focus();
        bad.classList.add("pfa-shake");
        setTimeout(function () { bad.classList.remove("pfa-shake"); }, 300);
        if (bad.scrollIntoView) bad.scrollIntoView({ block: "center", behavior: "smooth" });
        return false;
      }
      // stop a second submit while the first is in flight
      var btn = form.querySelector('[type="submit"]');
      if (btn && !btn.disabled) {
        btn.disabled = true;
        setTimeout(function () { btn.disabled = false; }, 8000);
      }
    }, true);
  }

  function init() {
    Array.prototype.forEach.call(document.querySelectorAll("form"), wireForm);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

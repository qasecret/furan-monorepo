package io.furan.sdk

/**
 * JavaScript executed inside the user's browser via the capture driver's
 * SpecDriver.executeScript(...) (Selenium, Playwright, …). Walks the live DOM,
 * generates a CSS path for each element, records bbox + visibility-filtered
 * map. Leads with `return` so it survives both Selenium's executeScript
 * convention and Playwright's function-wrapping evaluate. Returns a JSON
 * STRING (not an object): primitive-string results serialize most reliably
 * across drivers.
 *
 * Filter: width >= 8 && height >= 8 && visibility !== "hidden" &&
 * display !== "none". Drops spacers and hidden modals. Map size on typical
 * pages: 1-50 KB. Capped at MAX_ELEMENTS=5000 entries.
 *
 * Selector format: `html > body > #id > tag.class > tag:nth-child(N)`.
 * Walks the parent chain. Uses `#id` when present (stops the chain). Appends
 * `.className` list when class names are simple identifiers. Adds
 * `:nth-child(N)` only when N siblings share the same tag.
 *
 * Envelope: { v: 1, elements: { selector: bbox, ... }, capturedAt: ms }.
 * `v` is a forward-compat schema marker; future shape changes bump it so
 * older consumers reject unknown shapes via a 1-line check.
 */
const val ELEMENT_BBOX_SCRIPT: String = """
return (function() {
  var MIN_SIZE = 8;
  var MAX_ELEMENTS = 5000;

  function cssPath(el) {
    var parts = [];
    while (el && el.nodeType === 1) {
      if (el.id) {
        parts.unshift('#' + CSS.escape(el.id));
        break;
      }
      var part = el.tagName.toLowerCase();
      if (el.classList && el.classList.length > 0) {
        var classes = [];
        for (var ci = 0; ci < el.classList.length; ci++) {
          var c = el.classList[ci];
          if (/^[a-zA-Z0-9_-]+${'$'}/.test(c)) {
            classes.push(CSS.escape(c));
          }
        }
        if (classes.length > 0) part += '.' + classes.join('.');
      }
      var parent = el.parentElement;
      if (parent) {
        var siblings = parent.children;
        var sameTagCount = 0;
        for (var si = 0; si < siblings.length; si++) {
          if (siblings[si].tagName === el.tagName) sameTagCount++;
        }
        if (sameTagCount > 1) {
          var idx = 0;
          for (var ki = 0; ki < siblings.length; ki++) {
            if (siblings[ki] === el) { idx = ki + 1; break; }
          }
          part += ':nth-child(' + idx + ')';
        }
      }
      parts.unshift(part);
      el = parent;
    }
    return parts.join(' > ');
  }

  var out = {};
  var count = 0;
  var els = document.querySelectorAll('*');
  for (var i = 0; i < els.length && count < MAX_ELEMENTS; i++) {
    var el = els[i];
    var r = el.getBoundingClientRect();
    if (r.width < MIN_SIZE || r.height < MIN_SIZE) continue;
    var style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    out[cssPath(el)] = {
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height)
    };
    count++;
  }
  return JSON.stringify({ v: 1, elements: out, capturedAt: Date.now() });
})()
"""

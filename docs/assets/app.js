/* facebook-mcp docs — progressive enhancement only.
   No dependencies, no network calls. Everything degrades gracefully:
   with JS disabled the page is a complete, readable document. */
(function () {
  "use strict";

  var reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;

  function on(el, ev, fn) {
    if (el) el.addEventListener(ev, fn);
  }

  /* ---------- Mobile sidebar toggle ---------- */
  (function sidebar() {
    var btn = document.getElementById("menuBtn");
    var side = document.getElementById("sidebar");
    var backdrop = document.getElementById("backdrop");
    if (!btn || !side) return;

    function open() {
      side.classList.add("open");
      if (backdrop) backdrop.classList.add("show");
      btn.setAttribute("aria-expanded", "true");
    }
    function close() {
      side.classList.remove("open");
      if (backdrop) backdrop.classList.remove("show");
      btn.setAttribute("aria-expanded", "false");
    }
    on(btn, "click", function () {
      if (side.classList.contains("open")) close();
      else open();
    });
    on(backdrop, "click", close);
    // Close after tapping any in-page link.
    side.querySelectorAll('a[href^="#"]').forEach(function (a) {
      on(a, "click", close);
    });
    on(document, "keydown", function (e) {
      if (e.key === "Escape") close();
    });
  })();

  /* ---------- Back-to-top ---------- */
  (function toTop() {
    var btn = document.getElementById("toTop");
    if (!btn) return;
    function upd() {
      if (window.scrollY > 700) btn.classList.add("show");
      else btn.classList.remove("show");
    }
    on(window, "scroll", upd, { passive: true });
    upd();
    on(btn, "click", function () {
      window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
    });
  })();

  /* ---------- Accessibility: column-header scope ---------- */
  document.querySelectorAll("thead th").forEach(function (th) {
    if (!th.getAttribute("scope")) th.setAttribute("scope", "col");
  });

  /* ---------- Copy buttons on .codeblock ---------- */
  document.querySelectorAll(".codeblock").forEach(function (block) {
    var code = block.querySelector("code");
    if (!code) return;
    var btn = document.createElement("button");
    btn.className = "copy-btn";
    btn.type = "button";
    btn.textContent = "copy";
    btn.setAttribute("aria-label", "Copy code");
    on(btn, "click", function () {
      copyText(code.innerText, btn, "copy");
    });
    block.appendChild(btn);
  });

  /* ---------- Quick-start command copy (whole card is a target) ---------- */
  document.querySelectorAll(".qs-cmd").forEach(function (cmd) {
    var btn = cmd.querySelector(".qs-cmd-copy");
    var text = cmd.getAttribute("data-copy") || "";
    function doCopy(e) {
      e.stopPropagation();
      copyText(text, btn, "copy");
    }
    on(btn, "click", doCopy);
    on(cmd, "click", function (e) {
      if (e.target === btn) return;
      copyText(text, btn, "copy");
    });
  });

  function copyText(text, btn, resetLabel) {
    function ok() {
      if (!btn) return;
      var prev = btn.textContent;
      btn.textContent = "copied";
      btn.classList.add("copied");
      setTimeout(function () {
        btn.textContent = resetLabel || prev;
        btn.classList.remove("copied");
      }, 1400);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(ok, function () {});
    } else {
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        ok();
      } catch (_) {
        /* clipboard unavailable — no-op */
      }
    }
  }

  /* ---------- Heading anchor links ---------- */
  document
    .querySelectorAll("section[id] > h2, section[id] > h3")
    .forEach(function (h) {
      var sec = h.closest("section[id]");
      if (!sec) return;
      var a = document.createElement("a");
      a.className = "anchor";
      a.href = "#" + sec.id;
      a.textContent = "#";
      a.setAttribute("aria-label", "Link to this section");
      h.appendChild(a);
    });

  /* ---------- Scrollspy: highlight active sidebar link ---------- */
  (function scrollspy() {
    var links = Array.prototype.slice.call(
      document.querySelectorAll('.sidebar nav a[href^="#"]')
    );
    if (!links.length || !("IntersectionObserver" in window)) return;
    var map = {};
    links.forEach(function (a) {
      var id = a.getAttribute("href").slice(1);
      var sec = document.getElementById(id);
      if (sec) map[id] = a;
    });
    var current = null;
    function setActive(id) {
      if (current === id) return;
      current = id;
      links.forEach(function (a) {
        a.classList.toggle("active", a.getAttribute("href") === "#" + id);
      });
    }
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) setActive(e.target.id);
        });
      },
      { rootMargin: "-72px 0px -70% 0px", threshold: 0 }
    );
    Object.keys(map).forEach(function (id) {
      io.observe(document.getElementById(id));
    });
  })();

  /* ---------- Quick-demo tabs ---------- */
  (function demoTabs() {
    var tabs = Array.prototype.slice.call(
      document.querySelectorAll('.tabs .tab[role="tab"]')
    );
    if (!tabs.length) return;
    function activate(tab) {
      tabs.forEach(function (t) {
        var sel = t === tab;
        t.classList.toggle("active", sel);
        t.setAttribute("aria-selected", sel ? "true" : "false");
        var panel = document.getElementById(t.getAttribute("aria-controls"));
        if (panel) panel.classList.toggle("active", sel);
      });
    }
    tabs.forEach(function (t) {
      on(t, "click", function () {
        activate(t);
      });
      on(t, "keydown", function (e) {
        var i = tabs.indexOf(t);
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          tabs[(i + 1) % tabs.length].focus();
          activate(tabs[(i + 1) % tabs.length]);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          tabs[(i - 1 + tabs.length) % tabs.length].focus();
          activate(tabs[(i - 1 + tabs.length) % tabs.length]);
        }
      });
    });
  })();

  /* ---------- Quick-start client-config tabs ---------- */
  (function configTabs() {
    var tabs = Array.prototype.slice.call(document.querySelectorAll(".qs-tab"));
    var pathEl = document.getElementById("cfg-path");
    var bodyEl = document.getElementById("cfg-body");
    var copyBtn = document.querySelector(".qs-config-copy");
    if (!tabs.length || !bodyEl) return;

    var args = '["/abs/path/facebook-mcp/build/index.js"]';
    var envBlock =
      '"env": {\n        "FB_ACCESS_TOKEN": "EAA…",\n        "FB_PAGE_ID": "1234567890",\n        "FB_APP_SECRET": "…"\n      }';

    var CFG = {
      claude: {
        path: "~/Library/Application Support/Claude/claude_desktop_config.json",
        body:
          '{\n  "mcpServers": {\n    "facebook": {\n      "command": "node",\n      "args": ' +
          args +
          ",\n      " +
          envBlock +
          "\n    }\n  }\n}",
      },
      vscode: {
        path: ".vscode/mcp.json",
        body:
          '{\n  "servers": {\n    "facebook": {\n      "command": "node",\n      "args": ' +
          args +
          ",\n      " +
          envBlock +
          "\n    }\n  }\n}",
      },
      cursor: {
        path: "~/.cursor/mcp.json",
        body:
          '{\n  "mcpServers": {\n    "facebook": {\n      "command": "node",\n      "args": ' +
          args +
          ",\n      " +
          envBlock +
          "\n    }\n  }\n}",
      },
    };

    function show(key) {
      var cfg = CFG[key];
      if (!cfg) return;
      if (pathEl) pathEl.textContent = cfg.path;
      bodyEl.textContent = cfg.body;
    }
    tabs.forEach(function (t) {
      on(t, "click", function () {
        tabs.forEach(function (x) {
          var sel = x === t;
          x.classList.toggle("active", sel);
          x.setAttribute("aria-selected", sel ? "true" : "false");
        });
        show(t.getAttribute("data-cfg"));
      });
    });
    on(copyBtn, "click", function () {
      copyText(bodyEl.textContent, copyBtn, "copy");
    });
  })();

  /* ---------- Hero terminal: gently replay the entrance ---------- */
  (function terminalLoop() {
    if (reduceMotion) return;
    var body = document.getElementById("term-body");
    if (!body) return;
    setInterval(function () {
      var clone = body.cloneNode(true);
      body.parentNode.replaceChild(clone, body);
      body = clone;
    }, 11000);
  })();
})();

// ninja-p2p site behaviour. Everything here is progressive: the pages read
// fine with scripts disabled.
(function () {
  "use strict";

  var root = document.documentElement;
  root.classList.remove("no-js");
  root.classList.add("js");

  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // SVG packets are SMIL animations, which CSS cannot stop. With reduced
  // motion, park each one 60% along its first segment so direction still reads.
  if (reducedMotion) {
    document.querySelectorAll("animateMotion").forEach(function (motion) {
      var n = (motion.getAttribute("path") || "").match(/-?\d+(\.\d+)?/g);
      var dot = motion.parentNode;
      if (n && n.length >= 4) {
        dot.setAttribute("cx", +n[0] + (n[2] - n[0]) * 0.6);
        dot.setAttribute("cy", +n[1] + (n[3] - n[1]) * 0.6);
      }
      dot.removeChild(motion);
    });
  }

  // ── Theme ────────────────────────────────────────────────────────────────
  function effectiveTheme() {
    var set = root.getAttribute("data-theme");
    if (set === "light" || set === "dark") return set;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  document.querySelectorAll(".theme-toggle").forEach(function (button) {
    button.addEventListener("click", function () {
      var next = effectiveTheme() === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("ninja-p2p-theme", next); } catch (e) { /* storage unavailable */ }
    });
  });

  // ── Navigation ───────────────────────────────────────────────────────────
  var nav = document.querySelector(".nav");
  if (nav) {
    var onScroll = function () { nav.classList.toggle("scrolled", window.scrollY > 8); };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();

    var menu = nav.querySelector(".menu-toggle");
    if (menu) {
      menu.addEventListener("click", function () {
        var open = nav.classList.toggle("open");
        menu.setAttribute("aria-expanded", open ? "true" : "false");
      });
      nav.querySelectorAll(".nav-links a").forEach(function (link) {
        link.addEventListener("click", function () {
          nav.classList.remove("open");
          menu.setAttribute("aria-expanded", "false");
        });
      });
    }
  }

  // ── Copy buttons ─────────────────────────────────────────────────────────
  document.querySelectorAll(".copy-btn").forEach(function (button) {
    button.addEventListener("click", function () {
      var box = button.closest(".install, .codeblock");
      var pre = box && box.querySelector("pre");
      if (!pre) return;
      var clone = pre.cloneNode(true);
      clone.querySelectorAll(".prompt, .t-p").forEach(function (el) { el.remove(); });
      var text = clone.textContent.replace(/\s+$/, "");
      var done = function () {
        button.classList.add("copied");
        setTimeout(function () { button.classList.remove("copied"); }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () {});
      }
    });
  });

  // ── Hero feed ────────────────────────────────────────────────────────────
  var feedRows = document.querySelectorAll(".feed-row");
  if (feedRows.length) {
    if (reducedMotion) {
      feedRows.forEach(function (row) { row.classList.add("shown"); });
    } else {
      var shown = 0;
      var tick = function () {
        if (shown < feedRows.length) {
          feedRows[shown].classList.add("shown");
          shown += 1;
          setTimeout(tick, 1500);
        } else {
          setTimeout(function () {
            feedRows.forEach(function (row) { row.classList.remove("shown"); });
            shown = 0;
            setTimeout(tick, 700);
          }, 6000);
        }
      };
      setTimeout(tick, 500);
    }
  }

  // ── How-it-works story ───────────────────────────────────────────────────
  // Stage elements declare the steps they belong to: data-show="2", "1-3",
  // "4+", or a comma list of those.
  function inRange(spec, step) {
    return spec.split(",").some(function (part) {
      part = part.trim();
      if (/^\d+\+$/.test(part)) return step >= parseInt(part, 10);
      var m = part.match(/^(\d+)-(\d+)$/);
      if (m) return step >= +m[1] && step <= +m[2];
      return step === parseInt(part, 10);
    });
  }

  var story = document.querySelector(".story");
  if (story) {
    var steps = Array.prototype.slice.call(story.querySelectorAll(".step"));
    var stageEls = story.querySelectorAll(".story-stage [data-show]");
    var dots = story.querySelectorAll(".progress i");
    var current = 0;

    var setStep = function (n) {
      if (n === current) return;
      current = n;
      steps.forEach(function (s, i) { s.classList.toggle("active", i + 1 === n); });
      stageEls.forEach(function (el) { el.classList.toggle("on", inRange(el.getAttribute("data-show"), n)); });
      dots.forEach(function (d, i) { d.classList.toggle("on", i < n); });
    };

    var pending = false;
    var measure = function () {
      pending = false;
      var narrow = window.innerWidth <= 980;
      var line = window.innerHeight * (narrow ? 0.78 : 0.55);
      var n = 1;
      steps.forEach(function (s, i) {
        if (s.getBoundingClientRect().top < line) n = i + 1;
      });
      setStep(n);
    };
    window.addEventListener("scroll", function () {
      if (!pending) { pending = true; requestAnimationFrame(measure); }
    }, { passive: true });
    window.addEventListener("resize", measure);
    measure();
  }

  // ── Swarm illustration ───────────────────────────────────────────────────
  var swarm = document.querySelector(".swarm-peers");
  if (swarm) {
    var COUNT = 64;
    var rows = {};
    swarm.querySelectorAll("[data-peer]").forEach(function (row) {
      var grid = row.querySelector(".chunks");
      var cells = [];
      for (var i = 0; i < COUNT; i += 1) {
        var cell = document.createElement("i");
        grid.appendChild(cell);
        cells.push(cell);
      }
      rows[row.getAttribute("data-peer")] = { cells: cells, have: [], pct: row.querySelector(".pct") };
    });

    var seeder = rows.seeder;
    seeder.cells.forEach(function (c) { c.className = "c-seed"; });
    if (seeder.pct) seeder.pct.textContent = "100%";

    var reset = function () {
      ["a", "b"].forEach(function (k) {
        var r = rows[k];
        r.have = [];
        r.cells.forEach(function (c) { c.className = ""; });
        if (r.pct) r.pct.textContent = "0%";
      });
    };

    var missing = function (r) {
      var out = [];
      for (var i = 0; i < COUNT; i += 1) if (!r.have[i]) out.push(i);
      return out;
    };

    var take = function (r, i, cls) {
      r.have[i] = true;
      r.cells[i].className = cls;
      if (r.pct) r.pct.textContent = Math.round((COUNT - missing(r).length) / COUNT * 100) + "%";
    };

    var step = function () {
      var a = rows.a, b = rows.b;
      var aNeed = missing(a), bNeed = missing(b);
      if (!aNeed.length && !bNeed.length) return false;
      // Random tie-breaking: every downloader picks a different chunk, so they
      // quickly hold pieces the other lacks and can trade them.
      if (aNeed.length) {
        var ia = aNeed[Math.floor(Math.random() * aNeed.length)];
        take(a, ia, b.have[ia] && Math.random() < 0.5 ? "c-peer" : "c-seed-chunk");
      }
      if (bNeed.length) {
        var fromA = bNeed.filter(function (i) { return a.have[i]; });
        if (fromA.length && Math.random() < 0.6) {
          take(b, fromA[Math.floor(Math.random() * fromA.length)], "c-peer");
        } else {
          take(b, bNeed[Math.floor(Math.random() * bNeed.length)], "c-seed-chunk");
        }
      }
      return true;
    };

    if (reducedMotion) {
      while (step()) { /* fill to the finished state */ }
    } else {
      var timer = null;
      var run = function () {
        if (timer) return;
        timer = setInterval(function () {
          if (!step()) {
            clearInterval(timer);
            timer = null;
            setTimeout(function () { reset(); run(); }, 2600);
          }
        }, 110);
      };
      var stop = function () { if (timer) { clearInterval(timer); timer = null; } };
      if ("IntersectionObserver" in window) {
        new IntersectionObserver(function (entries) {
          entries.forEach(function (e) { if (e.isIntersecting) run(); else stop(); });
        }).observe(swarm);
      } else {
        run();
      }
    }
  }

  // ── Docs: highlight the section being read ───────────────────────────────
  var toc = document.querySelector(".docs-toc");
  if (toc) {
    var tocLinks = Array.prototype.slice.call(toc.querySelectorAll("a[href^='#']"));
    var targets = tocLinks.map(function (a) { return document.getElementById(a.getAttribute("href").slice(1)); });
    var tocPending = false;
    var updateToc = function () {
      tocPending = false;
      var active = 0;
      targets.forEach(function (el, i) { if (el && el.getBoundingClientRect().top < 140) active = i; });
      tocLinks.forEach(function (a, i) { a.classList.toggle("active", i === active); });
    };
    window.addEventListener("scroll", function () {
      if (!tocPending) { tocPending = true; requestAnimationFrame(updateToc); }
    }, { passive: true });
    updateToc();
  }
})();

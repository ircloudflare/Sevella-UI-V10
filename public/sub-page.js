// Subscription page logic: theme + language toggles, usage/time rendering, copy buttons, QR modal.
// Data is injected by the server as JSON in #subData.
(function () {
  "use strict";

  var DAY = 86400000;
  var HOUR = 3600000;

  var D = JSON.parse(document.getElementById("subData").textContent);
  // Use the server clock for "time left" so a wrong device clock does not skew it.
  var OFFSET = (D.serverNow || Date.now()) - Date.now();
  var root = document.documentElement;

  var I18N = {
    en: {
      langBtn: "EN",
      sub: "Subscription",
      active: "Active",
      expired: "Expired",
      capped: "Data limit reached",
      dataLabel: "Data remaining",
      timeLabel: "Time remaining",
      unlimited: "Unlimited",
      noExpiry: "No expiry",
      ofX: "of {x}",
      usedSoFar: "{x} used so far",
      ends: "Ends {x}",
      ended: "Ended {x}",
      copySub: "Copy subscription link",
      copyCfg: "Copy config link",
      qr: "QR code",
      copied: "Copied",
      close: "Close",
      lightTheme: "Light theme",
      darkTheme: "Dark theme",
      langGroup: "Language",
      themeGroup: "Theme",
      units: { B: "B", KB: "KB", MB: "MB", GB: "GB", TB: "TB" },
      day: ["day", "days"],
      hour: ["hour", "hours"],
      months: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    },
    fa: {
      langBtn: "فا",
      sub: "اشتراک",
      active: "فعال",
      expired: "منقضی شده",
      capped: "حجم تمام شده",
      dataLabel: "حجم باقی\u200cمانده",
      timeLabel: "زمان باقی\u200cمانده",
      unlimited: "نامحدود",
      noExpiry: "بدون انقضا",
      ofX: "از {x}",
      usedSoFar: "{x} مصرف شده",
      ends: "پایان: {x}",
      ended: "پایان یافت: {x}",
      copySub: "کپی لینک اشتراک",
      copyCfg: "کپی لینک کانفیگ",
      qr: "کد QR",
      copied: "کپی شد",
      close: "بستن",
      lightTheme: "تم روشن",
      darkTheme: "تم تیره",
      langGroup: "زبان",
      themeGroup: "تم",
      units: { B: "بایت", KB: "کیلوبایت", MB: "مگابایت", GB: "گیگابایت", TB: "ترابایت" },
      day: ["روز", "روز"],
      hour: ["ساعت", "ساعت"],
      // Gregorian month names in Persian, so both languages show the same date.
      months: ["ژانویه", "فوریه", "مارس", "آوریل", "مه", "ژوئن", "ژوئیه", "اوت", "سپتامبر", "اکتبر", "نوامبر", "دسامبر"]
    }
  };

  var lang = root.getAttribute("lang") === "fa" ? "fa" : "en";
  var theme = root.getAttribute("data-theme") === "dark" ? "dark" : "light";

  function $(id) { return document.getElementById(id); }
  function T() { return I18N[lang]; }
  function fill(tpl, x) { return tpl.replace("{x}", x); }
  function plural(pair, n) { return n === 1 ? pair[0] : pair[1]; }

  // Latin digits -> Persian digits (and decimal point) when the page is in Persian.
  function digits(str) {
    if (lang !== "fa") return str;
    return str
      .replace(/\d/g, function (c) { return "۰۱۲۳۴۵۶۷۸۹".charAt(Number(c)); })
      .replace(/\./g, "٫");
  }

  function fmtBytes(bytes) {
    var keys = ["B", "KB", "MB", "GB", "TB"];
    var i = 0;
    var n = bytes;
    while (n >= 1024 && i < keys.length - 1) { n /= 1024; i++; }
    var num = i === 0 ? String(Math.round(n)) : n.toFixed(n >= 100 ? 0 : 1).replace(/\.0$/, "");
    return { num: digits(num), unit: T().units[keys[i]] };
  }

  // Rounded up, like the dashboard: 29.2 days left shows as 30 days.
  function fmtDuration(ms) {
    if (ms >= DAY) {
      var d = Math.ceil(ms / DAY);
      return { num: digits(String(d)), unit: plural(T().day, d) };
    }
    var h = Math.max(1, Math.ceil(ms / HOUR));
    return { num: digits(String(h)), unit: plural(T().hour, h) };
  }

  function joinNU(o) { return o.num + " " + o.unit; }

  function fmtDate(ts) {
    var d = new Date(ts);
    var month = T().months[d.getMonth()];
    var day = digits(String(d.getDate()));
    var withYear = d.getFullYear() !== new Date(Date.now() + OFFSET).getFullYear();
    var year = digits(String(d.getFullYear()));
    if (lang === "fa") return day + " " + month + (withYear ? " " + year : "");
    return month + " " + day + (withYear ? ", " + year : "");
  }

  // prefix: "d" (data card) or "t" (time card)
  function setMetric(prefix, m) {
    var num = $(prefix + "Num");
    num.textContent = m.num;
    num.className = "num" + (m.word ? " word" : "");
    $(prefix + "Unit").textContent = m.unit || "";
    $(prefix + "Of").textContent = m.of || "";

    var track = $(prefix + "Track");
    var bar = $(prefix + "Fill");
    track.hidden = m.pct == null;
    bar.style.width = (m.pct == null ? 0 : m.pct) + "%";
    bar.className = "fill " + (prefix === "d" ? "f1" : "f2") + (m.level ? " " + m.level : "");

    var cap = $(prefix + "Cap");
    cap.textContent = m.cap || "";
    cap.hidden = !m.cap;

    $(prefix + "Card").classList.toggle("bad", m.level === "bad");
  }

  function render() {
    var t = T();
    var now = Date.now() + OFFSET;
    var exp = D.expiresAt ? Date.parse(D.expiresAt) : null;
    var expired = !!D.expired || (exp != null && now >= exp);
    var limit = D.dataLimitBytes;
    var used = D.usedBytes || 0;
    var capped = !!D.capped || (limit != null && used >= limit);

    // ---- status pill ----
    var pill = $("pill");
    var bad = expired || capped;
    pill.className = "pill" + (bad ? " bad" : "");
    pill.textContent = expired ? t.expired : capped ? t.capped : t.active;

    // ---- data card ----
    var usedText = fill(t.usedSoFar, joinNU(fmtBytes(used)));
    if (limit == null) {
      setMetric("d", { num: t.unlimited, word: true, cap: usedText });
    } else if (capped) {
      // Show "0 GB" in the same unit as the limit, not "0 B".
      var limitFmt = fmtBytes(limit);
      setMetric("d", {
        num: digits("0"),
        unit: limitFmt.unit,
        of: fill(t.ofX, joinNU(limitFmt)),
        pct: 0,
        level: "bad",
        cap: usedText
      });
    } else {
      var left = fmtBytes(limit - used);
      var ratio = (limit - used) / limit;
      setMetric("d", {
        num: left.num,
        unit: left.unit,
        of: fill(t.ofX, joinNU(fmtBytes(limit))),
        pct: Math.max(2, Math.min(100, ratio * 100)),
        level: ratio < 0.15 ? "warn" : "",
        cap: usedText
      });
    }

    // ---- time card ----
    if (exp == null) {
      setMetric("t", { num: t.noExpiry, word: true });
    } else if (expired) {
      setMetric("t", { num: t.expired, word: true, pct: 0, level: "bad", cap: fill(t.ended, fmtDate(exp)) });
    } else {
      var remaining = exp - now;
      var total = D.expiryDays != null ? D.expiryDays * DAY : exp - Date.parse(D.createdAt);
      total = Math.max(total, remaining, HOUR);
      var dur = fmtDuration(remaining);
      setMetric("t", {
        num: dur.num,
        unit: dur.unit,
        of: fill(t.ofX, joinNU(fmtDuration(total))),
        pct: Math.max(2, Math.min(100, (remaining / total) * 100)),
        level: remaining <= 3 * DAY ? "warn" : "",
        cap: fill(t.ends, fmtDate(exp))
      });
    }
  }

  function applyStatic() {
    var t = T();
    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      el.textContent = t[el.getAttribute("data-i18n")];
    });
    document.querySelectorAll("[data-i18n-aria]").forEach(function (el) {
      el.setAttribute("aria-label", t[el.getAttribute("data-i18n-aria")]);
    });
    $("langFa").textContent = I18N.fa.langBtn;
    $("langEn").textContent = I18N.en.langBtn;
    document.querySelectorAll("[data-theme-set]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-theme-set") === theme));
    });
    document.querySelectorAll("[data-lang-set]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-lang-set") === lang));
    });
  }

  function store(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* storage may be blocked */ }
  }

  function setTheme(next) {
    theme = next;
    root.setAttribute("data-theme", next);
    store("sub_theme", next);
    applyStatic();
  }

  function setLang(next) {
    lang = next;
    root.setAttribute("lang", next);
    root.setAttribute("dir", next === "fa" ? "rtl" : "ltr");
    store("sub_lang", next);
    applyStatic();
    render();
  }

  // ---- copy buttons ----
  function copyText(text, btn, key) {
    function flash() {
      btn.textContent = T().copied;
      btn.disabled = true;
      setTimeout(function () {
        btn.textContent = T()[key];
        btn.disabled = false;
      }, 1200);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(flash).catch(function () { window.prompt("Copy this:", text); });
    } else {
      window.prompt("Copy this:", text);
    }
  }

  // ---- QR modal ----
  function openQr() {
    var body = $("qrBody");
    body.innerHTML = "";
    try {
      // eslint-disable-next-line no-undef
      new QRCode(body, { text: D.configLink, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.L });
    } catch (e) {
      body.textContent = "QR unavailable";
    }
    $("qrOverlay").hidden = false;
  }
  function closeQr() { $("qrOverlay").hidden = true; }

  document.querySelectorAll("[data-theme-set]").forEach(function (b) {
    b.addEventListener("click", function () { setTheme(b.getAttribute("data-theme-set")); });
  });
  document.querySelectorAll("[data-lang-set]").forEach(function (b) {
    b.addEventListener("click", function () { setLang(b.getAttribute("data-lang-set")); });
  });
  $("copySub").addEventListener("click", function () { copyText(D.subLink, this, "copySub"); });
  $("copyCfg").addEventListener("click", function () { copyText(D.configLink, this, "copyCfg"); });
  $("showQr").addEventListener("click", openQr);
  $("qrClose").addEventListener("click", closeQr);
  $("qrOverlay").addEventListener("click", function (e) { if (e.target === this) closeQr(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeQr(); });

  applyStatic();
  render();
  // Keep "time left" fresh while the tab stays open.
  setInterval(render, 30000);
})();

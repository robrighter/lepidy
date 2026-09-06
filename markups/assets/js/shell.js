/* Lepidy mockups — shared shell. Renders the rail, topbar and walkthrough bar
   so every screen stays in sync, and wires the small interactions that make a
   static mockup feel like a product (tabs, switches, radio cards, theme). */

(function () {
  const D = window.LEPIDY;

  /* ---------- icons ---------- */
  const P = 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';
  const ICONS = {
    home:   `<path ${P} d="M3 9.5 10 3l7 6.5V16a1 1 0 0 1-1 1h-3v-5H7v5H4a1 1 0 0 1-1-1z"/>`,
    inbox:  `<path ${P} d="M3 11h4l1.2 2h3.6L13 11h4M3 11l2-6.5h10L17 11v4.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>`,
    /* the mark itself, scaled 64->20. An outline butterfly is illegible at 17px. */
    agent:  `<g fill="currentColor" transform="scale(.3125)">
      <path d="M31 33 C29 17 21 4 11 6 C1 8 1 24 12 31 C18 35 26 36 31 33 Z"/>
      <path d="M31 33 C28 42 22 56 14 55 C6 54 6 41 15 36 C20 33 27 31 31 33 Z" opacity=".78"/>
      <path d="M33 33 C35 17 43 4 53 6 C63 8 63 24 52 31 C46 35 38 36 33 33 Z"/>
      <path d="M33 33 C36 42 42 56 50 55 C58 54 58 41 49 36 C44 33 37 31 33 33 Z" opacity=".78"/></g>`,
    key:    `<circle ${P} cx="7" cy="7.5" r="3.6"/><path ${P} d="M9.6 10.1 16 16.5m-2.4-1.2 1.5-1.5m-3.3-.6 1.5-1.5"/>`,
    search: `<circle ${P} cx="9" cy="9" r="5.5"/><path ${P} d="m13.2 13.2 3.3 3.3"/>`,
    hash:   `<path ${P} d="M7 3.5 5.5 16.5M13 3.5 11.5 16.5M3.5 7.5h13M3 12.5h13"/>`,
    lock:   `<rect ${P} x="4" y="9" width="12" height="8" rx="2"/><path ${P} d="M6.8 9V6.6a3.2 3.2 0 0 1 6.4 0V9"/>`,
    plus:   `<path ${P} d="M10 4v12M4 10h12"/>`,
    check:  `<path ${P} d="m4 10.5 4 4 8-9"/>`,
    x:      `<path ${P} d="M5 5l10 10M15 5 5 15"/>`,
    bell:   `<path ${P} d="M6 8a4 4 0 1 1 8 0c0 3 1.2 4.2 1.8 4.8H4.2C4.8 12.2 6 11 6 8z"/><path ${P} d="M8.4 15.4a1.8 1.8 0 0 0 3.2 0"/>`,
    dots:   `<circle cx="5" cy="10" r="1.4" fill="currentColor"/><circle cx="10" cy="10" r="1.4" fill="currentColor"/><circle cx="15" cy="10" r="1.4" fill="currentColor"/>`,
    clip:   `<path ${P} d="M14.5 9.2 9.7 14a3 3 0 0 1-4.2-4.2l5.4-5.4a2 2 0 0 1 2.8 2.8L8.3 12.6a1 1 0 0 1-1.4-1.4l4.6-4.6"/>`,
    at:     `<circle ${P} cx="10" cy="10" r="3"/><path ${P} d="M13 7v4a2.2 2.2 0 0 0 4.2.9A8 8 0 1 0 14 16.4"/>`,
    smile:  `<circle ${P} cx="10" cy="10" r="7"/><path ${P} d="M7.2 11.6a3.4 3.4 0 0 0 5.6 0"/><circle cx="7.6" cy="8.2" r=".9" fill="currentColor"/><circle cx="12.4" cy="8.2" r=".9" fill="currentColor"/>`,
    send:   `<path ${P} d="M4 10 16.5 4.5 12 17l-2.4-5.2z"/>`,
    shield: `<path ${P} d="M10 3l6 2.2v4.4c0 4-2.6 6.5-6 7.4-3.4-.9-6-3.4-6-7.4V5.2z"/>`,
    term:   `<rect ${P} x="3" y="4" width="14" height="12" rx="2"/><path ${P} d="m6.5 8.5 2.2 2-2.2 2M11 12.5h3"/>`,
    laptop: `<rect ${P} x="4" y="5" width="12" height="8" rx="1.4"/><path ${P} d="M2.5 15.5h15"/>`,
    phone:  `<rect ${P} x="6" y="2.5" width="8" height="15" rx="2"/><path ${P} d="M9 15.2h2"/>`,
    clock:  `<circle ${P} cx="10" cy="10" r="7"/><path ${P} d="M10 6v4.2l2.6 1.6"/>`,
    pause:  `<path ${P} d="M7.5 5v10M12.5 5v10"/>`,
    power:  `<path ${P} d="M10 3.5v6.2"/><path ${P} d="M14.6 6a6 6 0 1 1-9.2 0"/>`,
    sun:    `<circle ${P} cx="10" cy="10" r="3.4"/><path ${P} d="M10 2.6v1.8M10 15.6v1.8M2.6 10h1.8M15.6 10h1.8M4.8 4.8l1.3 1.3M13.9 13.9l1.3 1.3M15.2 4.8l-1.3 1.3M6.1 13.9l-1.3 1.3"/>`,
    moon:   `<path ${P} d="M15.5 11.6A6.2 6.2 0 0 1 8.4 4.5a6.5 6.5 0 1 0 7.1 7.1z"/>`,
    grid:   `<rect ${P} x="3.5" y="3.5" width="5.5" height="5.5" rx="1.4"/><rect ${P} x="11" y="3.5" width="5.5" height="5.5" rx="1.4"/><rect ${P} x="3.5" y="11" width="5.5" height="5.5" rx="1.4"/><rect ${P} x="11" y="11" width="5.5" height="5.5" rx="1.4"/>`,
    left:   `<path ${P} d="M12 4.5 6.5 10l5.5 5.5"/>`,
    right:  `<path ${P} d="M8 4.5 13.5 10 8 15.5"/>`,
    down:   `<path ${P} d="M5 8l5 5 5-5"/>`
  };
  function icon(name, cls) {
    return `<svg class="${cls || "ic"}" viewBox="0 0 20 20" aria-hidden="true">${ICONS[name] || ""}</svg>`;
  }

  /* ---------- avatars: generated, never a stock photo of a person ---------- */
  const PAIRS = [["#7C3AED","#C4B5FD"],["#5B8CF5","#9F5BF5"],["#FF8FA3","#FFD1C4"],
                 ["#34D399","#A7F3D0"],["#F59E0B","#FDE68A"],["#6366F1","#E0E7FF"]];
  function initials(n) {
    return n.replace(/^[@#]/, "").split(/[\s.\-_]+/).filter(Boolean)
            .slice(0, 2).map(w => w[0]).join("").toUpperCase();
  }
  function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }
  function avatar(name, size, round) {
    const [a, b] = PAIRS[hash(name) % PAIRS.length];
    const id = "g" + hash(name);
    const r = round ? size / 2 : Math.round(size * 0.24);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
      <rect width="${size}" height="${size}" rx="${r}" fill="url(#${id})"/>
      <text x="50%" y="50%" dy=".35em" text-anchor="middle" fill="#fff"
        font-family="Inter,sans-serif" font-weight="650" font-size="${size * 0.4}">${initials(name)}</text></svg>`;
    return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
  }
  function av(name, size, round) {
    return `<img class="av ${round ? "av-round" : ""}" src="${avatar(name, size || 32, round)}"
      width="${size || 32}" height="${size || 32}" alt="">`;
  }
  /* an agent's avatar is the butterfly mark on a tinted tile — never initials,
     because you must be able to tell a person from an agent at a glance */
  function agentAv(size) {
    const s = size || 32;
    return `<span class="av" style="width:${s}px;height:${s}px;border-radius:${Math.round(s*.24)}px;
      background:linear-gradient(135deg,#EDE4FF,#FFE9EF);display:grid;place-items:center">
      <img src="assets/img/mark.svg" width="${Math.round(s*.68)}" height="${Math.round(s*.68)}" alt=""></span>`;
  }

  /* ---------- rail ---------- */
  function rail(active) {
    const nav = D.NAV.map(n => `
      <a class="navitem ${n.id === active ? "is-active" : ""}" href="${n.href}">
        ${icon(n.icon)}<span class="lbl">${n.label}</span>
        ${n.badge ? `<span class="badge">${n.badge}</span>` : ""}
      </a>`).join("");

    const chans = D.CHANNELS.map(c => `
      <a class="navitem ${c.id === active ? "is-active" : ""}" href="${c.queue ? "queue.html" : "channel.html"}">
        ${icon(c.priv ? "lock" : "hash")}<span class="lbl">${c.name}</span>
        ${c.queue ? '<span class="xs" title="ranked by 🔥">🔥</span>' : ""}
        ${c.unread ? `<span class="badge">${c.unread}</span>` : ""}
      </a>`).join("");

    const ppl = D.PEOPLE.map(p => `
      <a class="navitem" href="#">${av(p.name, 20, true)}<span class="lbl">${p.name}</span>
        <span class="dot ${p.status}"></span></a>`).join("");

    const bots = D.AGENTS.slice(0, 2).map(a => `
      <a class="navitem" href="agent.html">${agentAv(20)}<span class="lbl">@${a.handle}</span>
        ${a.session === "waiting" ? '<span class="dot on" title="session live"></span>' : ""}</a>`).join("");

    return `<div class="rail col">
      <div class="rail-brand"><img src="assets/img/mark.svg" alt=""><b>Lepidy</b></div>
      <button class="newbtn">${icon("plus")} New</button>
      <div class="rail-scroll">
        ${nav}
        <div class="navsec"><span>Channels</span><span>+</span></div>
        ${chans}
        <div class="navsec"><span>People &amp; agents</span><span>+</span></div>
        ${ppl}${bots}
      </div>
      <div class="rail-foot">
        <a class="navitem" href="sessions.html">${av("Maya Chen", 20, true)}<span class="lbl">Maya Chen</span>
          <span class="xs muted">Free</span></a>
      </div>
    </div>`;
  }

  /* ---------- topbar ---------- */
  function topbar(o) {
    return `<div class="topbar">
      <div class="topbar-t">${o.icon ? icon(o.icon) : ""}<span>${o.title}</span>
        ${o.pill || ""}</div>
      ${o.sub ? `<span class="topbar-sub">${o.sub}</span>` : ""}
      <span class="spacer"></span>
      <div class="search">${icon("search")}<span>Search or ask anything</span><kbd>⌘K</kbd></div>
      <span class="spacer"></span>
      ${o.actions || ""}
      <button class="iconbtn" id="themeBtn" title="Toggle theme">${icon("moon")}</button>
      <button class="iconbtn">${icon("bell")}</button>
    </div>`;
  }

  /* ---------- walkthrough bar ---------- */
  function walkbar(id) {
    const i = D.PAGES.findIndex(p => p.id === id);
    if (i < 0) return "";
    const prev = D.PAGES[i - 1], next = D.PAGES[i + 1];
    return `<div id="walk">
      <a class="wk-btn" href="index.html" title="All screens">${icon("grid")}</a>
      <a class="wk-btn ${prev ? "" : "off"}" href="${prev ? prev.file : "#"}">${icon("left")}</a>
      <div class="wk-mid">
        <b>${i + 1}/${D.PAGES.length} · ${D.PAGES[i].name}</b>
        <span>${D.PAGES[i].note}</span>
      </div>
      <a class="wk-btn ${next ? "" : "off"}" href="${next ? next.file : "#"}">${icon("right")}</a>
      <button class="wk-btn" id="wkHide" title="Hide">${icon("x")}</button>
    </div>`;
  }

  /* ---------- interactions ---------- */
  function wire() {
    document.addEventListener("click", e => {
      const sw = e.target.closest(".switch");
      if (sw) { sw.classList.toggle("on"); return; }

      const ro = e.target.closest(".radio-opt");
      if (ro) { ro.parentElement.querySelectorAll(".radio-opt")
        .forEach(n => n.classList.toggle("is-active", n === ro));
        const t = ro.dataset.reveal;
        if (t) document.querySelectorAll("[data-revealgroup]").forEach(n =>
          n.hidden = n.dataset.revealgroup !== t);
        return; }

      const tb = e.target.closest(".tab, .ctab");
      if (tb) { tb.parentElement.querySelectorAll(".tab, .ctab")
        .forEach(n => n.classList.toggle("is-active", n === tb));
        const t = tb.dataset.pane;
        if (t) document.querySelectorAll("[data-panegroup]").forEach(n =>
          n.hidden = n.dataset.panegroup !== t);
        return; }

      const th = e.target.closest("#themeBtn");
      if (th) {
        const dark = document.documentElement.dataset.theme === "dark";
        document.documentElement.dataset.theme = dark ? "light" : "dark";
        localStorage.setItem("lepidy-theme", dark ? "light" : "dark");
        th.innerHTML = icon(dark ? "moon" : "sun");
        return;
      }
      if (e.target.closest("#wkHide")) document.getElementById("walk").remove();
    });
  }

  /* ---------- boot ---------- */
  function mount(o) {
    const t = localStorage.getItem("lepidy-theme");
    if (t) document.documentElement.dataset.theme = t;
    const r = document.querySelector("[data-rail]");
    if (r) r.outerHTML = rail(o.active);
    const tb = document.querySelector("[data-topbar]");
    if (tb && o.topbar) tb.outerHTML = topbar(o.topbar);
    if (o.page) document.body.insertAdjacentHTML("beforeend", walkbar(o.page));
    if (t === "dark") {
      const b = document.getElementById("themeBtn");
      if (b) b.innerHTML = icon("sun");
    }
    wire();
  }

  window.UI = { icon, av, agentAv, avatar, mount, rail, topbar, initials };
})();

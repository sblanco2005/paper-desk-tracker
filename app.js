/**
 * Paper Desk Tracker — Santiago Blanco
 * Paper trading only. Vanilla JS, localStorage persistence.
 * v1.1 — Swift Dev UX polish
 */
(function () {
  "use strict";

  const STORAGE_KEY = "paper-desk-tracker-v1";
  const RISK_CEILING = 2000;

  /** @type {object|null} */
  let state = null;

  // ---------- helpers ----------
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

  function money(n, opts = {}) {
    const abs = Math.abs(n);
    const formatted = abs.toLocaleString("en-US", {
      minimumFractionDigits: opts.digits ?? 0,
      maximumFractionDigits: opts.digits ?? 0,
    });
    const sign = n < 0 ? "−" : opts.signed && n > 0 ? "+" : "";
    return `${sign}$${formatted}`;
  }

  function moneyDec(n, signed = false) {
    return money(n, { digits: 2, signed });
  }

  function pct(n) {
    const sign = n > 0 ? "+" : n < 0 ? "−" : "";
    return `${sign}${Math.abs(n).toFixed(1)}%`;
  }

  function pnlClass(n) {
    if (n > 0.005) return "pos";
    if (n < -0.005) return "neg";
    return "neu";
  }

  function latestMark(pos) {
    if (!pos.marks || !pos.marks.length) return pos.entry;
    return pos.marks[pos.marks.length - 1].mid;
  }

  function paperValue(pos) {
    return Math.abs(latestMark(pos)) * 100 * pos.qty;
  }

  function uPnL(pos) {
    // Debit vertical: uP&L = (mark − entry) × 100 × qty
    return (latestMark(pos) - pos.entry) * 100 * pos.qty;
  }

  function formatTs(iso) {
    try {
      const d = new Date(iso);
      return (
        d.toLocaleString("en-US", {
          timeZone: "America/New_York",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        }) + " ET"
      );
    } catch {
      return iso;
    }
  }

  function relativeTs(iso) {
    try {
      const d = new Date(iso);
      const now = Date.now();
      const diff = Math.max(0, now - d.getTime());
      const sec = Math.floor(diff / 1000);
      if (sec < 60) return "just now";
      const min = Math.floor(sec / 60);
      if (min < 60) return `${min}m ago`;
      const hr = Math.floor(min / 60);
      if (hr < 48) return `${hr}h ago`;
      const day = Math.floor(hr / 24);
      if (day < 14) return `${day}d ago`;
      return formatTs(iso);
    } catch {
      return iso;
    }
  }

  function legsHtml(legs) {
    return legs
      .map((l) => {
        const cls = l.side === "long" ? "leg-long" : "leg-short";
        const side = l.side === "long" ? "long" : "short";
        return `<span class="${cls}">${side} ${l.exp} ${l.strike}${l.right}</span>`;
      })
      .join(" / ");
  }

  function legsPlain(legs) {
    return legs
      .map((l) => `${l.side} ${l.exp} ${l.strike}${l.right}`)
      .join(" / ");
  }

  let toastTimer = null;
  function showToast(msg) {
    const el = $("#toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 1600);
  }

  // ---------- book math ----------
  function bookStats(data) {
    const positions = data.positions || [];
    const open = positions.filter((p) => p.status !== "EXIT");
    const openCapital = open.reduce((s, p) => s + p.cost, 0);
    // Capital is invested basis, including settled/EXIT tickets, so a flat
    // book keeps its denominator and realized P&L remains visible.
    const capital = positions.reduce((s, p) => s + p.cost, 0);
    // latestMark() returns the settlement mark for EXIT positions.
    const mtm = positions.reduce((s, p) => s + paperValue(p), 0);
    const net = positions.reduce((s, p) => s + uPnL(p), 0);
    const roc = capital > 0 ? (net / capital) * 100 : 0;
    const unused = RISK_CEILING - openCapital;

    const bucketUsed = { A: 0, B: 0, C: 0 };
    open.forEach((p) => {
      const b = p.bucket || "A";
      if (bucketUsed[b] !== undefined) bucketUsed[b] += p.cost;
    });

    return { capital, mtm, net, roc, unused, bucketUsed, openCount: open.length };
  }

  // ---------- persistence ----------
  function revisedAtOf(obj) {
    const r = obj?.meta?.revisedAt;
    return typeof r === "string" ? r : "";
  }

  function hasTickets(obj) {
    return (
      obj !== null &&
      typeof obj === "object" &&
      !Array.isArray(obj) &&
      Array.isArray(obj.positions) &&
      obj.positions.length > 0
    );
  }

  function cloneBook(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  /**
   * Soft-fetch remote desk-latest.json. Prefer it when meta.revisedAt is
   * strictly newer than the current state (or when local is empty). Fail soft.
   * @returns {Promise<boolean>} true if state was replaced
   */
  async function tryAdoptRemoteDesk(opts = {}) {
    const soft = opts.soft === true;
    const DESK_LATEST_URL =
      (typeof window !== "undefined" && window.__DESK_LATEST_URL__) ||
      "data/desk-latest.json";
    try {
      const res = await fetch(DESK_LATEST_URL, { cache: "no-store" });
      if (!res.ok) return false;
      const remote = await res.json();
      if (!hasTickets(remote)) return false;
      const remoteRev = revisedAtOf(remote);
      const curRev = revisedAtOf(state);
      // Adopt when remote is newer, or when we have no tickets yet.
      if (hasTickets(state) && !(remoteRev && remoteRev > curRev)) {
        return false;
      }
      state = cloneBook(remote);
      persist();
      if (soft) {
        try {
          renderAll();
        } catch (e) {
          console.warn("soft refresh render failed", e);
        }
      }
      return true;
    } catch (e) {
      // Offline / missing file — keep current state
      console.warn("desk-latest fetch skipped", e);
      return false;
    }
  }

  async function loadState() {
    let localState = null;
    let localParsed = false;

    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        localState = JSON.parse(raw);
        localParsed = true;
      }
    } catch (e) {
      console.warn("localStorage read failed", e);
    }

    // Prefer an inlined seed when localStorage is empty/corrupt, or when the
    // published seed is newer. Keep equal-revision local edits intact.
    const seed =
      typeof window !== "undefined" && window.__SEED__ && typeof window.__SEED__ === "object"
        ? window.__SEED__
        : null;
    const seedHasPositions = hasTickets(seed);
    const localIsObject =
      localState !== null && typeof localState === "object" && !Array.isArray(localState);
    const localHasTickets = hasTickets(localState);
    const seedRevisedAt = revisedAtOf(seed);
    const localRevisedAt = revisedAtOf(localState);
    const seedIsNewer =
      seedHasPositions &&
      localHasTickets &&
      seedRevisedAt &&
      seedRevisedAt > localRevisedAt;

    if (seedHasPositions && (!localHasTickets || seedIsNewer)) {
      state = cloneBook(seed);
      persist();
    } else if (localParsed && localIsObject) {
      state = localState;
    } else if (seed) {
      // Prefer inlined __SEED__ (single-file build) over network fetch
      state = cloneBook(seed);
      persist();
    } else {
      const res = await fetch("data/seed.json", { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to load seed.json");
      state = await res.json();
      persist();
    }

    // After resolving seed/local, prefer a newer remote desk-latest.json.
    await tryAdoptRemoteDesk();
    return state;
  }

  let softRefreshTimer = null;
  function scheduleSoftRefresh() {
    clearTimeout(softRefreshTimer);
    softRefreshTimer = setTimeout(() => {
      tryAdoptRemoteDesk({ soft: true });
    }, 250);
  }

  function startDeskLiveRefresh() {
    // Soft-refresh on visibility/focus every few minutes without wiping
    // equal-revision local edits (tryAdoptRemoteDesk only adopts newer rev).
    const MIN_INTERVAL_MS = 3 * 60 * 1000;
    let lastAttempt = 0;
    const maybeRefresh = () => {
      const now = Date.now();
      if (now - lastAttempt < MIN_INTERVAL_MS) return;
      lastAttempt = now;
      scheduleSoftRefresh();
    };
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") maybeRefresh();
    });
    window.addEventListener("focus", maybeRefresh);
    setInterval(maybeRefresh, MIN_INTERVAL_MS);
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn("localStorage write failed", e);
    }
  }

  // ---------- renderers ----------
  function renderBook() {
    const s = bookStats(state);
    const el = $("#screen-book");

    // Only show buckets with capital used; quiet + Add for empty slots
    const usedBuckets = ["A", "B", "C"].filter((k) => s.bucketUsed[k] > 0);
    const nextEmpty = ["A", "B", "C"].find((k) => s.bucketUsed[k] === 0);
    const bucketHtml =
      usedBuckets
        .map(
          (k) => `
          <div class="bucket-line ${k.toLowerCase()}">
            <span class="b-name">Bucket ${k} · <span class="b-val">${money(s.bucketUsed[k])}</span></span>
          </div>`
        )
        .join("") ||
      `<div class="bucket-line a"><span class="b-name">Bucket A · <span class="b-val">${money(0)}</span></span></div>`;

    el.innerHTML = `
      <div class="card">
        <div class="card-title">Options Desk · Paper Book</div>
        <div class="hero-pnl">
          <div class="label">Net P&amp;L</div>
          <div class="value ${pnlClass(s.net)}">${money(s.net, { signed: true })}</div>
        </div>
        <div class="secondary-row">
          <div class="secondary-metric">
            <div class="label">Capital</div>
            <div class="value">${money(s.capital)}</div>
          </div>
          <div class="secondary-metric">
            <div class="label">ROC</div>
            <div class="value ${pnlClass(s.roc)}">${pct(s.roc)}</div>
          </div>
        </div>
        <div class="tertiary-row">
          <div class="tertiary-metric">
            <div class="label">MTM (paper)</div>
            <div class="value">${money(Math.round(s.mtm))}</div>
          </div>
          <div class="tertiary-metric">
            <div class="label">Unused ceiling</div>
            <div class="value">${money(s.unused)}</div>
          </div>
        </div>
        <details class="disclosure">
          <summary>
            <span>How ROC is calculated</span>
            <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
          </summary>
          <div class="disclosure-body">
            <p><strong>ROC</strong> = Net P&amp;L ÷ Capital invested (${money(s.capital)}) — <em>not</em> ÷ risk ceiling. Ceiling is unused capacity, not the denominator.</p>
            <p><strong>Ceiling:</strong> $${RISK_CEILING.toLocaleString()} − open capital ${money(RISK_CEILING - s.unused)} = ${money(s.unused)} unused. Invested basis remains ${money(s.capital)} after exits. Do not divide P&amp;L by $2,000.</p>
          </div>
        </details>
      </div>

      <div class="card">
        <div class="card-title">Bucket capital used</div>
        <div class="bucket-list">
          ${bucketHtml}
          ${
            nextEmpty
              ? `<button type="button" class="bucket-add" data-action="add-bucket" data-bucket="${nextEmpty}">+ Add bucket</button>`
              : ""
          }
        </div>
      </div>

      <div class="card">
        <div class="card-title">Snapshot</div>
        <div class="kv-grid">
          <div class="kv"><span class="k">Open tickets</span><span class="v">${s.openCount}</span></div>
          <div class="kv"><span class="k">Mode</span><span class="v">PAPER</span></div>
          <div class="kv"><span class="k">Seed date</span><span class="v">${state.meta?.seedDate || "—"}</span></div>
          <div class="kv"><span class="k">Owner</span><span class="v">S. Blanco</span></div>
        </div>
      </div>
      <p class="footer-note">Paper only · no live broker · teaching ledger</p>
    `;

    const addBtn = el.querySelector("[data-action='add-bucket']");
    if (addBtn) {
      addBtn.addEventListener("click", () => {
        // Stub: ensure empty bucket key exists in state.buckets (non-destructive)
        const key = addBtn.dataset.bucket;
        state.buckets = state.buckets || {};
        if (!state.buckets[key]) {
          state.buckets[key] = {
            label: key === "B" ? "Tactical" : key === "C" ? "Event / lottery" : "Core",
            used: 0,
          };
        }
        // Visual cue only — create an empty line by forcing a zero-used display flag
        state._showBuckets = state._showBuckets || {};
        state._showBuckets[key] = true;
        persist();
        showToast(`Bucket ${key} ready`);
        renderBook();
      });
    }

    // If user stub-added empty buckets, show them quietly at $0
    if (state._showBuckets) {
      const list = el.querySelector(".bucket-list");
      if (list) {
        ["A", "B", "C"].forEach((k) => {
          if (state._showBuckets[k] && s.bucketUsed[k] === 0 && !list.querySelector(`.bucket-line.${k.toLowerCase()}`)) {
            const line = document.createElement("div");
            line.className = `bucket-line ${k.toLowerCase()}`;
            line.innerHTML = `<span class="b-name">Bucket ${k} · <span class="b-val">${money(0)}</span></span>`;
            const add = list.querySelector(".bucket-add");
            if (add) list.insertBefore(line, add);
            else list.appendChild(line);
          }
        });
        // Refresh + Add to next still-empty not yet shown
        const still = ["A", "B", "C"].find(
          (k) => s.bucketUsed[k] === 0 && !state._showBuckets[k]
        );
        const add = list.querySelector(".bucket-add");
        if (add) {
          if (still) {
            add.dataset.bucket = still;
          } else {
            add.remove();
          }
        }
      }
    }
  }

  function renderPositions() {
    const el = $("#screen-positions");
    const positions = state.positions || [];
    if (!positions.length) {
      el.innerHTML = `<div class="empty">No positions in the book.</div>`;
      return;
    }

    el.innerHTML =
      `<div class="section-label">${positions.length} ticket${positions.length === 1 ? "" : "s"}</div>` +
      positions
        .map((p) => {
          const mark = latestMark(p);
          const val = paperValue(p);
          const upnl = uPnL(p);
          return `
          <article class="pos-card" data-id="${p.id}">
            <div class="pos-strip">
              <div class="pos-strip-left">
                <span class="pos-under">${p.underlying}</span>
                <span class="pos-struct">${p.structure} ×${p.qty}</span>
              </div>
              <div class="pos-strip-right">
                <span class="status-badge ${p.status}">${p.status}</span>
                <span class="pos-upnl ${pnlClass(upnl)}">${money(Math.round(upnl), { signed: true })}</span>
              </div>
            </div>
            <div class="pos-body">
              <div class="pos-id">${p.id} · bucket ${p.bucket}</div>
              <div class="legs">${legsHtml(p.legs)}</div>
              <p class="thesis">${p.thesis}</p>
              <div class="kv-grid">
                <div class="kv"><span class="k">Entry</span><span class="v">${p.entry.toFixed(2)}</span></div>
                <div class="kv">
                  <span class="k">Cost $ <button type="button" class="help-q" data-action="cost-help" data-id="${p.id}" aria-label="How Cost $ is calculated">?</button></span>
                  <span class="v">${money(p.cost)}</span>
                </div>
                <div class="kv"><span class="k">Max loss</span><span class="v">${money(p.maxLoss)}</span></div>
                <div class="kv"><span class="k">Mark</span><span class="v">${mark.toFixed(2)}</span></div>
                <div class="kv"><span class="k">Paper value</span><span class="v">${money(Math.round(val))}</span></div>
                <div class="kv"><span class="k">Bucket</span><span class="v">${p.bucket}</span></div>
                <div class="cost-help" data-help-for="${p.id}"><strong>Cost $:</strong> |net debit| × 100 × qty = |${p.entry.toFixed(2)}| × 100 × ${p.qty} = ${money(p.cost)}. Max loss on a debit vertical equals Cost $.</div>
              </div>
              <div class="pos-actions">
                <button class="btn secondary primary" data-action="mark" data-id="${p.id}">Update mark</button>
                <button class="btn secondary ${p.status === "HOLD" ? "danger" : "success"}" data-action="toggle" data-id="${p.id}">
                  ${p.status === "HOLD" ? "Mark EXIT" : "Mark HOLD"}
                </button>
              </div>
            </div>
          </article>`;
        })
        .join("");

    el.querySelectorAll("[data-action='mark'], [data-action='toggle']").forEach((btn) => {
      btn.addEventListener("click", onPosAction);
    });
    el.querySelectorAll("[data-action='cost-help']").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const help = el.querySelector(`[data-help-for="${id}"]`);
        if (help) help.classList.toggle("open");
      });
    });

    // Swipe gestures on position cards
    el.querySelectorAll(".pos-card").forEach(bindPosSwipe);
  }

  function bindPosSwipe(card) {
    let startX = 0;
    let startY = 0;
    let dx = 0;
    let tracking = false;
    const THRESH = 72;

    const onStart = (e) => {
      const t = e.touches ? e.touches[0] : e;
      startX = t.clientX;
      startY = t.clientY;
      dx = 0;
      tracking = true;
      card.classList.add("swiping");
    };

    const onMove = (e) => {
      if (!tracking) return;
      const t = e.touches ? e.touches[0] : e;
      const adx = t.clientX - startX;
      const ady = t.clientY - startY;
      if (Math.abs(ady) > Math.abs(adx) && Math.abs(ady) > 12) {
        tracking = false;
        card.style.transform = "";
        card.classList.remove("swiping");
        return;
      }
      dx = adx;
      const clamped = Math.max(-110, Math.min(110, dx));
      card.style.transform = `translateX(${clamped * 0.35}px)`;
      if (e.cancelable && Math.abs(adx) > 10) e.preventDefault();
    };

    const onEnd = () => {
      if (!tracking && dx === 0) {
        card.style.transform = "";
        card.classList.remove("swiping");
        return;
      }
      tracking = false;
      card.classList.remove("swiping");
      card.style.transform = "";
      const id = card.dataset.id;
      const pos = state.positions.find((p) => p.id === id);
      if (!pos) return;
      if (dx <= -THRESH) {
        // Swipe left → Mark EXIT
        if (pos.status !== "EXIT") {
          pos.status = "EXIT";
          persist();
          renderAll();
          showToast(`${id} → EXIT`);
        }
      } else if (dx >= THRESH) {
        // Swipe right → Update mark
        openMarkModal(pos);
      }
      dx = 0;
    };

    card.addEventListener("touchstart", onStart, { passive: true });
    card.addEventListener("touchmove", onMove, { passive: false });
    card.addEventListener("touchend", onEnd);
    card.addEventListener("touchcancel", onEnd);
  }

  function onPosAction(e) {
    const btn = e.currentTarget;
    const id = btn.dataset.id;
    const action = btn.dataset.action;
    const pos = state.positions.find((p) => p.id === id);
    if (!pos) return;

    if (action === "toggle") {
      pos.status = pos.status === "HOLD" ? "EXIT" : "HOLD";
      persist();
      renderAll();
      return;
    }

    if (action === "mark") {
      openMarkModal(pos);
    }
  }

  function openMarkModal(pos) {
    const backdrop = $("#mark-modal");
    $("#mark-modal-title").textContent = `Mark ${pos.id} · ${pos.underlying}`;
    const input = $("#mark-input");
    input.value = latestMark(pos).toFixed(2);
    backdrop.dataset.ticketId = pos.id;
    backdrop.classList.add("open");
    setTimeout(() => input.focus(), 50);
  }

  function closeMarkModal() {
    $("#mark-modal").classList.remove("open");
  }

  function saveMarkFromModal() {
    const backdrop = $("#mark-modal");
    const id = backdrop.dataset.ticketId;
    const pos = state.positions.find((p) => p.id === id);
    const raw = parseFloat($("#mark-input").value);
    if (!pos || Number.isNaN(raw) || raw < 0) return;

    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}-04:00`;

    pos.marks = pos.marks || [];
    pos.marks.push({ ts, label: "manual", mid: raw });

    state.transactions = state.transactions || [];
    state.transactions.push({
      id: `TXN-${String(state.transactions.length + 1).padStart(3, "0")}`,
      type: "mark",
      ticketId: pos.id,
      ts,
      underlying: pos.underlying,
      legs: legsPlain(pos.legs),
      fill: raw,
      debitCredit: 0,
      dayPnL: Math.round(uPnL(pos)),
      note: "Manual mark update",
    });

    const stats = bookStats(state);
    const tickets = {};
    state.positions.forEach((p) => {
      if (p.status !== "EXIT") tickets[p.id] = latestMark(p);
    });
    state.marksHistory = state.marksHistory || [];
    state.marksHistory.push({
      ts,
      session: "manual",
      date: ts.slice(0, 10),
      tickets,
      bookMTM: Math.round(stats.mtm),
      bookNet: Math.round(stats.net),
    });

    persist();
    closeMarkModal();
    renderAll();
  }

  function renderBlotter() {
    const el = $("#screen-blotter");
    const txns = [...(state.transactions || [])].sort(
      (a, b) => new Date(b.ts) - new Date(a.ts)
    );
    if (!txns.length) {
      el.innerHTML = `<div class="empty">No transactions yet.</div>`;
      return;
    }

    el.innerHTML =
      `<div class="section-label">Blotter · ${txns.length} entries</div>` +
      txns
        .map((t) => {
          const dc =
            t.debitCredit == null
              ? "—"
              : t.debitCredit === 0
              ? "$0"
              : money(t.debitCredit, { signed: true });
          const fill = t.fill == null ? "—" : Number(t.fill).toFixed(2);
          const day =
            t.dayPnL == null
              ? "—"
              : `<span class="${pnlClass(t.dayPnL)}">${money(t.dayPnL, { signed: true })}</span>`;
          const ticketAttr =
            t.ticketId && t.ticketId !== "BOOK" ? t.ticketId : t.id || "";
          return `
          <div class="txn-row" data-ticket="${ticketAttr}" data-txn="${t.id}">
            <div class="txn-bar ${t.type}"></div>
            <div class="txn-type ${t.type}">${t.type}</div>
            <div class="txn-ts">
              <span class="rel">${relativeTs(t.ts)}</span>
              <span class="abs">${formatTs(t.ts)}</span>
            </div>
            <div class="txn-legs">${t.underlying} · ${t.legs}${t.ticketId && t.ticketId !== "BOOK" ? " · " + t.ticketId : ""}</div>
            <div class="txn-meta">
              <span>Fill <strong>${fill}</strong></span>
              <span>D/C <strong>${dc}</strong></span>
              <span>Day P&amp;L <strong>${day}</strong></span>
            </div>
          </div>`;
        })
        .join("");

    el.querySelectorAll(".txn-row").forEach(bindBlotterLongPress);
  }

  function bindBlotterLongPress(row) {
    let timer = null;
    let startX = 0;
    let startY = 0;
    const LONG_MS = 520;

    const clear = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const fire = () => {
      timer = null;
      const ticket = row.dataset.ticket;
      if (!ticket) {
        showToast("No ticket id");
        return;
      }
      const copy = () => {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          return navigator.clipboard.writeText(ticket);
        }
        const ta = document.createElement("textarea");
        ta.value = ticket;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand("copy");
        } finally {
          document.body.removeChild(ta);
        }
        return Promise.resolve();
      };
      copy()
        .then(() => showToast(`Copied ${ticket}`))
        .catch(() => showToast(`Copy failed · ${ticket}`));
    };

    const onDown = (e) => {
      const t = e.touches ? e.touches[0] : e;
      startX = t.clientX;
      startY = t.clientY;
      clear();
      timer = setTimeout(fire, LONG_MS);
    };

    const onMove = (e) => {
      if (!timer) return;
      const t = e.touches ? e.touches[0] : e;
      if (Math.abs(t.clientX - startX) > 10 || Math.abs(t.clientY - startY) > 10) {
        clear();
      }
    };

    row.addEventListener("touchstart", onDown, { passive: true });
    row.addEventListener("touchmove", onMove, { passive: true });
    row.addEventListener("touchend", clear);
    row.addEventListener("touchcancel", clear);
    row.addEventListener("mousedown", onDown);
    row.addEventListener("mouseup", clear);
    row.addEventListener("mouseleave", clear);
  }

  function renderMarks() {
    const el = $("#screen-marks");
    const hist = [...(state.marksHistory || [])].sort(
      (a, b) => new Date(b.ts) - new Date(a.ts)
    );
    if (!hist.length) {
      el.innerHTML = `<div class="empty">No marks snapshots yet.</div>`;
      return;
    }

    el.innerHTML =
      `<div class="section-label">Marks history · open / midday / close</div>` +
      hist
        .map((h) => {
          const tickets = Object.entries(h.tickets || {})
            .map(([id, mid]) => `${id}: ${Number(mid).toFixed(2)}`)
            .join("<br>");
          return `
          <div class="mark-snap">
            <div class="mark-snap-head">
              <span class="session-pill ${h.session}">${h.session}</span>
              <span class="txn-ts">
                <span class="rel">${relativeTs(h.ts)}</span>
                <span class="abs">${formatTs(h.ts)}</span>
              </span>
            </div>
            <div class="mark-tickets">${tickets || "—"}</div>
            <div class="mark-book">
              <span>MTM ${money(h.bookMTM)}</span>
              <span class="${pnlClass(h.bookNet)}">Net ${money(h.bookNet, { signed: true })}</span>
            </div>
          </div>`;
        })
        .join("");
  }

  function renderUniverse() {
    const el = $("#screen-universe");
    const uni = state.universe || [];
    el.innerHTML =
      `<div class="section-label">Desk universe</div>` +
      `<div class="tip" style="margin-bottom:10px"><strong>Note:</strong> QQQ is a separate Nasdaq unit — not a BTC factor with MSTR / ASST / STRC / SATA.</div>` +
      uni
        .map((u) => {
          const unitClass = u.unit === "Nasdaq" ? "nasdaq" : "btc";
          return `
          <div class="uni-card">
            <div class="uni-sym">${u.symbol}</div>
            <div class="uni-body">
              <div class="uni-name">${u.name}</div>
              <div class="uni-note">${u.note}</div>
            </div>
            <span class="unit-tag ${unitClass}">${u.unit}</span>
          </div>`;
        })
        .join("");
  }

  function renderAll() {
    renderBook();
    renderPositions();
    renderBlotter();
    renderMarks();
    renderUniverse();
  }

  // ---------- navigation ----------
  function showScreen(name) {
    $$(".screen").forEach((s) => s.classList.remove("active"));
    $$(".tab-btn").forEach((b) => b.classList.remove("active"));
    const screen = $(`#screen-${name}`);
    const tab = $(`.tab-btn[data-screen="${name}"]`);
    if (screen) screen.classList.add("active");
    if (tab) tab.classList.add("active");
  }

  // ---------- boot ----------
  async function init() {
    try {
      await loadState();
    } catch (err) {
      $("#screen-book").innerHTML = `<div class="empty">Failed to load seed: ${err.message}</div>`;
      $("#screen-book").classList.add("active");
      return;
    }

    renderAll();
    showScreen("book");
    startDeskLiveRefresh();

    $$(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => showScreen(btn.dataset.screen));
    });

    $("#mark-cancel").addEventListener("click", closeMarkModal);
    $("#mark-save").addEventListener("click", saveMarkFromModal);
    $("#mark-modal").addEventListener("click", (e) => {
      if (e.target.id === "mark-modal") closeMarkModal();
    });
    $("#mark-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") saveMarkFromModal();
      if (e.key === "Escape") closeMarkModal();
    });

    // Soft reset: hold header badge 1.5s to reload seed
    let holdTimer = null;
    const badge = $(".badge");
    if (badge) {
      badge.addEventListener("pointerdown", () => {
        holdTimer = setTimeout(() => {
          if (confirm("Reload seed from JSON and wipe local edits?")) {
            localStorage.removeItem(STORAGE_KEY);
            location.reload();
          }
        }, 1500);
      });
      badge.addEventListener("pointerup", () => clearTimeout(holdTimer));
      badge.addEventListener("pointerleave", () => clearTimeout(holdTimer));
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

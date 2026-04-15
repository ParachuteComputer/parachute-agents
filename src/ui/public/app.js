// parachute-agent-ui client. Keep it tiny: no framework, no build step.
// Responsibilities:
//  - connect to /api/stream and re-render the dashboard in place when snapshots arrive
//  - keyboard shortcuts: "/" focuses search, "r" triggers refresh, "Esc" clears search
//  - `#search` input filters cards by name/trigger/model
//
// When a new run lands, we flash the affected card. No full page reload.

(() => {
  const search = document.getElementById("search");
  const cardsRoot = document.getElementById("cards");

  const applyFilter = () => {
    if (!cardsRoot || !search) return;
    const q = search.value.trim().toLowerCase();
    for (const card of cardsRoot.querySelectorAll(".card")) {
      const hay = [
        card.dataset.name,
        card.dataset.trigger,
        card.dataset.model,
        card.dataset.path,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!q || hay.includes(q)) card.classList.remove("hidden");
      else card.classList.add("hidden");
    }
  };

  search?.addEventListener("input", applyFilter);

  // Keyboard shortcuts — skipped while the user is typing somewhere else.
  document.addEventListener("keydown", (e) => {
    const active = document.activeElement;
    const typing = active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA");
    if (e.key === "/" && !typing) {
      e.preventDefault();
      search?.focus();
      search?.select();
    } else if (e.key === "Escape" && active === search) {
      search.value = "";
      applyFilter();
      search.blur();
    } else if (e.key === "r" && !typing && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      location.reload();
    }
  });

  // Tick the "updated Ns ago" label once a second.
  const updatedEl = document.querySelector(".meta-text");
  if (updatedEl) {
    const fmt = (ms) => {
      const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
      if (s < 60) return `${s}s ago`;
      const m = Math.floor(s / 60);
      if (m < 60) return `${m}m ago`;
      const h = Math.floor(m / 60);
      return `${h}h ago`;
    };
    setInterval(() => {
      const ms = Number(updatedEl.dataset.updated);
      if (ms) updatedEl.textContent = `updated ${fmt(ms)}`;
    }, 1000);
  }

  // SSE wiring — only on the dashboard (the only page with live cards).
  if (!cardsRoot) return;

  let backoff = 1000;
  const connect = () => {
    const es = new EventSource("/api/stream");
    es.addEventListener("snapshot", (ev) => {
      backoff = 1000;
      try {
        const snap = JSON.parse(ev.data);
        applySnapshot(snap);
      } catch (err) {
        console.error("bad snapshot:", err);
      }
    });
    es.addEventListener("heartbeat", () => {
      backoff = 1000;
    });
    es.addEventListener("error", () => {
      es.close();
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    });
  };
  connect();

  let seeded = false;
  function applySnapshot(snap) {
    if (updatedEl) {
      updatedEl.dataset.updated = String(snap.generatedAt);
    }
    const byName = new Map();
    for (const card of cardsRoot.querySelectorAll(".card")) {
      byName.set(card.dataset.name, card);
    }
    for (const a of snap.agents) {
      const card = byName.get(a.name);
      if (!card) continue;
      const next = a.lastRun ? `${a.lastRun.id}:${a.lastRun.startedAt}` : "";
      const prev = card.dataset.lastrun;
      if (seeded && prev !== undefined && prev !== next) {
        card.classList.add("flash");
        setTimeout(() => card.classList.remove("flash"), 900);
      }
      card.dataset.lastrun = next;
    }
    seeded = true;
  }

  applyFilter();
})();

(() => {
  const APP_NAME = "Inv-Wave Lab";
  const EVENT_PREFIX = "inv_wave";
  const MAX_STRING_LENGTH = 120;

  function sanitizeValue(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "boolean") return value;
    return String(value).slice(0, MAX_STRING_LENGTH);
  }

  function cleanParams(params = {}) {
    return Object.entries(params).reduce(
      (next, [key, value]) => {
        const cleanValue = sanitizeValue(value);
        if (cleanValue !== null) next[key] = cleanValue;
        return next;
      },
      {
        app_name: APP_NAME,
        page_path: window.location.pathname,
      },
    );
  }

  function track(eventName, params = {}) {
    const event = `${EVENT_PREFIX}_${eventName}`;
    const payload = cleanParams(params);
    window.dataLayer = window.dataLayer || [];

    if (typeof window.gtag === "function") {
      window.gtag("event", event, payload);
    }

    window.dataLayer.push({
      event,
      ...payload,
    });
  }

  function navArea(node) {
    if (node.closest(".mobile-bottom-nav")) return "mobile_bottom_nav";
    if (node.closest(".topbar-nav")) return "header_nav";
    if (node.closest(".app-footer")) return "footer_nav";
    if (node.closest(".repo-actions")) return "repo_actions";
    return "link";
  }

  function bindNavigationEvents() {
    document.addEventListener("click", (event) => {
      const link = event.target.closest("a[href]");
      if (!link) return;
      const area = navArea(link);
      if (area === "link") return;
      track("nav_click", {
        nav_area: area,
        link_text: link.textContent.trim().replace(/\s+/g, " "),
        link_href: link.getAttribute("href"),
      });
    });
  }

  window.InvWaveAnalytics = {
    track,
  };

  bindNavigationEvents();
})();

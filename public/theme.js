const THEME_KEY = "inv-wave-theme";
const root = document.documentElement;

function systemTheme() {
  return window.matchMedia?.("(prefers-color-scheme: light)")?.matches ? "light" : "dark";
}

function readTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return saved === "light" || saved === "dark" ? saved : systemTheme();
  } catch {
    return "dark";
  }
}

function writeTheme(theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Local storage can be unavailable in some browser privacy modes.
  }
}

function updateThemeButtons(theme) {
  const label = theme === "light" ? "Light" : "Dark";
  document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
    button.setAttribute("aria-pressed", theme === "light" ? "true" : "false");
    const labelNode = button.querySelector("[data-theme-label]");
    if (labelNode) labelNode.textContent = label;
  });
}

function applyTheme(theme, persist = false) {
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  if (persist) writeTheme(theme);
  updateThemeButtons(theme);
  if (persist) {
    window.InvWaveAnalytics?.track("theme_change", {
      theme,
    });
  }
  window.dispatchEvent(new CustomEvent("inv-wave-theme-change", { detail: { theme } }));
}

function toggleTheme() {
  applyTheme(root.dataset.theme === "light" ? "dark" : "light", true);
}

function syncMobileBottomNav() {
  if (!document.querySelector(".mobile-bottom-nav")) return;
  const viewport = window.visualViewport;
  let bottomOffset = 8;
  if (viewport) {
    const hiddenBottom = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
    bottomOffset += hiddenBottom;
  }
  root.style.setProperty("--mobile-nav-bottom", `calc(${Math.round(bottomOffset)}px + env(safe-area-inset-bottom, 0px))`);
}

function routePath(pathname) {
  const path = pathname.replace(/\/+$/, "") || "/";
  const cleanPath = path.endsWith(".html") ? path.slice(0, -5) || "/" : path;
  return cleanPath === "/index" ? "/" : cleanPath;
}

function syncMobileNavState() {
  const nav = document.querySelector(".mobile-bottom-nav");
  if (!nav) return;
  const currentPath = routePath(window.location.pathname);
  const currentHash = window.location.hash;

  nav.querySelectorAll("a[href]").forEach((link) => {
    const url = new URL(link.getAttribute("href"), window.location.href);
    const linkPath = routePath(url.pathname);
    let isActive = false;

    if (currentPath === "/" && linkPath === "/") {
      isActive = url.hash === "#validation" ? currentHash === "#validation" : currentHash !== "#validation";
    } else {
      isActive = currentPath === linkPath && (!url.hash || url.hash === currentHash);
    }

    if (isActive) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  });
}

applyTheme(readTheme());
syncMobileBottomNav();
syncMobileNavState();

document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
  button.addEventListener("click", toggleTheme);
});

window.matchMedia?.("(prefers-color-scheme: light)").addEventListener?.("change", () => {
  try {
    if (localStorage.getItem(THEME_KEY)) return;
  } catch {
    return;
  }
  applyTheme(systemTheme());
});

window.addEventListener("resize", syncMobileBottomNav);
window.addEventListener("orientationchange", syncMobileBottomNav);
window.addEventListener("hashchange", syncMobileNavState);
window.addEventListener("popstate", syncMobileNavState);
window.visualViewport?.addEventListener("resize", syncMobileBottomNav);
window.visualViewport?.addEventListener("scroll", syncMobileBottomNav);

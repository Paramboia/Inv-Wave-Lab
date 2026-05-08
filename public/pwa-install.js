const DISMISS_KEY = "inv-wave-install-dismissed";
const DISMISS_DAYS = 14;
const IOS_FALLBACK_DELAY = 5000;
let deferredPrompt = null;

const promptEl = document.querySelector("#pwaInstallPrompt");
const installButton = document.querySelector("#pwaInstallButton");
const dismissButton = document.querySelector("#pwaDismissButton");
const laterButton = document.querySelector("#pwaLaterButton");
const copyNode = document.querySelector("#pwaInstallCopy");
const titleNode = document.querySelector("#pwaInstallTitle");

function isStandalone() {
  return window.matchMedia?.("(display-mode: standalone)")?.matches || window.navigator.standalone === true;
}

function wasDismissedRecently() {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    const timestamp = Number(raw);
    if (!Number.isFinite(timestamp)) return false;
    return Date.now() - timestamp < DISMISS_DAYS * 24 * 60 * 60 * 1000;
  } catch {
    return true;
  }
}

function rememberDismissal() {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
  } catch {
    // Storage can be unavailable in private browsing modes.
  }
}

function showPrompt(mode = "native") {
  if (!promptEl || isStandalone() || wasDismissedRecently()) return;
  promptEl.dataset.mode = mode;
  if (mode === "ios") {
    if (titleNode) titleNode.textContent = "Add Inv-Wave Lab to Home Screen";
    if (copyNode) copyNode.textContent = "Open the browser share menu, then choose Add to Home Screen for an app-like shortcut.";
    if (installButton) installButton.textContent = "Got it";
  }
  promptEl.classList.remove("hidden");
  window.requestAnimationFrame(() => promptEl.classList.add("is-visible"));
  window.InvWaveAnalytics?.track("pwa_prompt_show", {
    mode,
  });
}

function hidePrompt(remember = true, reason = "dismiss") {
  if (!promptEl) return;
  promptEl.classList.remove("is-visible");
  if (remember) rememberDismissal();
  window.setTimeout(() => promptEl.classList.add("hidden"), 180);
  window.InvWaveAnalytics?.track("pwa_prompt_hide", {
    reason,
    remembered: remember,
  });
}

async function installApp() {
  window.InvWaveAnalytics?.track("pwa_install_click", {
    mode: promptEl?.dataset.mode ?? "native",
  });
  if (!deferredPrompt) {
    hidePrompt(true, "manual_ios_instruction");
    return;
  }
  deferredPrompt.prompt();
  const choice = await deferredPrompt.userChoice;
  deferredPrompt = null;
  window.InvWaveAnalytics?.track("pwa_install_result", {
    outcome: choice?.outcome ?? "unknown",
  });
  hidePrompt(choice?.outcome !== "accepted", choice?.outcome ?? "unknown");
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch(() => {
      // The app still works normally if service worker registration fails.
    });
  });
}

if (promptEl && !isStandalone()) {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event;
    window.setTimeout(() => showPrompt("native"), 2200);
  });

  window.addEventListener("appinstalled", () => {
    window.InvWaveAnalytics?.track("pwa_installed");
    hidePrompt(false, "installed");
  });

  const isIos = /iphone|ipad|ipod/i.test(window.navigator.userAgent);
  if (isIos && !wasDismissedRecently()) {
    window.setTimeout(() => showPrompt("ios"), IOS_FALLBACK_DELAY);
  }
}

installButton?.addEventListener("click", installApp);
dismissButton?.addEventListener("click", () => hidePrompt(true, "dismiss_button"));
laterButton?.addEventListener("click", () => hidePrompt(true, "later_button"));

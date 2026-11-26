if (location.protocol === "http:" && /(^|\.)coinflip\.casino$/.test(location.hostname)) {
  location.replace("https://" + location.host + location.pathname + location.search + location.hash);
}
try {
  const t = localStorage.getItem("arkade-trade-theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch {}

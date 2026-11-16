/* Paints the admin page in this browser's last colour theme before anything shows, so there is no flash of the default.
   src/admin/theme.ts writes the cache; this is a separate file (not inline) because the page's Content-Security-Policy
   allows only scripts from this site. Colours are set as custom properties on <html>, which the policy allows. */
try {
  var t = JSON.parse(localStorage.getItem("globe-admin-theme") || "null");
  if (t && /^#[0-9a-f]{6}$/.test(t.seed) && t.vars) {
    var dark = t.mode === "dark" || (t.mode === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    if (t.mode === "light" || t.mode === "dark") document.documentElement.dataset.theme = t.mode;
    var vars = dark ? t.vars.dark : t.vars.light;
    for (var k in vars) if (/^--[a-z-]+$/.test(k) && /^#[0-9a-f]{6}$/.test(vars[k])) document.documentElement.style.setProperty(k, vars[k]);
  }
} catch (e) {}

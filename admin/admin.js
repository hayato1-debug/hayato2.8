(() => {
  const API = (window.MAHIRU_API_BASE || "").replace(/\/$/, "");
  const $ = (id) => document.getElementById(id);
  let token = sessionStorage.getItem("mahiru_admin_token") || "";
  const status = (id, text) => { $(id).textContent = text; };
  function setAuthed(yes) { $("loginPanel").hidden = yes; $("adminPanel").hidden = !yes; }
  function setType() { $("files").accept = $("mediaType").value === "images" ? "image/*" : "audio/*"; }
  setType(); $("mediaType").addEventListener("change", setType);
  if (token) setAuthed(true);
  if (!API) status("loginStatus", "Backend URL not configured. Set MAHIRU_API_BASE in config.js first.");
  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!API) return;
    status("loginStatus", "Signing in…");
    try {
      const res = await fetch(`${API}/api/admin/login`, {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({username:$("username").value, password:$("password").value})});
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || "Login failed.");
      token = data.access_token; sessionStorage.setItem("mahiru_admin_token", token); setAuthed(true); status("loginStatus", "");
    } catch (err) { status("loginStatus", err.message || "Could not connect to backend."); }
  });
  $("logoutBtn").addEventListener("click", () => { token=""; sessionStorage.removeItem("mahiru_admin_token"); setAuthed(false); status("loginStatus", "Signed out."); });
  $("uploadForm").addEventListener("submit", async (e) => {
    e.preventDefault(); if (!API || !token) { status("uploadStatus", "Sign in first and configure the backend URL."); return; }
    const files = Array.from($("files").files || []); if (!files.length) return;
    const type = $("mediaType").value; const endpoint = `${API}/api/admin/${type}`;
    status("uploadStatus", `Uploading ${files.length} file(s)…`);
    let done = 0;
    try {
      for (const file of files) {
        const form = new FormData(); form.append("file", file); form.append("category", $("category").value); form.append("tags", $("tags").value);
        const res = await fetch(endpoint, {method:"POST", headers:{Authorization:`Bearer ${token}`}, body:form});
        const data = await res.json().catch(() => ({}));
        if (res.status === 401 || res.status === 403) { token=""; sessionStorage.removeItem("mahiru_admin_token"); setAuthed(false); throw new Error("Session expired. Please sign in again."); }
        if (!res.ok) throw new Error(data.detail || `Upload failed for ${file.name}`);
        done++;
      }
      status("uploadStatus", `Published ${done} file(s) successfully 🌸`); $("uploadForm").reset(); setType();
    } catch (err) { status("uploadStatus", `${done} uploaded. ${err.message || "Upload failed."}`); }
  });
})();

(() => {
  "use strict";

  const API = (window.MAHIRU_API_BASE || "").replace(/\/$/, "");
  const $ = (id) => document.getElementById(id);

  let token = sessionStorage.getItem("mahiru_admin_token") || "";
  let mediaItems = [];

  const status = (id, message) => {
    const element = $(id);
    if (element) element.textContent = message;
  };

  function setAuthed(yes) {
    $("loginPanel").hidden = yes;
    $("adminPanel").hidden = !yes;
    $("explorerPanel").hidden = !yes;

    if (yes) loadMedia();
  }

  function setType() {
    $("files").accept =
      $("mediaType").value === "images" ? "image/*" : "audio/*";
  }

  function clearSession() {
    token = "";
    sessionStorage.removeItem("mahiru_admin_token");
    setAuthed(false);
  }

  async function apiRequest(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", `Bearer ${token}`);

    const response = await fetch(`${API}${path}`, {
      ...options,
      headers
    });

    const data = await response.json().catch(() => ({}));

    if (response.status === 401 || response.status === 403) {
      clearSession();
      throw new Error("Session expired. Please sign in again.");
    }

    if (!response.ok) {
      throw new Error(data.detail || `Request failed (${response.status}).`);
    }

    return data;
  }

  function safeMediaUrl(url) {
    if (typeof url !== "string" || !url.startsWith("/api/media/")) {
      return "";
    }
    if (url.includes("..") || url.includes("\\")) return "";
    return `${API}${url}`;
  }

  function formatDate(value) {
    if (!value) return "Date unavailable";
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? "Date unavailable"
      : date.toLocaleString();
  }

  function renderMedia() {
    const container = $("mediaGrid");
    const empty = $("mediaEmpty");
    const count = $("mediaCount");
    const filter = $("mediaFilter").value;

    container.replaceChildren();

    const filtered = mediaItems.filter((item) => {
      if (filter === "all") return true;
      if (filter === "images") {
        return item.kind === "image" || item.kind === "generated";
      }
      if (filter === "audio") return item.kind === "audio";
      return false;
    });

    count.textContent = `${filtered.length} item(s)`;
    empty.hidden = filtered.length !== 0;

    for (const item of filtered) {
      const card = document.createElement("article");
      card.className = "media-card";

      const preview = document.createElement("div");
      preview.className = "media-preview";

      const url = safeMediaUrl(item.url);
      const isAudio = item.kind === "audio";
      const isImage = item.kind === "image" || item.kind === "generated";

      if (url && isImage) {
        const image = document.createElement("img");
        image.src = url;
        image.alt = item.name || "Garden image";
        image.loading = "lazy";
        image.addEventListener("error", () => {
          preview.textContent = "Preview unavailable";
        });
        preview.appendChild(image);
      } else if (url && isAudio) {
        const audio = document.createElement("audio");
        audio.controls = true;
        audio.preload = "none";
        audio.src = url;
        preview.appendChild(audio);
      } else {
        preview.textContent = "Preview unavailable";
      }

      const details = document.createElement("div");
      details.className = "media-details";

      const name = document.createElement("h3");
      name.textContent = item.name || "Untitled media";

      const meta = document.createElement("p");
      meta.textContent = `${item.kind || "unknown"} · ${formatDate(item.createdAt)}`;

      const category = document.createElement("p");
      category.textContent = item.category
        ? `Category: ${item.category}`
        : "No category";

      const tags = document.createElement("p");
      const tagText = Array.isArray(item.tags)
        ? item.tags.join(", ")
        : typeof item.tags === "string" ? item.tags : "";

      tags.textContent = tagText ? `Tags: ${tagText}` : "No tags";
      details.append(name, meta, category, tags);

      const actions = document.createElement("div");
      actions.className = "media-actions";

      if (url) {
        const openLink = document.createElement("a");
        openLink.className = "btn btn-ghost";
        openLink.href = url;
        openLink.target = "_blank";
        openLink.rel = "noopener noreferrer";
        openLink.textContent = "Open";
        actions.appendChild(openLink);
      }

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "danger-btn";
      deleteButton.textContent = "Delete";

      deleteButton.addEventListener("click", () => deleteMedia(item));
      actions.appendChild(deleteButton);

      card.append(preview, details, actions);
      container.appendChild(card);
    }
  }

  async function loadMedia() {
    if (!API || !token) return;

    status("mediaStatus", "Loading media…");

    try {
      const data = await apiRequest("/api/admin/media");

      if (!Array.isArray(data)) {
        throw new Error("Unexpected media list response.");
      }

      mediaItems = data;
      renderMedia();
      status("mediaStatus", "Media library loaded 🌸");
    } catch (error) {
      status("mediaStatus", error.message || "Could not load media.");
    }
  }

  async function deleteMedia(item) {
    if (!item || !item.id) {
      status("mediaStatus", "This item has no valid media ID.");
      return;
    }

    if (!window.confirm(
      `Permanently delete "${item.name || "this media file"}"?\n\nThis cannot be undone.`
    )) return;

    status("mediaStatus", "Deleting media…");

    try {
      await apiRequest(
        `/api/admin/media/${encodeURIComponent(item.id)}`,
        { method: "DELETE" }
      );

      mediaItems = mediaItems.filter((media) => media.id !== item.id);
      renderMedia();
      status("mediaStatus", "Media deleted successfully.");
    } catch (error) {
      status("mediaStatus", error.message || "Could not delete media.");
    }
  }

  $("mediaType").addEventListener("change", setType);
  $("mediaFilter").addEventListener("change", renderMedia);
  $("refreshMediaBtn").addEventListener("click", loadMedia);

  $("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!API) {
      status("loginStatus", "Backend URL missing in config.js.");
      return;
    }

    const button = $("loginForm").querySelector('button[type="submit"]');
    button.disabled = true;
    status("loginStatus", "Signing in…");

    try {
      const response = await fetch(`${API}/api/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: $("username").value,
          password: $("password").value
        })
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.detail || `Login failed (${response.status}).`);
      }

      if (!data.access_token) {
        throw new Error("The server did not return an access token.");
      }

      token = data.access_token;
      sessionStorage.setItem("mahiru_admin_token", token);
      status("loginStatus", "");
      setAuthed(true);
    } catch (error) {
      status("loginStatus", error.message || "Could not connect to backend.");
    } finally {
      button.disabled = false;
    }
  });

  $("logoutBtn").addEventListener("click", () => {
    clearSession();
    status("loginStatus", "Signed out.");
    status("mediaStatus", "");
  });

  $("uploadForm").addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!API || !token) {
      status("uploadStatus", "Sign in first and configure the backend URL.");
      return;
    }

    const files = Array.from($("files").files || []);
    if (!files.length) {
      status("uploadStatus", "Choose at least one file.");
      return;
    }

    const type = $("mediaType").value;
    const endpoint = `/api/admin/${type}`;
    let uploaded = 0;

    status("uploadStatus", `Uploading ${files.length} file(s)…`);

    try {
      for (const file of files) {
        const form = new FormData();
        form.append("file", file);
        form.append("category", $("category").value);
        form.append("tags", $("tags").value);

        await apiRequest(endpoint, { method: "POST", body: form });
        uploaded++;
        status("uploadStatus", `Uploaded ${uploaded} of ${files.length} file(s)…`);
      }

      status("uploadStatus", `Published ${uploaded} file(s) successfully 🌸`);
      $("uploadForm").reset();
      setType();
      await loadMedia();
    } catch (error) {
      status(
        "uploadStatus",
        `${uploaded} uploaded. ${error.message || "Upload failed."}`
      );
    }
  });

  setType();

  if (!API) {
    status("loginStatus", "Backend URL not configured in config.js.");
  }

  setAuthed(false);
})();

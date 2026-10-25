/* ==========================================================================
   Mahiru Memory Garden — Application Logic
   Vanilla JS, IndexedDB storage, no frameworks.
   ========================================================================== */

(() => {
  "use strict";

  /* ========================================================================
     0. DATABASE LAYER (IndexedDB)
     ======================================================================== */
  const DB_NAME = "mahiruMemoryGardenDB";
  const DB_VERSION = 1;
  let db = null;

  const STORES = {
    images: "images",       // {id, blob, title, description, tags[], album, category, rating, favorite, uploadDate, size, width, height, name}
    albums: "albums",       // {id, name, category, cover, createdAt}
    tracks: "tracks",       // {id, blob, name, addedAt}
    settings: "settings",   // key/value {key, value}
  };

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const _db = e.target.result;
        if (!_db.objectStoreNames.contains(STORES.images)) {
          const s = _db.createObjectStore(STORES.images, { keyPath: "id" });
          s.createIndex("favorite", "favorite");
          s.createIndex("album", "album");
          s.createIndex("uploadDate", "uploadDate");
        }
        if (!_db.objectStoreNames.contains(STORES.albums)) {
          _db.createObjectStore(STORES.albums, { keyPath: "id" });
        }
        if (!_db.objectStoreNames.contains(STORES.tracks)) {
          _db.createObjectStore(STORES.tracks, { keyPath: "id" });
        }
        if (!_db.objectStoreNames.contains(STORES.settings)) {
          _db.createObjectStore(STORES.settings, { keyPath: "key" });
        }
      };
      req.onsuccess = (e) => { db = e.target.result; resolve(db); };
      req.onerror = (e) => reject(e);
    });
  }

  function tx(storeName, mode = "readonly") {
    return db.transaction(storeName, mode).objectStore(storeName);
  }

  function dbGetAll(storeName) {
    return new Promise((resolve, reject) => {
      const req = tx(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = (e) => reject(e);
    });
  }

  function dbGet(storeName, id) {
    return new Promise((resolve, reject) => {
      const req = tx(storeName).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = (e) => reject(e);
    });
  }

 
function dbPut(storeName, value) {
  return new Promise((resolve, reject) => {
    let transaction;

    try {
      transaction = db.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      store.put(value);

      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () => {
        reject(transaction.error || new Error("IndexedDB write failed"));
      };
      transaction.onabort = () => {
        reject(transaction.error || new Error("IndexedDB transaction aborted"));
      };
    } catch (error) {
      reject(error);
    }
  });
}


  function dbDelete(storeName, id) {
    return new Promise((resolve, reject) => {
      const req = tx(storeName, "readwrite").delete(id);
      req.onsuccess = () => resolve();
      req.onerror = (e) => reject(e);
    });
  }

  function dbClear(storeName) {
    return new Promise((resolve, reject) => {
      const req = tx(storeName, "readwrite").clear();
      req.onsuccess = () => resolve();
      req.onerror = (e) => reject(e);
    });
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  }

  /* ========================================================================
     1. APP STATE
     ======================================================================== */
  const state = {
    images: [],
    albums: [],
    tracks: [],
    settings: {
      theme: "light",
      accent: "#8AB8E8",
      blur: 18,
      animSpeed: 100,
      sakuraOn: true,
      sakuraDensity: 18,
      defaultVolume: 80,
    },
    currentPage: "home",
    galleryVisibleCount: 20,
    pendingUploads: [],   // for upload modal preview
    pendingTracks: [],
    activeLightboxId: null,
    lightboxList: [],
    lightboxIndex: -1,
    logoClickCount: 0,
    logoClickTimer: null,
    angelMode: false,
  };

  const API_BASE = (window.MAHIRU_API_BASE || "").replace(/\/$/, "");

  async function loadPublishedMedia() {
    if (!API_BASE) return;
    try {
      const [imagesRes, tracksRes] = await Promise.all([
        fetch(`${API_BASE}/api/gallery`),
        fetch(`${API_BASE}/api/tracks`)
      ]);
      if (imagesRes.ok) {
        const remoteImages = await imagesRes.json();
        const mapped = remoteImages.map((item) => ({
          ...item, id: `remote-${item.id}`, remoteId: item.id,
          blob: `${API_BASE}${item.url}`, uploadDate: item.uploadDate || item.createdAt || Date.now(),
          favorite: false, rating: 0, tags: item.tags || [], album: "", category: item.category || "Published"
        }));
        state.images = [...mapped, ...state.images.filter((i) => !i.remoteId)];
      }
      if (tracksRes.ok) {
        const remoteTracks = await tracksRes.json();
        const mappedTracks = remoteTracks.map((item) => ({
          id: `remote-${item.id}`, remoteId: item.id, name: item.name,
          blob: `${API_BASE}${item.url}`, addedAt: item.createdAt || Date.now()
        }));
        state.tracks = [...mappedTracks, ...state.tracks.filter((t) => !t.remoteId)];
      }
    } catch (err) {
      console.warn("Published media API unavailable; showing local data only.", err);
    }
  }

  /* ========================================================================
     AI TOOLS (Groq chat + Ideogram image generation through the backend)
     ======================================================================== */
  function initAITools() {
    const chatForm = document.getElementById("aiChatForm");
    const chatInput = document.getElementById("aiChatInput");
    const chatMessages = document.getElementById("aiChatMessages");
    const chatStatus = document.getElementById("aiChatStatus");
    const clearChat = document.getElementById("aiClearChat");
    const imageForm = document.getElementById("imageGenForm");
    const imagePrompt = document.getElementById("imagePrompt");
    const imageStatus = document.getElementById("imageGenStatus");
    const imageResults = document.getElementById("imageGenResults");
    if (!chatForm || !imageForm) return;

    const history = [];
    function addChatMessage(role, text) {
      const item = document.createElement("div");
      item.className = `ai-message ${role}`;
      const title = document.createElement("strong");
      title.textContent = role === "user" ? "You" : "Mahiru AI";
      const body = document.createElement("p");
      body.textContent = text;
      item.append(title, body);
      chatMessages.appendChild(item);
      chatMessages.scrollTop = chatMessages.scrollHeight;
      return item;
    }

    chatForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const message = chatInput.value.trim();
      if (!API_BASE || !message) {
        chatStatus.textContent = !API_BASE ? "Backend URL is not configured yet." : "Please write a message first.";
        return;
      }
      chatInput.value = "";
      addChatMessage("user", message);
      history.push({ role: "user", content: message });
      chatStatus.textContent = "Mahiru AI is thinking…";
      const sendButton = document.getElementById("aiChatSend");
      sendButton.disabled = true;
      try {
        const response = await fetch(`${API_BASE}/api/ai/chat`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: history.slice(-12) })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || "AI request failed.");
        const reply = String(data.reply || "No response received.");
        history.push({ role: "assistant", content: reply });
        addChatMessage("assistant", reply);
        chatStatus.textContent = "";
      } catch (error) {
        history.pop();
        chatStatus.textContent = error.message || "Could not connect to AI. Check backend setup.";
      } finally { sendButton.disabled = false; chatInput.focus(); }
    });

    clearChat?.addEventListener("click", () => {
      history.length = 0;
      chatMessages.replaceChildren();
      addChatMessage("assistant", "Chat cleared. What would you like to work on next?");
      chatStatus.textContent = "";
    });

    imageForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const prompt = imagePrompt.value.trim();
      const aiToken = sessionStorage.getItem("mahiru_admin_token") || "";
      if (!API_BASE || !aiToken || !prompt) {
        imageStatus.textContent = !API_BASE ? "Backend URL is not configured yet." : (!aiToken ? "Sign in through the Admin page first to use AI tools." : "Please describe the image first.");
        return;
      }
      const button = document.getElementById("imageGenButton");
      button.disabled = true;
      imageStatus.textContent = "Generating image… this can take a little while.";
      imageResults.replaceChildren();
      try {
        const response = await fetch(`${API_BASE}/api/ai/image`, {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${aiToken}` },
          body: JSON.stringify({ prompt, style: document.getElementById("imageStyle").value,
            num_images: Number(document.getElementById("imageCount").value) })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || "Image generation failed.");
        (data.images || []).forEach((image) => {
          const card = document.createElement("article");
          card.className = "generated-image-card";
          const img = document.createElement("img");
          img.src = `${API_BASE}${image.url}`;
          img.alt = prompt;
          img.loading = "lazy";
          const actions = document.createElement("div");
          actions.className = "image-actions";
          const link = document.createElement("a");
          link.href = img.src; link.target = "_blank"; link.rel = "noopener";
          link.textContent = "Open / save image ↗";
          actions.appendChild(link); card.append(img, actions); imageResults.appendChild(card);
        });
        imageStatus.textContent = data.images?.length ? "Done! Your generated image is ready." : "No images returned.";
      } catch (error) {
        imageStatus.textContent = error.message || "Could not connect to Ideogram. Check backend setup.";
      } finally { button.disabled = false; }
    });
  }

  /* ========================================================================
     2. TOASTS
     ======================================================================== */
  function toast(message) {
    const stack = document.getElementById("toastStack");
    const el = document.createElement("div");
    el.className = "toast glass";
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => el.remove(), 2800);
  }

  /* ========================================================================
     3. NAVIGATION
     ======================================================================== */
  function goToPage(pageName) {
    state.currentPage = pageName;
    document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
    const target = document.getElementById(`page-${pageName}`);
    if (target) target.classList.add("active");
    document.querySelectorAll(".tab").forEach((t) => {
      t.classList.toggle("active", t.dataset.page === pageName);
    });
    document.getElementById("mobileDrawer").classList.remove("open");
    window.scrollTo({ top: 0, behavior: "smooth" });

    if (pageName === "gallery") renderGallery(true);
    if (pageName === "favorites") renderFavorites();
    if (pageName === "albums") renderAlbums();
    if (pageName === "stats") renderStats();
    if (pageName === "music") renderPlaylist();
  }

  function initNav() {
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => goToPage(tab.dataset.page));
    });
    document.querySelectorAll("[data-page-link]").forEach((btn) => {
      btn.addEventListener("click", () => goToPage(btn.dataset.pageLink));
    });
    document.getElementById("hamburgerBtn").addEventListener("click", () => {
      document.getElementById("mobileDrawer").classList.toggle("open");
    });
    document.addEventListener("click", (e) => {
      const drawer = document.getElementById("mobileDrawer");
      if (!drawer.contains(e.target) && e.target.id !== "hamburgerBtn") {
        drawer.classList.remove("open");
      }
    });
  }

  /* ========================================================================
     4. MODALS
     ======================================================================== */
  function openModal(id) {
    document.getElementById(id).classList.add("open");
  }
  function closeModal(id) {
    document.getElementById(id).classList.remove("open");
  }
  function initModals() {
    document.querySelectorAll("[data-close]").forEach((btn) => {
      btn.addEventListener("click", () => closeModal(btn.dataset.close));
    });
    document.querySelectorAll(".modal-overlay").forEach((overlay) => {
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) overlay.classList.remove("open");
      });
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        document.querySelectorAll(".modal-overlay.open").forEach((o) => o.classList.remove("open"));
      }
    });
  }

  function confirmDialog(title, body) {
    return new Promise((resolve) => {
      document.getElementById("confirmTitle").textContent = title;
      document.getElementById("confirmBody").textContent = body;
      openModal("confirmModal");
      const okBtn = document.getElementById("confirmOkBtn");
      const cancelBtn = document.getElementById("confirmCancelBtn");
      const cleanup = (result) => {
        okBtn.removeEventListener("click", onOk);
        cancelBtn.removeEventListener("click", onCancel);
        closeModal("confirmModal");
        resolve(result);
      };
      const onOk = () => cleanup(true);
      const onCancel = () => cleanup(false);
      okBtn.addEventListener("click", onOk);
      cancelBtn.addEventListener("click", onCancel);
    });
  }

  /* ========================================================================
     5. RIPPLE BUTTON EFFECT
     ======================================================================== */
  function initRipples() {
    document.addEventListener("click", (e) => {
      const btn = e.target.closest(".ripple");
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      const circle = document.createElement("span");
      const size = Math.max(rect.width, rect.height);
      circle.className = "ripple-circle";
      circle.style.width = circle.style.height = `${size}px`;
      circle.style.left = `${e.clientX - rect.left - size / 2}px`;
      circle.style.top = `${e.clientY - rect.top - size / 2}px`;
      btn.style.position = btn.style.position || "relative";
      btn.style.overflow = "hidden";
      btn.appendChild(circle);
      setTimeout(() => circle.remove(), 600);
    });
  }

  /* ========================================================================
     6. IMAGE HELPERS
     ======================================================================== */
  function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function getImageDims(dataURL) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => resolve({ width: 0, height: 0 });
      img.src = dataURL;
    });
  }

  function formatBytes(bytes) {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let i = 0, n = bytes;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(1)} ${units[i]}`;
  }

  function formatDate(ts) {
    return new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function orientationOf(img) {
    if (img.width === img.height) return "square";
    return img.width > img.height ? "landscape" : "portrait";
  }

  /* ========================================================================
     7. UPLOAD SYSTEM
     ======================================================================== */
  function initUpload() {
    const modal = "uploadModal";
    document.getElementById("navUploadBtn").addEventListener("click", () => openModal(modal));
    document.getElementById("heroUploadBtn").addEventListener("click", () => openModal(modal));
    document.getElementById("galleryUploadBtn").addEventListener("click", () => openModal(modal));

    const dropzone = document.getElementById("dropzone");
    const fileInput = document.getElementById("fileInput");

    dropzone.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", (e) => handleFiles(e.target.files));

    ["dragenter", "dragover"].forEach((ev) =>
      dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("dragover"); })
    );
    ["dragleave", "drop"].forEach((ev) =>
      dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("dragover"); })
    );
    dropzone.addEventListener("drop", (e) => handleFiles(e.dataTransfer.files));

    // Paste support (Ctrl+V) anywhere while modal open
    document.addEventListener("paste", (e) => {
      if (!document.getElementById(modal).classList.contains("open")) return;
      const items = e.clipboardData?.items || [];
      const files = [];
      for (const item of items) {
        if (item.type.startsWith("image/")) files.push(item.getAsFile());
      }
      if (files.length) handleFiles(files);
    });

    document.getElementById("confirmUploadBtn").addEventListener("click", saveUploads);
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
    for (const file of files) {
      const dataURL = await fileToDataURL(file);
      state.pendingUploads.push({ file, dataURL, name: file.name, size: file.size });
    }
    renderUploadPreview();
  }

  function renderUploadPreview() {
    const grid = document.getElementById("uploadPreviewGrid");
    grid.innerHTML = "";
    state.pendingUploads.forEach((item, idx) => {
      const div = document.createElement("div");
      div.className = "upv-item";
      div.innerHTML = `<img src="${item.dataURL}" alt="${item.name}" /><button class="upv-remove">✕</button>`;
      div.querySelector(".upv-remove").addEventListener("click", () => {
        state.pendingUploads.splice(idx, 1);
        renderUploadPreview();
      });
      grid.appendChild(div);
    });
  }

  async function saveUploads() {
    if (!state.pendingUploads.length) { toast("Choose at least one image first."); return; }
    for (const item of state.pendingUploads) {
      const dims = await getImageDims(item.dataURL);
      const record = {
        id: uid(),
        blob: item.dataURL,
        title: item.name.replace(/\.[^/.]+$/, ""),
        description: "",
        tags: [],
        album: "",
        category: "",
        rating: 0,
        favorite: false,
        uploadDate: Date.now(),
        size: item.size,
        width: dims.width,
        height: dims.height,
        name: item.name,
      };
      await dbPut(STORES.images, record);
      state.images.unshift(record);
    }
    toast(`Saved ${state.pendingUploads.length} image${state.pendingUploads.length > 1 ? "s" : ""} to your garden 🌸`);
    state.pendingUploads = [];
    renderUploadPreview();
    document.getElementById("fileInput").value = "";
    closeModal("uploadModal");
    refreshAllViews();
  }

  /* ========================================================================
     8. GALLERY RENDERING
     ======================================================================== */
  function getFilteredImages() {
    const sort = document.getElementById("filterSort").value;
    const albumFilter = document.getElementById("filterAlbum").value;
    const categoryFilter = document.getElementById("filterCategory").value;
    const tagFilter = document.getElementById("filterTag").value.trim().toLowerCase();
    const searchTerm = document.getElementById("globalSearch").value.trim().toLowerCase();

    let list = [...state.images];

    if (albumFilter) list = list.filter((i) => i.album === albumFilter);
    if (categoryFilter) list = list.filter((i) => i.category === categoryFilter);
    if (tagFilter) list = list.filter((i) => (i.tags || []).some((t) => t.toLowerCase().includes(tagFilter)));
    if (searchTerm) {
      list = list.filter((i) => {
        const hay = [i.title, i.description, i.category, i.name, ...(i.tags || []), albumNameOf(i.album)]
          .join(" ")
          .toLowerCase();
        return hay.includes(searchTerm);
      });
    }

    switch (sort) {
      case "oldest": list.sort((a, b) => a.uploadDate - b.uploadDate); break;
      case "favorites": list = list.filter((i) => i.favorite); break;
      case "rating": list.sort((a, b) => b.rating - a.rating); break;
      case "landscape": list = list.filter((i) => orientationOf(i) === "landscape"); break;
      case "portrait": list = list.filter((i) => orientationOf(i) === "portrait"); break;
      case "square": list = list.filter((i) => orientationOf(i) === "square"); break;
      default: list.sort((a, b) => b.uploadDate - a.uploadDate);
    }
    return list;
  }

  function albumNameOf(albumId) {
    const a = state.albums.find((x) => x.id === albumId);
    return a ? a.name : "";
  }

  function gcardHTML(img, index) {
    return `
      <div class="gcard" data-id="${img.id}" style="animation-delay:${Math.min(index, 10) * 0.04}s">
        <img src="${img.blob}" alt="${escapeHTML(img.title)}" loading="lazy" />
        ${img.rating ? `<div class="gcard-rating">${"★".repeat(img.rating)}</div>` : ""}
        <button class="gcard-fav ${img.favorite ? "active" : ""}" data-id="${img.id}">${img.favorite ? "♥" : "♡"}</button>
        <div class="gcard-overlay">
          <div class="gcard-title">${escapeHTML(img.title || "Untitled")}</div>
          <div class="gcard-meta">${formatDate(img.uploadDate)}${img.album ? " · " + escapeHTML(albumNameOf(img.album)) : ""}</div>
        </div>
      </div>`;
  }

  function escapeHTML(str) {
    const d = document.createElement("div");
    d.textContent = str || "";
    return d.innerHTML;
  }

  function renderGallery(reset = false) {
    if (reset) state.galleryVisibleCount = 20;
    const list = getFilteredImages();
    const grid = document.getElementById("galleryGrid");
    const empty = document.getElementById("galleryEmpty");

    if (!list.length) {
      grid.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    const visible = list.slice(0, state.galleryVisibleCount);
    grid.innerHTML = visible.map((img, i) => gcardHTML(img, i)).join("");
    attachGalleryCardEvents(grid, list);
    populateFilterSelects();
  }

  function attachGalleryCardEvents(container, fullList) {
    container.querySelectorAll(".gcard").forEach((card) => {
      card.addEventListener("click", (e) => {
        if (e.target.closest(".gcard-fav")) return;
        openLightbox(card.dataset.id, fullList);
      });
    });
    container.querySelectorAll(".gcard-fav").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await toggleFavorite(btn.dataset.id);
      });
    });
  }

  async function toggleFavorite(id) {
    const img = state.images.find((i) => i.id === id);
    if (!img) return;
    img.favorite = !img.favorite;
    await dbPut(STORES.images, img);
    refreshAllViews();
    toast(img.favorite ? "Added to favorites 💗" : "Removed from favorites");
  }

  function initInfiniteScroll() {
    const sentinel = document.getElementById("gallerySentinel");
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting && state.currentPage === "gallery") {
          const total = getFilteredImages().length;
          if (state.galleryVisibleCount < total) {
            state.galleryVisibleCount += 12;
            renderGallery(false);
          }
        }
      });
    }, { rootMargin: "300px" });
    observer.observe(sentinel);
  }

  function initGalleryFilters() {
    ["filterSort", "filterAlbum", "filterCategory"].forEach((id) => {
      document.getElementById(id).addEventListener("change", () => renderGallery(true));
    });
    document.getElementById("filterTag").addEventListener("input", debounce(() => renderGallery(true), 250));
    document.getElementById("clearFiltersBtn").addEventListener("click", () => {
      document.getElementById("filterSort").value = "newest";
      document.getElementById("filterAlbum").value = "";
      document.getElementById("filterCategory").value = "";
      document.getElementById("filterTag").value = "";
      document.getElementById("globalSearch").value = "";
      renderGallery(true);
    });
    document.getElementById("globalSearch").addEventListener("input", debounce(() => {
      if (state.currentPage !== "gallery") goToPage("gallery");
      else renderGallery(true);
    }, 300));
  }

  function populateFilterSelects() {
    const albumSel = document.getElementById("filterAlbum");
    const catSel = document.getElementById("filterCategory");
    const lbAlbumSel = document.getElementById("lbAlbumSelect");
    const currentAlbum = albumSel.value;
    const currentCat = catSel.value;
    const currentLbAlbum = lbAlbumSel.value;

    albumSel.innerHTML = '<option value="">All Albums</option>' +
      state.albums.map((a) => `<option value="${a.id}">${escapeHTML(a.name)}</option>`).join("");
    albumSel.value = currentAlbum;

    lbAlbumSel.innerHTML = '<option value="">No Album</option>' +
      state.albums.map((a) => `<option value="${a.id}">${escapeHTML(a.name)}</option>`).join("");
    lbAlbumSel.value = currentLbAlbum;

    const categories = [...new Set(state.images.map((i) => i.category).filter(Boolean))];
    catSel.innerHTML = '<option value="">All Categories</option>' +
      categories.map((c) => `<option value="${c}">${escapeHTML(c)}</option>`).join("");
    catSel.value = currentCat;
  }

  function debounce(fn, delay) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
  }

  /* ========================================================================
     9. FAVORITES PAGE
     ======================================================================== */
  function renderFavorites() {
    const list = state.images.filter((i) => i.favorite).sort((a, b) => b.uploadDate - a.uploadDate);
    const grid = document.getElementById("favGrid");
    const empty = document.getElementById("favEmpty");
    if (!list.length) { grid.innerHTML = ""; empty.hidden = false; return; }
    empty.hidden = true;
    grid.innerHTML = list.map((img, i) => gcardHTML(img, i)).join("");
    attachGalleryCardEvents(grid, list);
  }

  /* ========================================================================
     10. LIGHTBOX
     ======================================================================== */
  function openLightbox(id, list) {
    state.lightboxList = list;
    state.lightboxIndex = list.findIndex((i) => i.id === id);
    renderLightbox();
    openModal("lightboxModal");
  }

  function renderLightbox() {
    const img = state.lightboxList[state.lightboxIndex];
    if (!img) return;
    state.activeLightboxId = img.id;

    document.getElementById("lbImage").src = img.blob;
    document.getElementById("lbImage").alt = img.title;
    document.getElementById("lbTitleInput").value = img.title || "";
    document.getElementById("lbDescInput").value = img.description || "";
    document.getElementById("lbTagsInput").value = (img.tags || []).join(", ");
    document.getElementById("lbCategoryInput").value = img.category || "";
    document.getElementById("lbAlbumSelect").value = img.album || "";
    document.getElementById("lbFavBtn").textContent = img.favorite ? "♥" : "♡";
    document.getElementById("lbFavBtn").classList.toggle("active", img.favorite);

    document.querySelectorAll("#lbRating span").forEach((star) => {
      star.classList.toggle("filled", Number(star.dataset.star) <= img.rating);
    });

    const remoteReadOnly = Boolean(img.remoteId);
    ["lbTitleInput", "lbDescInput", "lbTagsInput", "lbAlbumSelect", "lbCategoryInput", "lbSaveBtn", "lbDeleteBtn", "lbFavBtn"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.disabled = remoteReadOnly;
    });
    document.querySelectorAll("#lbRating span").forEach((star) => { star.style.pointerEvents = remoteReadOnly ? "none" : "auto"; star.style.opacity = remoteReadOnly ? "0.65" : "1"; });
    document.getElementById("lbMeta").innerHTML = `
      Uploaded ${formatDate(img.uploadDate)}<br/>
      ${img.width} × ${img.height}px · ${formatBytes(img.size)}<br/>
      File name: ${escapeHTML(img.name || "—")}
    `;
  }

  function initLightbox() {
    document.getElementById("lbPrev").addEventListener("click", () => navigateLightbox(-1));
    document.getElementById("lbNext").addEventListener("click", () => navigateLightbox(1));
    document.addEventListener("keydown", (e) => {
      if (!document.getElementById("lightboxModal").classList.contains("open")) return;
      if (e.key === "ArrowLeft") navigateLightbox(-1);
      if (e.key === "ArrowRight") navigateLightbox(1);
      if (e.key === "Escape") closeModal("lightboxModal");
    });

    document.getElementById("lbFavBtn").addEventListener("click", async () => {
      await toggleFavorite(state.activeLightboxId);
      renderLightbox();
    });

    document.querySelectorAll("#lbRating span").forEach((star) => {
      star.addEventListener("click", async () => {
        const img = state.images.find((i) => i.id === state.activeLightboxId);
        img.rating = Number(star.dataset.star);
        await dbPut(STORES.images, img);
        renderLightbox();
      });
    });

    document.getElementById("lbSaveBtn").addEventListener("click", async () => {
      const img = state.images.find((i) => i.id === state.activeLightboxId);
      if (!img) return;
      img.title = document.getElementById("lbTitleInput").value.trim() || "Untitled";
      img.description = document.getElementById("lbDescInput").value.trim();
      img.tags = document.getElementById("lbTagsInput").value.split(",").map((t) => t.trim()).filter(Boolean);
      img.category = document.getElementById("lbCategoryInput").value.trim();
      img.album = document.getElementById("lbAlbumSelect").value;
      await dbPut(STORES.images, img);
      toast("Changes saved ✓");
      refreshAllViews();
    });

    document.getElementById("lbDeleteBtn").addEventListener("click", async () => {
      const ok = await confirmDialog("Delete this image?", "This memory will be removed permanently from your garden.");
      if (!ok) return;
      const id = state.activeLightboxId;
      await dbDelete(STORES.images, id);
      state.images = state.images.filter((i) => i.id !== id);
      closeModal("lightboxModal");
      toast("Image deleted");
      refreshAllViews();
    });
  }

  function navigateLightbox(delta) {
    const newIndex = state.lightboxIndex + delta;
    if (newIndex < 0 || newIndex >= state.lightboxList.length) return;
    state.lightboxIndex = newIndex;
    renderLightbox();
  }

  /* ========================================================================
     11. ALBUMS
     ======================================================================== */
  let editingAlbumId = null;

  function initAlbums() {
    document.getElementById("createAlbumBtn").addEventListener("click", () => {
      editingAlbumId = null;
      document.getElementById("albumModalTitle").textContent = "New Album";
      document.getElementById("albumNameInput").value = "";
      document.getElementById("albumCategoryInput").value = "";
      openModal("albumModal");
    });

    document.getElementById("saveAlbumBtn").addEventListener("click", async () => {
      const name = document.getElementById("albumNameInput").value.trim();
      if (!name) { toast("Give your album a name first."); return; }
      const category = document.getElementById("albumCategoryInput").value.trim();

      if (editingAlbumId) {
        const album = state.albums.find((a) => a.id === editingAlbumId);
        album.name = name;
        album.category = category;
        await dbPut(STORES.albums, album);
        toast("Album updated");
      } else {
        const album = { id: uid(), name, category, cover: "", createdAt: Date.now() };
        await dbPut(STORES.albums, album);
        state.albums.push(album);
        toast("Album created 📁");
      }
      closeModal("albumModal");
      refreshAllViews();
    });
  }

  function renderAlbums() {
    const grid = document.getElementById("albumGrid");
    const empty = document.getElementById("albumsEmpty");
    if (!state.albums.length) { grid.innerHTML = ""; empty.hidden = false; return; }
    empty.hidden = true;

    grid.innerHTML = state.albums.map((album) => {
      const imgs = state.images.filter((i) => i.album === album.id);
      const cover = imgs[0]?.blob || "";
      return `
        <div class="acard" data-id="${album.id}">
          <div class="acard-cover">${cover ? `<img src="${cover}" alt="${escapeHTML(album.name)}"/>` : `<span class="acard-cover-icon">📁</span>`}</div>
          <div class="acard-body">
            <h4>${escapeHTML(album.name)}</h4>
            <p>${imgs.length} image${imgs.length === 1 ? "" : "s"}${album.category ? " · " + escapeHTML(album.category) : ""}</p>
            <div class="acard-actions">
              <button class="acard-view">View</button>
              <button class="acard-rename">Rename</button>
              <button class="acard-delete">Delete</button>
            </div>
          </div>
        </div>`;
    }).join("");

    grid.querySelectorAll(".acard").forEach((card) => {
      const id = card.dataset.id;
      card.querySelector(".acard-view").addEventListener("click", () => {
        goToPage("gallery");
        document.getElementById("filterAlbum").value = id;
        renderGallery(true);
      });
      card.querySelector(".acard-rename").addEventListener("click", () => {
        const album = state.albums.find((a) => a.id === id);
        editingAlbumId = id;
        document.getElementById("albumModalTitle").textContent = "Rename Album";
        document.getElementById("albumNameInput").value = album.name;
        document.getElementById("albumCategoryInput").value = album.category || "";
        openModal("albumModal");
      });
      card.querySelector(".acard-delete").addEventListener("click", async () => {
        const ok = await confirmDialog("Delete album?", "Images inside will stay in your gallery but will be unassigned from this album.");
        if (!ok) return;
        await dbDelete(STORES.albums, id);
        state.albums = state.albums.filter((a) => a.id !== id);
        for (const img of state.images.filter((i) => i.album === id)) {
          img.album = "";
          await dbPut(STORES.images, img);
        }
        refreshAllViews();
        toast("Album deleted");
      });
    });
  }

  /* ========================================================================
     12. MUSIC PLAYER
     ======================================================================== */
  const audio = document.getElementById("audioPlayer");
  let playIndex = -1;
  let isShuffle = false;
  let repeatMode = "off"; // off | one | all
  let audioCtx = null, analyser = null, sourceNode = null;

  function initMusicUpload() {
    document.getElementById("musicUploadBtn").addEventListener("click", () => openModal("musicUploadModal"));
    const dropzone = document.getElementById("musicDropzone");
    const input = document.getElementById("musicFileInput");
    dropzone.addEventListener("click", () => input.click());
    input.addEventListener("change", (e) => handleMusicFiles(e.target.files));
    ["dragenter", "dragover"].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("dragover"); }));
    ["dragleave", "drop"].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("dragover"); }));
    dropzone.addEventListener("drop", (e) => handleMusicFiles(e.dataTransfer.files));
    document.getElementById("confirmMusicUploadBtn").addEventListener("click", saveMusicUploads);
  }

  function handleMusicFiles(fileList) {
    const files = Array.from(fileList).filter((f) => f.type.startsWith("audio/"));
    files.forEach((file) => state.pendingTracks.push(file));
    renderMusicPreview();
  }

  function renderMusicPreview() {
    const list = document.getElementById("musicPreviewList");
    list.innerHTML = state.pendingTracks.map((f, i) =>
      `<li><span>${escapeHTML(f.name)}</span><button data-i="${i}" class="pl-remove">✕</button></li>`
    ).join("");
    list.querySelectorAll(".pl-remove").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.pendingTracks.splice(Number(btn.dataset.i), 1);
        renderMusicPreview();
      });
    });
  }

  async function saveMusicUploads() {
    if (!state.pendingTracks.length) { toast("Choose at least one audio file."); return; }
    for (const file of state.pendingTracks) {
      const dataURL = await fileToDataURL(file);
      const track = { id: uid(), blob: dataURL, name: file.name.replace(/\.[^/.]+$/, ""), addedAt: Date.now() };
      await dbPut(STORES.tracks, track);
      state.tracks.push(track);
    }
    toast(`Added ${state.pendingTracks.length} track(s) 🎵`);
    state.pendingTracks = [];
    renderMusicPreview();
    document.getElementById("musicFileInput").value = "";
    closeModal("musicUploadModal");
    renderPlaylist();
    updateHeroStats();
  }

  function renderPlaylist() {
    const list = document.getElementById("playlistList");
    const emptyHint = document.getElementById("playlistEmpty");
    if (!state.tracks.length) { list.innerHTML = ""; emptyHint.hidden = false; return; }
    emptyHint.hidden = true;
    list.innerHTML = state.tracks.map((t, i) => `
      <li class="playlist-item ${i === playIndex ? "playing" : ""}" data-i="${i}">
        <span class="pl-idx">${i + 1}</span>
        <span class="pl-name">${escapeHTML(t.name)}</span>
        ${t.remoteId ? "" : `<button class="pl-remove" data-remove="${t.id}">✕</button>`}
      </li>`).join("");
    list.querySelectorAll(".playlist-item").forEach((item) => {
      item.addEventListener("click", (e) => {
        if (e.target.closest(".pl-remove")) return;
        playTrack(Number(item.dataset.i));
      });
    });
    list.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = btn.dataset.remove;
        await dbDelete(STORES.tracks, id);
        const idx = state.tracks.findIndex((t) => t.id === id);
        state.tracks = state.tracks.filter((t) => t.id !== id);
        if (idx === playIndex) stopPlayback();
        renderPlaylist();
        updateHeroStats();
      });
    });
  }

  function playTrack(index) {
    if (index < 0 || index >= state.tracks.length) return;
    playIndex = index;
    const track = state.tracks[index];
    audio.src = track.blob;
    audio.volume = state.settings.defaultVolume / 100;
    audio.play().catch(() => {});
    document.getElementById("npTitle").textContent = track.name;
    document.getElementById("npSub").textContent = `Track ${index + 1} of ${state.tracks.length}`;
    document.getElementById("miniTitle").textContent = track.name;
    document.getElementById("miniPlayer").hidden = false;
    setPlayIcon(true);
    renderPlaylist();
    saveSetting("lastTrackIndex", index);
    initVisualizer();
  }

  function setPlayIcon(playing) {
    document.getElementById("npPlay").textContent = playing ? "⏸" : "▶";
    document.getElementById("miniPlayBtn").textContent = playing ? "⏸" : "▶";
  }

  function stopPlayback() {
    audio.pause();
    audio.removeAttribute("src");
    playIndex = -1;
    setPlayIcon(false);
    document.getElementById("miniPlayer").hidden = true;
  }

  function togglePlay() {
    if (!audio.src) { if (state.tracks.length) playTrack(0); return; }
    if (audio.paused) { audio.play(); setPlayIcon(true); }
    else { audio.pause(); setPlayIcon(false); }
  }

  function nextTrack() {
    if (!state.tracks.length) return;
    if (isShuffle) {
      let idx = Math.floor(Math.random() * state.tracks.length);
      playTrack(idx);
    } else {
      playTrack((playIndex + 1) % state.tracks.length);
    }
  }

  function prevTrack() {
    if (!state.tracks.length) return;
    playTrack((playIndex - 1 + state.tracks.length) % state.tracks.length);
  }

  function initMusicControls() {
    document.getElementById("npPlay").addEventListener("click", togglePlay);
    document.getElementById("miniPlayBtn").addEventListener("click", togglePlay);
    document.getElementById("npNext").addEventListener("click", nextTrack);
    document.getElementById("npPrev").addEventListener("click", prevTrack);
    document.getElementById("miniExpandBtn").addEventListener("click", () => goToPage("music"));

    document.getElementById("npShuffle").addEventListener("click", (e) => {
      isShuffle = !isShuffle;
      e.currentTarget.style.color = isShuffle ? "var(--accent)" : "";
      toast(isShuffle ? "Shuffle on" : "Shuffle off");
    });

    document.getElementById("npRepeat").addEventListener("click", (e) => {
      const modes = ["off", "all", "one"];
      repeatMode = modes[(modes.indexOf(repeatMode) + 1) % modes.length];
      e.currentTarget.style.color = repeatMode !== "off" ? "var(--accent)" : "";
      toast(`Repeat: ${repeatMode}`);
    });

    document.getElementById("npVolume").addEventListener("input", (e) => {
      audio.volume = e.target.value / 100;
    });

    document.getElementById("npProgress").addEventListener("input", (e) => {
      if (audio.duration) audio.currentTime = (e.target.value / 100) * audio.duration;
    });

    audio.addEventListener("timeupdate", () => {
      if (!audio.duration) return;
      const pct = (audio.currentTime / audio.duration) * 100;
      document.getElementById("npProgress").value = pct;
      document.getElementById("miniBarFill").style.width = pct + "%";
      document.getElementById("npTimeCurrent").textContent = formatTime(audio.currentTime);
      document.getElementById("npTimeTotal").textContent = formatTime(audio.duration);
      saveSetting("lastPlaybackPosition", audio.currentTime);
    });

    audio.addEventListener("ended", () => {
      if (repeatMode === "one") { audio.currentTime = 0; audio.play(); return; }
      if (playIndex === state.tracks.length - 1 && repeatMode === "off") { setPlayIcon(false); return; }
      nextTrack();
    });

    audio.addEventListener("play", () => setPlayIcon(true));
    audio.addEventListener("pause", () => setPlayIcon(false));
  }

  function formatTime(sec) {
    if (!isFinite(sec)) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }

  function initVisualizer() {
    if (audioCtx) return; // only need to init once
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      sourceNode = audioCtx.createMediaElementSource(audio);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
      sourceNode.connect(analyser);
      analyser.connect(audioCtx.destination);
      drawVisualizer();
    } catch (err) {
      // AudioContext may fail on some browsers/contexts; fail silently
    }
  }

  function drawVisualizer() {
    const canvas = document.getElementById("visualizerCanvas");
    const ctx = canvas.getContext("2d");
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    function draw() {
      requestAnimationFrame(draw);
      canvas.width = canvas.clientWidth;
      canvas.height = canvas.clientHeight;
      analyser.getByteFrequencyData(dataArray);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const barWidth = canvas.width / bufferLength;
      const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#8AB8E8";
      const gradient = ctx.createLinearGradient(0, canvas.height, 0, 0);
      gradient.addColorStop(0, accent);
      gradient.addColorStop(1, "#f0a8c4");
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      // Soft smoothing prevents harsh jumps and looks better on mobile displays.
      if (!draw.smooth) draw.smooth = new Float32Array(bufferLength);
      for (let i = 0; i < bufferLength; i++) {
        draw.smooth[i] += (dataArray[i] - draw.smooth[i]) * 0.28;
        const value = draw.smooth[i] / 255;
        const h = Math.max(2, value * canvas.height * 0.92);
        const x = i * barWidth;
        ctx.fillStyle = gradient;
        ctx.globalAlpha = 0.42 + value * 0.58;
        const w = Math.max(1, barWidth - Math.max(1, dpr));
        const y = canvas.height - h;
        const r = Math.min(w / 2, 5 * dpr, h / 2);
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    draw();
  }

  /* ========================================================================
     13. STATISTICS
     ======================================================================== */
  function renderStats() {
    const totalImages = state.images.length;
    const totalFavs = state.images.filter((i) => i.favorite).length;
    const totalAlbums = state.albums.length;
    const totalTracks = state.tracks.length;
    const storageBytes = state.images.reduce((sum, i) => sum + (i.size || 0), 0) +
      state.tracks.reduce((sum, t) => sum + (t.blob ? t.blob.length * 0.75 : 0), 0);
    const ratedImages = state.images.filter((i) => i.rating > 0);
    const avgRating = ratedImages.length
      ? (ratedImages.reduce((s, i) => s + i.rating, 0) / ratedImages.length).toFixed(1)
      : "—";
    const recent = state.images.length
      ? formatDate(Math.max(...state.images.map((i) => i.uploadDate)))
      : "—";

    const cards = [
      { label: "Total Images", value: totalImages },
      { label: "Favorites", value: totalFavs },
      { label: "Albums", value: totalAlbums },
      { label: "Music Tracks", value: totalTracks },
      { label: "Storage Used", value: formatBytes(storageBytes) },
      { label: "Average Rating", value: avgRating === "—" ? "—" : `${avgRating} ★` },
      { label: "Recently Added", value: recent },
    ];

    document.getElementById("statsGrid").innerHTML = cards.map((c) => `
      <div class="glass stat-card">
        <span class="stat-num">${c.value}</span>
        <span class="stat-label">${c.label}</span>
      </div>`).join("");
  }

  /* ========================================================================
     14. HOME PAGE UPDATES
     ======================================================================== */
  function updateHeroStats() {
    document.getElementById("hsImages").textContent = state.images.length;
    document.getElementById("hsAlbums").textContent = state.albums.length;
    document.getElementById("hsFavs").textContent = state.images.filter((i) => i.favorite).length;
    document.getElementById("hsTracks").textContent = state.tracks.length;

    const strip = document.getElementById("recentStrip");
    const recent = [...state.images].sort((a, b) => b.uploadDate - a.uploadDate).slice(0, 10);
    if (!recent.length) {
      strip.innerHTML = `<p class="empty-hint">Nothing here yet — upload your first image to begin your garden.</p>`;
      return;
    }
    strip.innerHTML = recent.map((img) => `
      <div class="recent-thumb" data-id="${img.id}">
        <img src="${img.blob}" alt="${escapeHTML(img.title)}" loading="lazy" />
      </div>`).join("");
    strip.querySelectorAll(".recent-thumb").forEach((el) => {
      el.addEventListener("click", () => openLightbox(el.dataset.id, recent));
    });
  }

  function refreshAllViews() {
    updateHeroStats();
    populateFilterSelects();
    if (state.currentPage === "gallery") renderGallery(false);
    if (state.currentPage === "favorites") renderFavorites();
    if (state.currentPage === "albums") renderAlbums();
    if (state.currentPage === "stats") renderStats();
  }

  /* ========================================================================
     15. SETTINGS
     ======================================================================== */
  async function saveSetting(key, value) {
    state.settings[key] = value;
    await dbPut(STORES.settings, { key, value });
  }

  function applyTheme() {
    let effectiveTheme = state.settings.theme;
    if (effectiveTheme === "auto") {
      effectiveTheme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    document.documentElement.setAttribute("data-theme", effectiveTheme);
  }

  function applyAccent() {
    const hex = state.settings.accent;
    document.documentElement.style.setProperty("--accent", hex);
    const rgb = hexToRgb(hex);
    document.documentElement.style.setProperty("--accent-rgb", `${rgb.r}, ${rgb.g}, ${rgb.b}`);
  }

  function hexToRgb(hex) {
    const m = hex.replace("#", "").match(/.{1,2}/g);
    return { r: parseInt(m[0], 16), g: parseInt(m[1], 16), b: parseInt(m[2], 16) };
  }

  function applyBlur() { document.documentElement.style.setProperty("--blur", `${state.settings.blur}px`); }
  function applyAnimSpeed() { document.documentElement.style.setProperty("--anim-speed", state.settings.animSpeed / 100); }

  function initSettings() {
    // Theme
    document.querySelectorAll("#themeSegment button").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#themeSegment button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        saveSetting("theme", btn.dataset.theme);
        applyTheme();
      });
    });

    // Accent
    document.querySelectorAll(".swatch").forEach((sw) => {
      sw.addEventListener("click", () => {
        document.querySelectorAll(".swatch").forEach((s) => s.classList.remove("active"));
        sw.classList.add("active");
        saveSetting("accent", sw.dataset.accent);
        applyAccent();
      });
    });

    document.getElementById("blurSlider").addEventListener("input", (e) => {
      saveSetting("blur", Number(e.target.value));
      applyBlur();
    });

    document.getElementById("animSpeedSlider").addEventListener("input", (e) => {
      saveSetting("animSpeed", Number(e.target.value));
      applyAnimSpeed();
    });

    document.getElementById("sakuraToggle").addEventListener("change", (e) => {
      saveSetting("sakuraOn", e.target.checked);
      sakura.setEnabled(e.target.checked);
    });

    document.getElementById("sakuraDensity").addEventListener("input", (e) => {
      saveSetting("sakuraDensity", Number(e.target.value));
      sakura.setDensity(Number(e.target.value));
    });

    document.getElementById("defaultVolumeSlider").addEventListener("input", (e) => {
      saveSetting("defaultVolume", Number(e.target.value));
      audio.volume = e.target.value / 100;
      document.getElementById("npVolume").value = e.target.value;
    });

    document.getElementById("exportBtn").addEventListener("click", exportData);
    document.getElementById("importBtn").addEventListener("click", () => document.getElementById("importFile").click());
    document.getElementById("importFile").addEventListener("change", (e) => importData(e.target.files[0]));

    document.getElementById("resetBtn").addEventListener("click", async () => {
      const ok = await confirmDialog("Reset entire database?", "This permanently deletes every image, album, and track. This cannot be undone.");
      if (!ok) return;
      await dbClear(STORES.images);
      await dbClear(STORES.albums);
      await dbClear(STORES.tracks);
      state.images = []; state.albums = []; state.tracks = [];
      stopPlayback();
      refreshAllViews();
      renderPlaylist();
      toast("Database reset");
    });
  }

  function applySettingsToUI() {
    document.querySelectorAll("#themeSegment button").forEach((b) => b.classList.toggle("active", b.dataset.theme === state.settings.theme));
    document.querySelectorAll(".swatch").forEach((s) => s.classList.toggle("active", s.dataset.accent === state.settings.accent));
    document.getElementById("blurSlider").value = state.settings.blur;
    document.getElementById("animSpeedSlider").value = state.settings.animSpeed;
    document.getElementById("sakuraToggle").checked = state.settings.sakuraOn;
    document.getElementById("sakuraDensity").value = state.settings.sakuraDensity;
    document.getElementById("defaultVolumeSlider").value = state.settings.defaultVolume;
    document.getElementById("npVolume").value = state.settings.defaultVolume;
    applyTheme(); applyAccent(); applyBlur(); applyAnimSpeed();
  }

  /* ---------- Export / Import ---------- */
  async function exportData() {
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      images: state.images,
      albums: state.albums,
      tracks: state.tracks,
      settings: state.settings,
    };
    const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mahiru-memory-garden-backup-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast("Export ready — check your downloads");
  }

  function importData(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const data = JSON.parse(reader.result);
        for (const img of data.images || []) await dbPut(STORES.images, img);
        for (const album of data.albums || []) await dbPut(STORES.albums, album);
        for (const track of data.tracks || []) await dbPut(STORES.tracks, track);
        if (data.settings) {
          for (const [key, value] of Object.entries(data.settings)) await saveSetting(key, value);
        }
        await loadAllData();
        applySettingsToUI();
        refreshAllViews();
        renderPlaylist();
        toast("Import complete 🌸");
      } catch (err) {
        toast("Import failed — invalid file");
      }
    };
    reader.readAsText(file);
  }

  /* ========================================================================
     16. SAKURA MODE (falling petals canvas)
     ======================================================================== */
  const sakura = (() => {
    const canvas = document.getElementById("sakuraCanvas");
    const ctx = canvas.getContext("2d");
    let petals = [];
    let enabled = true;
    let density = 18;
    let animId = null;

    function resize() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }

    function makePetal() {
      return {
        x: Math.random() * canvas.width,
        y: Math.random() * -canvas.height,
        size: 8 + Math.random() * 10,
        speedY: 0.6 + Math.random() * 1.2,
        speedX: Math.sin(Math.random() * Math.PI) * 0.6,
        rotation: Math.random() * 360,
        rotSpeed: (Math.random() - 0.5) * 2,
        sway: Math.random() * Math.PI * 2,
        hue: 330 + Math.random() * 20,
      };
    }

    function ensureCount() {
      const target = enabled ? density : 0;
      while (petals.length < target) petals.push(makePetal());
      if (petals.length > target) petals.length = target;
    }

    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const speedMultiplier = (state.settings.animSpeed || 100) / 100;
      petals.forEach((p) => {
        p.sway += 0.02;
        p.y += p.speedY * speedMultiplier;
        p.x += Math.sin(p.sway) * 0.6;
        p.rotation += p.rotSpeed;
        if (p.y > canvas.height + 20) { p.y = -20; p.x = Math.random() * canvas.width; }

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rotation * Math.PI) / 180);
        ctx.fillStyle = `hsla(${p.hue}, 80%, 85%, 0.85)`;
        ctx.beginPath();
        ctx.ellipse(0, 0, p.size / 2, p.size / 3, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      });
      animId = requestAnimationFrame(draw);
    }

    function start() {
      resize();
      ensureCount();
      if (!animId) draw();
    }

    window.addEventListener("resize", resize);

    return {
      init() { start(); },
      setEnabled(v) { enabled = v; ensureCount(); },
      setDensity(v) { density = v; ensureCount(); },
    };
  })();

  /* ========================================================================
     17. AMBIENT PARTICLE FIELD (home page atmosphere)
     ======================================================================== */
  function initParticleField() {
    const field = document.getElementById("particleField");
    const count = 22;
    for (let i = 0; i < count; i++) {
      const p = document.createElement("div");
      p.className = "particle";
      const size = 3 + Math.random() * 6;
      p.style.width = `${size}px`;
      p.style.height = `${size}px`;
      p.style.left = `${Math.random() * 100}%`;
      p.style.animationDuration = `${14 + Math.random() * 16}s`;
      p.style.animationDelay = `${Math.random() * 14}s`;
      field.appendChild(p);
    }
  }

  /* ========================================================================
     18. ANGEL MODE (secret — click logo 5x)
     ======================================================================== */
  const ANGEL_QUOTES = [
    "Even a small kindness can light up someone's whole day.",
    "It's alright to rest — the garden will still be here when you return.",
    "A gentle heart is never a weak one.",
    "The quiet moments are often the ones worth remembering most.",
    "You don't have to carry everything alone today.",
    "Some days just need a warm cup of tea and a soft blanket.",
    "Every memory you keep is a little piece of happiness saved for later.",
    "Being kind to yourself is its own kind of courage.",
  ];

  function initAngelMode() {
    document.getElementById("logoButton").addEventListener("click", () => {
      state.logoClickCount++;
      clearTimeout(state.logoClickTimer);
      state.logoClickTimer = setTimeout(() => { state.logoClickCount = 0; }, 1500);
      if (state.logoClickCount >= 5) {
        state.logoClickCount = 0;
        toggleAngelMode();
      }
    });
  }

  function toggleAngelMode() {
    state.angelMode = !state.angelMode;
    document.body.classList.toggle("angel-mode", state.angelMode);
    if (state.angelMode) {
      sakura.setDensity(Math.max(state.settings.sakuraDensity, 40));
      showAngelQuote();
      toast("✨ Angel Mode activated ✨");
    } else {
      sakura.setDensity(state.settings.sakuraDensity);
      document.getElementById("angelQuote").classList.remove("show");
      toast("Angel Mode deactivated");
    }
  }

  function showAngelQuote() {
    if (!state.angelMode) return;
    const el = document.getElementById("angelQuote");
    el.textContent = ANGEL_QUOTES[Math.floor(Math.random() * ANGEL_QUOTES.length)];
    el.classList.add("show");
    setTimeout(() => {
      el.classList.remove("show");
      if (state.angelMode) setTimeout(showAngelQuote, 6000);
    }, 5500);
  }

  /* ========================================================================
     19. DATA LOADING / BOOTSTRAP
     ======================================================================== */
  async function loadAllData() {
    state.images = await dbGetAll(STORES.images);
    state.albums = await dbGetAll(STORES.albums);
    state.tracks = await dbGetAll(STORES.tracks);
    const settingsRows = await dbGetAll(STORES.settings);
    settingsRows.forEach((row) => { state.settings[row.key] = row.value; });
  }

  async function init() {
    await openDB();
    await loadAllData();
    await loadPublishedMedia();

    initNav();
    initAITools();
    initModals();
    initRipples();
    // Public uploads are disabled. Publishing is handled by the authenticated /admin panel.
    initGalleryFilters();
    initInfiniteScroll();
    initLightbox();
    initAlbums();
    // Track uploads are admin-only.
    initMusicControls();
    initSettings();
    initAngelMode();
    initParticleField();

    applySettingsToUI();
    sakura.setDensity(state.settings.sakuraDensity);
    sakura.setEnabled(state.settings.sakuraOn);
    sakura.init();

    refreshAllViews();
    renderPlaylist();
    goToPage("home");
  }

  document.addEventListener("DOMContentLoaded", init);
})();

/* ============ GOOGLE DRIVE FOLDER EMBED (added feature) ============ */
(function () {
  const STORAGE_KEY = "mahiruDriveFolderLink";

  function extractFolderId(input) {
    if (!input) return null;
    const trimmed = input.trim();
    // If user pasted a full folder URL
    const match = trimmed.match(/folders\/([a-zA-Z0-9_-]+)/);
    if (match) return match[1];
    // If user pasted just the raw ID
    if (/^[a-zA-Z0-9_-]{10,}$/.test(trimmed)) return trimmed;
    return null;
  }

  function renderFrame(folderId) {
    const frame = document.getElementById("driveFrame");
    const emptyHint = document.getElementById("driveEmptyHint");
    if (!frame) return;
    if (folderId) {
      frame.src = `https://drive.google.com/embeddedfolderview?id=${folderId}#grid`;
      frame.hidden = false;
      if (emptyHint) emptyHint.hidden = true;
    } else {
      frame.src = "";
      frame.hidden = true;
      if (emptyHint) emptyHint.hidden = false;
    }
  }

  function init() {
    const input = document.getElementById("driveLinkInput");
    const saveBtn = document.getElementById("driveSaveBtn");
    const clearBtn = document.getElementById("driveClearBtn");
    const toggleBtn = document.getElementById("driveToggleBtn");
    const body = document.getElementById("drivePanelBody");
    if (!input || !saveBtn) return;

    const savedLink = localStorage.getItem(STORAGE_KEY) || "";
    input.value = savedLink;
    renderFrame(extractFolderId(savedLink));

    saveBtn.addEventListener("click", () => {
      const val = input.value.trim();
      const folderId = extractFolderId(val);
      if (!folderId) {
        alert("Ye link sahi nahi lag raha. Poora Drive folder link paste karo (share link).");
        return;
      }
      localStorage.setItem(STORAGE_KEY, val);
      renderFrame(folderId);
    });

    clearBtn.addEventListener("click", () => {
      localStorage.removeItem(STORAGE_KEY);
      input.value = "";
      renderFrame(null);
    });

    if (toggleBtn && body) {
      toggleBtn.addEventListener("click", () => {
        body.classList.toggle("collapsed");
        toggleBtn.textContent = body.classList.contains("collapsed") ? "+" : "−";
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

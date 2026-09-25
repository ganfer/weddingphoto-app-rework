const $ = selector => document.querySelector(selector);
const loginPanel = $("#loginPanel");
const galleryPanel = $("#galleryPanel");
const gallery = $("#gallery");
const uploadForm = $("#uploadForm");
const fileInput = $("#fileInput");
const selectedFiles = $("#selectedFiles");
const submitUpload = $("#submitUpload");
const lightbox = $("#lightbox");
let images = [];
let activeIndex = 0;
let role = "guest";

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", ...options });
  const type = response.headers.get("content-type") || "";
  const data = type.includes("application/json") ? await response.json() : null;
  if (!response.ok) throw new Error(data?.error || `Anfrage fehlgeschlagen (${response.status}).`);
  return data;
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("visible"), 2800);
}

function showLogin(error = "") {
  galleryPanel.hidden = true;
  loginPanel.hidden = false;
  $("#loginError").textContent = error;
  $("#password").focus();
}

async function start() {
  const params = new URLSearchParams(location.search);
  if (params.has("access")) {
    history.replaceState(null, "", location.pathname);
    showLogin("Der Zugangslink ist ungültig oder abgelaufen.");
    return;
  }
  try {
    const session = await api("/api/session");
    $("#appTitle").textContent = session.appName;
    document.title = session.appName;
    if (!session.authenticated) return showLogin();
    role = session.role;
    await showGallery();
  } catch (error) {
    showLogin(error.message);
  }
}

$("#loginForm").addEventListener("submit", async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  try {
    const result = await api("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: $("#password").value }) });
    role = result.role;
    $("#password").value = "";
    await showGallery();
  } catch (error) {
    $("#loginError").textContent = error.message;
  } finally { button.disabled = false; }
});

$("#logoutButton").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  location.reload();
});

$("#uploadButton").addEventListener("click", () => { uploadForm.hidden = !uploadForm.hidden; });

function updateFileList() {
  const files = Array.from(fileInput.files || []);
  selectedFiles.textContent = files.length ? `${files.length} ${files.length === 1 ? "Bild ausgewählt" : "Bilder ausgewählt"}` : "Keine Dateien ausgewählt";
  submitUpload.disabled = files.length === 0;
}
fileInput.addEventListener("change", updateFileList);

const dropZone = $("#dropZone");
for (const eventName of ["dragenter", "dragover"]) dropZone.addEventListener(eventName, event => { event.preventDefault(); dropZone.classList.add("is-dragging"); });
for (const eventName of ["dragleave", "drop"]) dropZone.addEventListener(eventName, event => { event.preventDefault(); dropZone.classList.remove("is-dragging"); });
dropZone.addEventListener("drop", event => {
  const transfer = new DataTransfer();
  Array.from(event.dataTransfer.files).filter(file => file.type.startsWith("image/") || /\.(heic|heif|avif)$/i.test(file.name)).forEach(file => transfer.items.add(file));
  fileInput.files = transfer.files;
  updateFileList();
});

uploadForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (!fileInput.files.length) return;
  submitUpload.disabled = true;
  $("#status").textContent = "Bilder werden sicher nach pCloud übertragen …";
  const body = new FormData();
  for (const file of fileInput.files) body.append("files[]", file, file.name);
  try {
    const result = await api("/api/upload", { method: "POST", body });
    fileInput.value = "";
    updateFileList();
    uploadForm.hidden = true;
    showToast(`${result.uploaded.length || "Die"} Bilder wurden hochgeladen.`);
    await loadImages();
  } catch (error) {
    $("#status").textContent = error.message;
  } finally { submitUpload.disabled = fileInput.files.length === 0; }
});

async function showGallery() {
  loginPanel.hidden = true;
  galleryPanel.hidden = false;
  await loadImages();
}

async function loadImages() {
  $("#status").textContent = "Galerie wird geladen …";
  const result = await api("/api/gallery");
  images = result.images;
  $("#photoCount").textContent = images.length;
  $("#status").textContent = "";
  $("#emptyState").hidden = images.length !== 0;
  gallery.replaceChildren();
  const fragment = document.createDocumentFragment();
  images.forEach((image, index) => {
    const card = document.createElement("article");
    card.className = "photo-card";
    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.src = `/api/images/${encodeURIComponent(image.id)}?size=thumb`;
    img.alt = image.name;
    img.addEventListener("click", () => openLightbox(index));
    card.append(img);
    if (role === "admin") {
      const remove = document.createElement("button");
      remove.className = "delete-photo";
      remove.type = "button";
      remove.title = "Bild löschen";
      remove.setAttribute("aria-label", `Bild ${image.name} löschen`);
      remove.textContent = "×";
      remove.addEventListener("click", async () => {
        if (!confirm(`„${image.name}“ endgültig aus pCloud löschen?`)) return;
        try {
          await api(`/api/images/${encodeURIComponent(image.id)}`, { method: "DELETE" });
          showToast("Bild wurde gelöscht.");
          await loadImages();
        } catch (error) { showToast(error.message); }
      });
      card.append(remove);
    }
    fragment.append(card);
  });
  gallery.append(fragment);
}

function openLightbox(index) {
  activeIndex = index;
  renderLightbox();
  lightbox.hidden = false;
  $("#lightboxClose").focus();
}
function renderLightbox() {
  const image = images[activeIndex];
  if (!image) return closeLightbox();
  $("#lightboxImage").src = `/api/images/${encodeURIComponent(image.id)}?size=display`;
  $("#lightboxImage").alt = image.name;
  $("#lightboxName").textContent = image.name;
  $("#downloadOriginal").href = `/api/images/${encodeURIComponent(image.id)}?size=original`;
}
function closeLightbox() { lightbox.hidden = true; $("#lightboxImage").removeAttribute("src"); }
function showNext(direction) { activeIndex = (activeIndex + direction + images.length) % images.length; renderLightbox(); }
$("#lightboxClose").addEventListener("click", closeLightbox);
$("#lightboxPrev").addEventListener("click", () => showNext(-1));
$("#lightboxNext").addEventListener("click", () => showNext(1));
lightbox.addEventListener("click", event => { if (event.target === lightbox) closeLightbox(); });
document.addEventListener("keydown", event => {
  if (lightbox.hidden) return;
  if (event.key === "Escape") closeLightbox();
  if (event.key === "ArrowLeft") showNext(-1);
  if (event.key === "ArrowRight") showNext(1);
});

start();

import { createClient } from "@supabase/supabase-js";
import DOMPurify from "dompurify";
import { marked } from "marked";

const SUPABASE_URL = import.meta.env.PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;
const CHAT_FUNCTION = import.meta.env.PUBLIC_SUPABASE_CHAT_FUNCTION ?? "chat";
const EMBED_FUNCTION =
  import.meta.env.PUBLIC_SUPABASE_EMBED_FUNCTION ?? "generate-embeddings";

const DOCUMENTS_BUCKET = "documents";
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB of text per file.

const root = document.querySelector(".app-shell");
const authForm = document.querySelector("#auth-form");
const authHeading = document.querySelector("#auth-heading");
const authCopy = document.querySelector("#auth-copy");
const authSubmit = document.querySelector("#auth-submit");
const authToggle = document.querySelector("#auth-toggle");
const authStatus = document.querySelector("#auth-status");
const emailInput = document.querySelector("#email");
const passwordInput = document.querySelector("#password");
const accountEmail = document.querySelector("#account-email");
const chatList = document.querySelector("#chat-list");
const chatCount = document.querySelector("#chat-count");
const newChatButton = document.querySelector("#new-chat");
const signOutButton = document.querySelector("#sign-out");
const fileInput = document.querySelector("#file-input");
const fileList = document.querySelector("#file-list");
const fileCount = document.querySelector("#file-count");
const fileStatus = document.querySelector("#file-status");
const uploadLabel = document.querySelector("#upload-label");
const uploadLabelText = document.querySelector("#upload-label-text");
const composer = document.querySelector("#composer");
const promptInput = document.querySelector("#prompt");
const sendButton = document.querySelector("#send-message");
const messagesNode = document.querySelector("#messages");
const activeTitle = document.querySelector("#active-title");
const connectionStatus = document.querySelector("#connection-status");
const sidebar = document.querySelector("#sidebar");
const scrim = document.querySelector("#scrim");
const openSidebar = document.querySelector("#open-sidebar");
const closeSidebar = document.querySelector("#close-sidebar");
const sidebarTabs = document.querySelectorAll("[data-tab]");
const sidebarPanels = document.querySelectorAll("[data-panel]");
const fileViewer = document.querySelector("#file-viewer");
const fileViewerTitle = document.querySelector("#file-viewer-title");
const fileViewerBody = document.querySelector("#file-viewer-body");
const closeFileViewer = document.querySelector("#close-file-viewer");

let supabase = null;
let authMode = "sign-in";
let session = null;
let currentUser = null;
let chats = [];
let activeChatId = null;
let messages = [];
let files = [];
let isSending = false;
let isUploading = false;
let scrollFrame = 0;

const formatDate = (value) =>
  new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(value));

const setView = (view) => {
  root?.setAttribute("data-view", view);
};

const setAuthStatus = (message, tone = "error") => {
  if (!authStatus) return;
  authStatus.textContent = message;
  authStatus.dataset.tone = tone;
};

const setConnectionStatus = (message, tone = "neutral") => {
  if (!connectionStatus) return;
  connectionStatus.textContent = message;
  connectionStatus.dataset.tone = tone;
};

const updateAuthMode = () => {
  const isSignIn = authMode === "sign-in";
  if (authHeading) authHeading.textContent = isSignIn ? "Sign in" : "Create account";
  if (authCopy) {
    authCopy.textContent = isSignIn
      ? "Use your email and password to open your chat history."
      : "Create an email/password account to start chatting with RAGify AI.";
  }
  if (authSubmit) authSubmit.textContent = isSignIn ? "Sign in" : "Create account";
  if (authToggle) {
    authToggle.textContent = isSignIn
      ? "Need an account? Create one"
      : "Already have an account? Sign in";
  }
  if (passwordInput) {
    passwordInput.setAttribute("autocomplete", isSignIn ? "current-password" : "new-password");
  }
  setAuthStatus("");
};

const escapeHtml = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const ICON_FILE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></svg>`;
const ICON_TRASH = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></svg>`;
const ICON_EMPTY = `<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>`;

const isMarkdownFile = (name) => /\.(md|markdown)$/i.test(name);

marked.use({
  gfm: true,
  breaks: true,
});

const renderMarkdown = (content) =>
  DOMPurify.sanitize(marked.parse(content, { async: false }), {
    ADD_ATTR: ["target"],
  });

const renderMessageContent = (message) =>
  message.role === "assistant"
    ? renderMarkdown(message.content)
    : `<p>${escapeHtml(message.content).replaceAll("\n", "<br />")}</p>`;

const getTextDirection = (content) =>
  /[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]/.test(content) ? "rtl" : "ltr";

const renderEmptyState = () => `
  <div class="empty-state">
    <span class="empty-icon" aria-hidden="true">${ICON_EMPTY}</span>
    <h2>Start a conversation</h2>
    <p>Upload documents from the Files tab and RAGify AI will answer using them as context. Every thread is saved automatically.</p>
  </div>
`;

const renderLoadingBubble = () => `
  <article class="message assistant loading" aria-label="RAGify AI is typing">
    <div class="avatar">R</div>
    <div class="bubble typing-bubble">
      <span></span>
      <span></span>
      <span></span>
    </div>
  </article>
`;

const renderMessages = () => {
  if (!messagesNode) return;

  if (!messages.length && !isSending) {
    messagesNode.innerHTML = renderEmptyState();
    return;
  }

  const renderedMessages = messages
    .map(
      (message) => `
        <article class="message ${message.role}" data-direction="${getTextDirection(message.content)}">
          <div class="avatar">${message.role === "user" ? "You" : "R"}</div>
          <div class="bubble" dir="${getTextDirection(message.content)}">
            ${renderMessageContent(message)}
          </div>
        </article>
      `,
    )
    .join("");

  messagesNode.innerHTML = `${renderedMessages}${isSending ? renderLoadingBubble() : ""}`;
  cancelAnimationFrame(scrollFrame);
  scrollFrame = requestAnimationFrame(() => {
    messagesNode.scrollTop = messagesNode.scrollHeight;
  });
};

const renderChats = () => {
  if (!chatList || !chatCount) return;

  chatCount.textContent = String(chats.length);

  if (!chats.length) {
    chatList.innerHTML = `
      <div class="empty-list">
        No saved chats yet. Start a conversation to create one.
      </div>
    `;
    return;
  }

  chatList.innerHTML = chats
    .map(
      (chat) => `
        <button class="chat-item ${chat.id === activeChatId ? "active" : ""}" type="button" data-chat-id="${chat.id}">
          <span>${escapeHtml(chat.title)}</span>
          <small>${formatDate(chat.created_at)}</small>
        </button>
      `,
    )
    .join("");
};

const renderActiveTitle = () => {
  const activeChat = chats.find((chat) => chat.id === activeChatId);
  if (activeTitle) {
    activeTitle.textContent = activeChat?.title ?? "New chat";
  }
};

const setFileStatus = (message, tone = "neutral") => {
  if (!fileStatus) return;
  fileStatus.textContent = message;
  fileStatus.dataset.tone = tone;
};

const setUploading = (value) => {
  isUploading = value;
  if (fileInput) fileInput.disabled = value;
  if (uploadLabel) uploadLabel.dataset.busy = String(value);
  if (uploadLabelText) {
    uploadLabelText.textContent = value ? "Working..." : "Upload a file";
  }
};

// Storage object keys must start with the user's id, so keep names simple and
// free of path separators.
const sanitizeFileName = (name) => {
  const base = name.split(/[\\/]/).pop() ?? name;
  const cleaned = base.replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "");
  return cleaned || "file.txt";
};

const renderFiles = () => {
  if (!fileList || !fileCount) return;

  fileCount.textContent = String(files.length);

  if (!files.length) {
    fileList.innerHTML = `
      <div class="empty-list">
        No files yet. Upload one to give RAGify AI context.
      </div>
    `;
    return;
  }

  fileList.innerHTML = files
    .map(
      (name) => `
        <div class="file-item" role="listitem">
          <button
            class="file-open"
            type="button"
            data-file-view="${escapeHtml(name)}"
            title="View ${escapeHtml(name)}"
          >
            ${ICON_FILE}
            <span class="file-name">${escapeHtml(name)}</span>
          </button>
          <button
            class="file-remove"
            type="button"
            data-file-name="${escapeHtml(name)}"
            aria-label="Delete ${escapeHtml(name)}"
            title="Delete file"
          >${ICON_TRASH}</button>
        </div>
      `,
    )
    .join("");
};

const loadFiles = async () => {
  if (!currentUser) return;

  const { data, error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .list(currentUser.id, { sortBy: { column: "name", order: "asc" } });

  if (error) {
    setFileStatus(error.message, "error");
    return;
  }

  files = (data ?? [])
    .map((entry) => entry.name)
    .filter((name) => name && !name.startsWith("."));
  renderFiles();
};

const uploadFile = async (file) => {
  if (!file || !currentUser || isUploading) return;

  if (file.size > MAX_FILE_BYTES) {
    setFileStatus("File is too large (max 2 MB of text).", "error");
    return;
  }

  const fileName = sanitizeFileName(file.name);
  const path = `${currentUser.id}/${fileName}`;

  setUploading(true);
  setFileStatus(`Uploading ${fileName}...`, "busy");

  const { error: uploadError } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .upload(path, file, {
      upsert: true,
      contentType: file.type || "text/plain",
    });

  if (uploadError) {
    setUploading(false);
    setFileStatus(uploadError.message, "error");
    return;
  }

  setFileStatus(`Indexing ${fileName}...`, "busy");

  const { data, error } = await supabase.functions.invoke(EMBED_FUNCTION, {
    body: { fileName },
  });

  if (error || data?.error) {
    // The file is uploaded but indexing failed: roll back both the storage
    // object and any partial embeddings so the two stay consistent, then
    // surface the error.
    await supabase.storage.from(DOCUMENTS_BUCKET).remove([path]);
    await supabase
      .from("documents")
      .delete()
      .eq("user_id", currentUser.id)
      .eq("file_name", fileName);
    const errorMessage = await readFunctionErrorMessage(error, data);
    setUploading(false);
    setFileStatus(errorMessage, "error");
    return;
  }

  setUploading(false);
  setFileStatus(`Ready — "${fileName}" added to your context.`, "success");
  await loadFiles();
};

const deleteFile = async (name) => {
  if (!currentUser || isUploading) return;
  if (!window.confirm(`Delete "${name}" and its embeddings?`)) return;

  setUploading(true);
  setFileStatus(`Removing ${name}...`, "busy");

  const { error: storageError } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .remove([`${currentUser.id}/${name}`]);

  if (storageError) {
    setUploading(false);
    setFileStatus(storageError.message, "error");
    return;
  }

  const { error: dbError } = await supabase
    .from("documents")
    .delete()
    .eq("user_id", currentUser.id)
    .eq("file_name", name);

  setUploading(false);

  if (dbError) {
    setFileStatus(dbError.message, "error");
    return;
  }

  setFileStatus(`Removed "${name}".`, "neutral");
  await loadFiles();
};

const setSending = (value) => {
  isSending = value;
  if (sendButton) sendButton.disabled = value;
  if (sendButton) sendButton.textContent = value ? "Sending..." : "Send";
  if (composer) composer.dataset.waiting = String(value);
  setConnectionStatus(value ? "Thinking" : "Ready", value ? "busy" : "neutral");
  renderMessages();
};

const readFunctionErrorMessage = async (error, data) => {
  if (data?.error) return data.error;

  const message = error?.message ?? "The AI endpoint returned an error.";
  if (error?.context instanceof Response) {
    const status = error.context.status;

    try {
      const payload = await error.context.clone().json();
      if (payload?.error) return `Function error ${status}: ${payload.error}`;
    } catch {
      try {
        const text = await error.context.clone().text();
        if (text) return `Function error ${status}: ${text}`;
      } catch {
        return `Function returned HTTP ${status}. Check the Supabase Edge Function logs.`;
      }
    }
  }

  if (message.includes("Failed to send a request to the Edge Function")) {
    return `Could not reach the "${CHAT_FUNCTION}" Edge Function. Confirm PUBLIC_SUPABASE_CHAT_FUNCTION matches the deployed function name and that the function handles CORS OPTIONS requests.`;
  }

  return message;
};

const showSidebar = (show) => {
  sidebar?.classList.toggle("open", show);
  if (scrim) {
    scrim.hidden = !show;
  }
};

const setSidebarTab = (tab) => {
  sidebarTabs.forEach((button) => {
    const active = button.dataset.tab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  sidebarPanels.forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === tab);
  });
};

const closeViewer = () => {
  if (!fileViewer) return;
  fileViewer.hidden = true;
  if (fileViewerBody) fileViewerBody.innerHTML = "";
};

const viewFile = async (name) => {
  if (!currentUser || !fileViewer || !fileViewerBody) return;

  if (fileViewerTitle) fileViewerTitle.textContent = name;
  fileViewerBody.innerHTML = `<p class="modal-status">Loading…</p>`;
  fileViewer.hidden = false;

  const { data, error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .download(`${currentUser.id}/${name}`);

  if (error || !data) {
    fileViewerBody.innerHTML = `<p class="modal-status" data-tone="error">${escapeHtml(
      error?.message ?? "Could not load this file.",
    )}</p>`;
    return;
  }

  const text = await data.text();

  fileViewerBody.innerHTML = isMarkdownFile(name)
    ? renderMarkdown(text)
    : `<pre class="file-content-text">${escapeHtml(text)}</pre>`;
};

const loadChats = async () => {
  const { data, error } = await supabase
    .from("chats")
    .select("id, title, created_at")
    .order("created_at", { ascending: false });

  if (error) throw error;
  chats = data ?? [];
  renderChats();
  renderActiveTitle();
};

const loadMessages = async (chatId) => {
  activeChatId = chatId;
  renderChats();
  renderActiveTitle();
  setConnectionStatus("Loading", "busy");

  const { data, error } = await supabase
    .from("messages")
    .select("id, role, content, created_at")
    .eq("chat_id", chatId)
    // Secondary sort on role keeps a turn's "user" bubble above its "assistant"
    // reply even for legacy rows that share an identical created_at.
    .order("created_at", { ascending: true })
    .order("role", { ascending: false });

  if (error) throw error;
  messages = data ?? [];
  renderMessages();
  setConnectionStatus("Ready");
};

const startNewChat = () => {
  activeChatId = null;
  messages = [];
  renderChats();
  renderActiveTitle();
  renderMessages();
  setConnectionStatus("Ready");
  promptInput?.focus();
  showSidebar(false);
};

const initializeWorkspace = async (activeSession) => {
  session = activeSession;
  currentUser = activeSession.user;
  if (accountEmail) accountEmail.textContent = currentUser.email ?? "Authenticated user";
  setView("chat");
  setConnectionStatus("Loading", "busy");
  setFileStatus("");
  await loadChats();
  await loadFiles();
  startNewChat();
};

const handleAuth = async (event) => {
  event.preventDefault();
  if (!emailInput || !passwordInput || !authSubmit) return;

  authSubmit.disabled = true;
  setAuthStatus(authMode === "sign-in" ? "Signing in..." : "Creating account...", "busy");

  const email = emailInput.value.trim();
  const password = passwordInput.value;
  const authCall =
    authMode === "sign-in"
      ? supabase.auth.signInWithPassword({ email, password })
      : supabase.auth.signUp({ email, password });

  const { data, error } = await authCall;
  authSubmit.disabled = false;

  if (error) {
    setAuthStatus(error.message);
    return;
  }

  if (data.session) {
    setAuthStatus("");
    await initializeWorkspace(data.session);
    return;
  }

  const { data: signInData, error: signInError } =
    await supabase.auth.signInWithPassword({ email, password });

  if (signInError || !signInData.session) {
    setAuthStatus(signInError?.message ?? "Could not sign in. Please try again.");
    return;
  }

  setAuthStatus("");
  await initializeWorkspace(signInData.session);
};

const sendPrompt = async (event) => {
  event.preventDefault();
  if (!promptInput || !session || isSending) return;

  const prompt = promptInput.value.trim();
  if (!prompt) return;

  const pendingChatId = activeChatId;
  promptInput.value = "";
  promptInput.style.height = "auto";
  messages = [...messages, { role: "user", content: prompt }];
  setSending(true);

  const { data, error } = await supabase.functions.invoke(CHAT_FUNCTION, {
    body: { prompt, chatId: pendingChatId },
  });

  if (error || data?.error) {
    const errorMessage = await readFunctionErrorMessage(error, data);
    messages = [
      ...messages,
      {
        role: "assistant",
        content: errorMessage,
      },
    ];
    setSending(false);
    setConnectionStatus("Error", "error");
    return;
  }

  activeChatId = data.chatId;
  messages = [...messages, { role: "assistant", content: data.content }];
  setSending(false);
  await loadChats();
  renderChats();
  renderActiveTitle();
};

const signOut = async () => {
  await supabase.auth.signOut();
  session = null;
  currentUser = null;
  chats = [];
  activeChatId = null;
  messages = [];
  files = [];
  closeViewer();
  setSidebarTab("chats");
  renderMessages();
  renderFiles();
  setFileStatus("");
  setView("auth");
};

const init = async () => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    setView("config");
    return;
  }

  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  const {
    data: { session: existingSession },
  } = await supabase.auth.getSession();

  if (existingSession) {
    await initializeWorkspace(existingSession);
  } else {
    setView("auth");
  }
};

authForm?.addEventListener("submit", handleAuth);
authToggle?.addEventListener("click", () => {
  authMode = authMode === "sign-in" ? "sign-up" : "sign-in";
  updateAuthMode();
});
newChatButton?.addEventListener("click", startNewChat);
signOutButton?.addEventListener("click", signOut);
fileInput?.addEventListener("change", async (event) => {
  const target = event.target;
  const file = target instanceof HTMLInputElement ? target.files?.[0] : null;
  if (file) {
    try {
      await uploadFile(file);
    } catch (error) {
      setUploading(false);
      setFileStatus(error instanceof Error ? error.message : "Upload failed", "error");
    }
  }
  if (target instanceof HTMLInputElement) target.value = "";
});
fileList?.addEventListener("click", async (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  const viewButton = target.closest("[data-file-view]");
  if (viewButton instanceof HTMLElement) {
    const name = viewButton.dataset.fileView;
    if (name) await viewFile(name);
    return;
  }

  const removeButton = target.closest("[data-file-name]");
  if (!(removeButton instanceof HTMLButtonElement)) return;
  const name = removeButton.dataset.fileName;
  if (!name) return;

  try {
    await deleteFile(name);
  } catch (error) {
    setUploading(false);
    setFileStatus(error instanceof Error ? error.message : "Could not delete file", "error");
  }
});
sidebarTabs.forEach((button) => {
  button.addEventListener("click", () => {
    if (button.dataset.tab) setSidebarTab(button.dataset.tab);
  });
});
closeFileViewer?.addEventListener("click", closeViewer);
fileViewer?.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest("[data-close-viewer]")) {
    closeViewer();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (fileViewer && !fileViewer.hidden) {
    closeViewer();
  } else if (sidebar?.classList.contains("open")) {
    showSidebar(false);
  }
});
composer?.addEventListener("submit", sendPrompt);
chatList?.addEventListener("click", async (event) => {
  const button = event.target instanceof Element ? event.target.closest("[data-chat-id]") : null;
  if (!(button instanceof HTMLButtonElement)) return;
  const chatId = button.dataset.chatId;
  if (!chatId || chatId === activeChatId) return;

  try {
    await loadMessages(chatId);
    showSidebar(false);
  } catch (error) {
    setConnectionStatus(error instanceof Error ? error.message : "Could not load chat", "error");
  }
});
promptInput?.addEventListener("input", () => {
  promptInput.style.height = "auto";
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 180)}px`;
});
promptInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    composer?.requestSubmit();
  }
});
openSidebar?.addEventListener("click", () => showSidebar(true));
closeSidebar?.addEventListener("click", () => showSidebar(false));
scrim?.addEventListener("click", () => showSidebar(false));

updateAuthMode();
init().catch((error) => {
  setView("auth");
  setAuthStatus(error instanceof Error ? error.message : "Unable to initialize app.");
});

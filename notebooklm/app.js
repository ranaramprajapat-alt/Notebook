(function () {
  "use strict";

  var API_BASE = "/api";
  var MAX_NOTEBOOK_BYTES = 1024 * 1024 * 1024;
  var MAX_TEXT_BYTES = 2 * 1024 * 1024;
  var MAX_PREVIEW_CHARS = 3000;
  var LOCAL_STATE_KEY = "smart_notebook_state_v1";

  var state = {
    notebooks: [],
    ui: {
      tab: "notebooks",
      sort: "recent",
      activeNotebookId: null,
      selectedSourceId: null,
      rightPane: "studio"
    }
  };
  var speechState = {
    currentMessageIndex: null
  };
  var runtime = {
    backendAvailable: true
  };

  function q(id) {
    return document.getElementById(id);
  }

  function supportsSpeech() {
    return typeof window !== "undefined"
      && "speechSynthesis" in window
      && typeof window.SpeechSynthesisUtterance === "function";
  }

  function stopSpeaking() {
    if (!supportsSpeech()) return;
    window.speechSynthesis.cancel();
    speechState.currentMessageIndex = null;
  }

  function speakMessage(text, messageIndex) {
    if (!supportsSpeech()) {
      toast("Voice is not supported in this browser.");
      return;
    }

    var content = safeText(text).trim();
    if (!content) return;

    if (speechState.currentMessageIndex === messageIndex && window.speechSynthesis.speaking) {
      stopSpeaking();
      renderWorkspace();
      return;
    }

    stopSpeaking();
    var utterance = new window.SpeechSynthesisUtterance(content);
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.onend = function () {
      speechState.currentMessageIndex = null;
      renderWorkspace();
    };
    utterance.onerror = function () {
      speechState.currentMessageIndex = null;
      toast("Unable to play voice explanation.");
      renderWorkspace();
    };

    speechState.currentMessageIndex = messageIndex;
    window.speechSynthesis.speak(utterance);
    renderWorkspace();
  }

  function uid() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return "id_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
  }

  function safeText(value) {
    return String(value || "");
  }

  function supportsLocalState() {
    return typeof window !== "undefined" && !!window.localStorage;
  }

  function loadLocalState() {
    if (!supportsLocalState()) return null;
    try {
      var raw = window.localStorage.getItem(LOCAL_STATE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  function saveLocalState(payload) {
    if (!supportsLocalState()) return;
    try {
      window.localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(payload || {}));
    } catch (e) {
      /* Ignore quota/security errors in preview environments. */
    }
  }

  function escapeHtml(value) {
    return safeText(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function normalizeToolCall(value) {
    if (!value || typeof value !== "object") return null;
    var name = safeText(value.name || value.tool).trim();
    var targetUrl = safeText(value.target_url || value.url).trim();
    if (!name || !targetUrl) return null;
    return { name: name, targetUrl: targetUrl };
  }

  function renderAssistantText(text) {
    var lines = safeText(text).replace(/\r/g, "").split("\n");
    var headingSet = {
      "structured answer": "section-structured",
      "question": "section-question",
      "key points": "section-points",
      "source mapping": "section-sources",
      "quiz (mcq)": "section-quiz",
      "answer key": "section-answer-key",
      "q&a sheet": "section-qa",
      "flash cards": "section-flash",
      "study guide": "section-study",
      "faq": "section-faq",
      "timeline": "section-timeline",
      "executive briefing": "section-brief",
      "key findings": "section-points",
      "risks and unknowns": "section-risks",
      "suggested next steps": "section-next",
      "self-test questions": "section-quiz",
      "core concepts": "section-points",
      "key explanations": "section-points"
    };

    var parts = [];
    var activeSection = "";

    lines.forEach(function (raw) {
      var line = safeText(raw);
      var trimmed = line.trim();
      if (!trimmed) {
        parts.push("<div class='msg-gap'></div>");
        return;
      }

      var key = trimmed.toLowerCase();
      if (headingSet[key]) {
        activeSection = key;
        parts.push("<div class='msg-heading " + headingSet[key] + "'>" + escapeHtml(trimmed) + "</div>");
        return;
      }

      var m = trimmed.match(/^([0-9]+)\.\s+(.+)$/);
      if (m) {
        parts.push("<div class='msg-numbered'><span class='msg-num'>" + escapeHtml(m[1]) + ".</span><span>" + escapeHtml(m[2]) + "</span></div>");
        return;
      }

      m = trimmed.match(/^([A-D])\.\s+(.+)$/);
      if (m) {
        parts.push("<div class='msg-option'><span class='msg-opt'>" + escapeHtml(m[1]) + ".</span><span>" + escapeHtml(m[2]) + "</span></div>");
        return;
      }

      m = trimmed.match(/^(Q[0-9]+)\.\s+(.+)$/);
      if (m) {
        parts.push("<div class='msg-qa msg-qa-q'><strong>" + escapeHtml(m[1]) + ".</strong> " + escapeHtml(m[2]) + "</div>");
        return;
      }

      m = trimmed.match(/^(A[0-9]+)\.\s+(.+)$/);
      if (m) {
        parts.push("<div class='msg-qa msg-qa-a'><strong>" + escapeHtml(m[1]) + ".</strong> " + escapeHtml(m[2]) + "</div>");
        return;
      }

      m = trimmed.match(/^-+\s+(.+)$/);
      if (m) {
        var cls = activeSection === "question" ? "msg-question-line" : "msg-bullet";
        parts.push("<div class='" + cls + "'>• " + escapeHtml(m[1]) + "</div>");
        return;
      }

      parts.push("<div class='msg-paragraph'>" + escapeHtml(trimmed) + "</div>");
    });

    return parts.join("");
  }

  function parseToolIntent(question) {
    var text = safeText(question).trim();
    if (!text) return null;
    var lower = text.toLowerCase();

    if (lower.indexOf("/youtube ") === 0) {
      var yq = text.slice(9).trim();
      return yq ? { tool: "youtube", query: yq } : null;
    }
    if (lower.indexOf("/browser ") === 0) {
      var bq = text.slice(9).trim();
      return bq ? { tool: "browser", query: bq } : null;
    }
    if (lower.indexOf("/search ") === 0) {
      var sq = text.slice(8).trim();
      return sq ? { tool: "browser", query: sq } : null;
    }
    if (lower.indexOf("/open ") === 0) {
      var ou = text.slice(6).trim();
      return ou ? { tool: "open", url: ou } : null;
    }

    var m = text.match(/^(?:search|find|look up)\s+(?:on\s+)?youtube\s+(?:for\s+)?(.+)$/i);
    if (m && m[1]) return { tool: "youtube", query: m[1].trim() };

    m = text.match(/^(?:search|browse|google|look up|find)\s+(?:for\s+)?(.+)$/i);
    if (m && m[1]) return { tool: "browser", query: m[1].trim() };

    m = text.match(/^open\s+(.+)$/i);
    if (m && m[1]) return { tool: "open", url: m[1].trim() };
    return null;
  }

  function normalizeUrl(value) {
    var raw = safeText(value).trim();
    if (!raw) return "";
    var candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : ("https://" + raw);
    try {
      var parsed = new URL(candidate);
      if (!parsed.hostname) return "";
      return parsed.toString();
    } catch (e) {
      return "";
    }
  }

  function runToolIntent(intent) {
    if (!intent || !intent.tool) return null;
    if (intent.tool === "youtube") {
      var yq = safeText(intent.query).trim();
      if (!yq) return null;
      var yUrl = "https://www.youtube.com/results?search_query=" + encodeURIComponent(yq);
      return {
        text: "Tool call: YouTube search for \"" + yq + "\".\nOpen this link: " + yUrl,
        citations: ["Tool: YouTube"],
        tool_call: { name: "youtube", target_url: yUrl }
      };
    }
    if (intent.tool === "browser") {
      var bq = safeText(intent.query).trim();
      if (!bq) return null;
      var bUrl = "https://www.google.com/search?q=" + encodeURIComponent(bq);
      return {
        text: "Tool call: Browser search for \"" + bq + "\".\nOpen this link: " + bUrl,
        citations: ["Tool: Browser"],
        tool_call: { name: "browser", target_url: bUrl }
      };
    }
    if (intent.tool === "open") {
      var openUrl = normalizeUrl(intent.url);
      if (!openUrl) {
        return {
          text: "Tool call failed: invalid URL. Use `open example.com` or `/open https://example.com`.",
          citations: ["Tool: Open URL"]
        };
      }
      return {
        text: "Tool call: Open URL.\nOpen this link: " + openUrl,
        citations: ["Tool: Open URL"],
        tool_call: { name: "open_url", target_url: openUrl }
      };
    }
    return null;
  }

  async function apiRequest(path, method, body, timeoutMs) {
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var options = {
      method: method || "GET",
      headers: { "Content-Type": "application/json" }
    };

    if (controller) {
      options.signal = controller.signal;
    }

    if (body !== undefined) options.body = JSON.stringify(body);

    var timer = null;
    if (controller) {
      timer = setTimeout(function () {
        controller.abort();
      }, Number(timeoutMs || 12000));
    }

    var request = fetch(API_BASE + path, options);
    if (!controller) {
      var fallbackTimeout = Number(timeoutMs || 12000);
      var fallbackTimer = null;
      request = Promise.race([
        request,
        new Promise(function (_, reject) {
          fallbackTimer = setTimeout(function () {
            reject(new Error("API request timed out"));
          }, fallbackTimeout);
        })
      ]).finally(function () {
        if (fallbackTimer) clearTimeout(fallbackTimer);
      });
    }

    try {
      var res = await request;
      if (!res.ok) throw new Error("API request failed: " + res.status);
      if (res.status === 204) return null;
      return res.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function formatBytes(bytes) {
    var b = Number(bytes || 0);
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
    return (b / (1024 * 1024)).toFixed(2) + " MB";
  }

  function relTime(ts) {
    var delta = Math.max(1, Math.floor((Date.now() - Number(ts || Date.now())) / 1000));
    if (delta < 60) return delta + "s ago";
    if (delta < 3600) return Math.floor(delta / 60) + "m ago";
    if (delta < 86400) return Math.floor(delta / 3600) + "h ago";
    return Math.floor(delta / 86400) + "d ago";
  }

  function defaults() {
    var base = [
      ["Physics Research", "Theoretical physics notes and particle interaction summaries.", "science"],
      ["Marketing Strategy", "Q3 growth plans, competitor analysis, and campaign docs.", "trending_up"],
      ["Novel Draft", "Character arcs, chapter drafts, and scene ideas.", "edit_note"],
      ["Recipe Collection", "Curated recipes and nutritional comparisons.", "restaurant"]
    ];
    return base.map(function (x, i) {
      return {
        id: uid(),
        title: x[0],
        description: x[1],
        icon: x[2],
        createdAt: Date.now() - (i + 1) * 1000000,
        updatedAt: Date.now() - (i + 1) * 1000000,
        trashedAt: null,
        sources: [],
        messages: [],
        notes: "",
        studio: {
          title: "Studio output",
          text: "Generate grounded artifacts from uploaded sources.",
          citations: []
        }
      };
    });
  }

  function migrate(input) {
    var data = input && typeof input === "object" ? input : {};
    var notebooks = Array.isArray(data.notebooks) ? data.notebooks : [];

    var migrated = notebooks.map(function (n) {
      var nn = n || {};
      var studio = nn.studio && typeof nn.studio === "object" ? nn.studio : {};
      return {
        id: safeText(nn.id) || uid(),
        title: safeText(nn.title) || "Untitled Notebook",
        description: safeText(nn.description || nn.desc) || "No description yet.",
        icon: safeText(nn.icon) || "book_2",
        createdAt: Number(nn.createdAt) || Date.now(),
        updatedAt: Number(nn.updatedAt) || Date.now(),
        trashedAt: nn.trashedAt ? Number(nn.trashedAt) : null,
        sources: Array.isArray(nn.sources) ? nn.sources.map(function (s) {
          var ss = s || {};
          var textValue = safeText(ss.text);
          return {
            id: safeText(ss.id) || uid(),
            name: safeText(ss.name) || "untitled",
            kind: safeText(ss.kind) || "file",
            size: Number(ss.size) || 0,
            text: textValue,
            base64: safeText(ss.base64),
            preview: safeText(ss.preview),
            extractable: typeof ss.extractable === "boolean" ? ss.extractable : !!textValue.trim() || !!ss.base64,
            createdAt: Number(ss.createdAt) || Date.now()
          };
        }) : [],
        messages: Array.isArray(nn.messages) ? nn.messages.map(function (m) {
          var mm = m || {};
          return {
            role: mm.role === "assistant" ? "assistant" : "user",
            text: safeText(mm.text),
            citations: Array.isArray(mm.citations) ? mm.citations.map(safeText) : [],
            toolCall: normalizeToolCall(mm.toolCall || mm.tool_call),
            createdAt: Number(mm.createdAt) || Date.now()
          };
        }) : [],
        notes: safeText(nn.notes),
        studio: {
          title: safeText(studio.title) || "Studio output",
          text: safeText(studio.text) || "Generate grounded artifacts from uploaded sources.",
          citations: Array.isArray(studio.citations) ? studio.citations.map(safeText) : []
        }
      };
    });

    if (!migrated.length) migrated = defaults();

    return {
      notebooks: migrated,
      ui: {
        tab: "notebooks",
        sort: "recent",
        activeNotebookId: null,
        selectedSourceId: null,
        rightPane: "studio"
      }
    };
  }

  function load() {
    return apiRequest("/state", "GET", undefined, 1500)
      .then(function (payload) {
        runtime.backendAvailable = true;
        state = migrate(payload || {});
      })
      .catch(function () {
        runtime.backendAvailable = false;
        var localPayload = loadLocalState();
        if (localPayload) {
          state = migrate(localPayload);
          return null;
        }
        state = migrate({ notebooks: defaults() });
        saveLocalState({ notebooks: state.notebooks });
        return null;
      });
  }

  function save() {
    if (!runtime.backendAvailable) {
      saveLocalState({ notebooks: state.notebooks });
      return Promise.resolve();
    }
    return apiRequest("/state", "PUT", { notebooks: state.notebooks })
      .catch(function () {
        runtime.backendAvailable = false;
        saveLocalState({ notebooks: state.notebooks });
      });
  }

  function byId(id) {
    return state.notebooks.find(function (n) { return n.id === id; }) || null;
  }

  function activeNotebook() {
    var n = byId(state.ui.activeNotebookId);
    return n && !n.trashedAt ? n : null;
  }

  function totalNotebookBytes(notebook) {
    return notebook.sources.reduce(function (sum, s) { return sum + Number(s.size || 0); }, 0);
  }

  function routeState() {
    return {
      __app: "smart-notebook-ai",
      tab: state.ui.tab,
      activeNotebookId: state.ui.activeNotebookId || null
    };
  }

  function syncRouteHistory(replace) {
    if (!window.history || typeof window.history.pushState !== "function") return;
    var entry = routeState();
    if (replace && typeof window.history.replaceState === "function") {
      window.history.replaceState(entry, "");
      return;
    }
    window.history.pushState(entry, "");
  }

  function setTab(name, options) {
    var opts = options || {};
    if (name !== "workspace") stopSpeaking();
    state.ui.tab = name;
    ["notebooks", "shared", "trash", "workspace"].forEach(function (v) {
      q("view-" + v).classList.toggle("hidden", v !== name);
    });
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (tab) {
      tab.classList.toggle("active", tab.dataset.tab === name);
    });
    q("mobileHomeBtn").classList.toggle("hidden", name !== "workspace");
    render();
    if (!opts.skipHistory) syncRouteHistory(false);
  }

  function setRightPane(name) {
    state.ui.rightPane = name;
    q("rightPaneStudio").classList.toggle("hidden", name !== "studio");
    q("rightPaneNotes").classList.toggle("hidden", name !== "notes");
    q("rightPaneSource").classList.toggle("hidden", name !== "source");
    q("rightTabStudio").classList.toggle("active", name === "studio");
    q("rightTabNotes").classList.toggle("active", name === "notes");
    q("rightTabSource").classList.toggle("active", name === "source");
  }

  function openWorkspace(id) {
    stopSpeaking();
    var n = byId(id);
    if (!n || n.trashedAt) return;
    state.ui.activeNotebookId = n.id;
    state.ui.selectedSourceId = n.sources[0] ? n.sources[0].id : null;
    setRightPane("studio");
    setTab("workspace");
  }

  function applyHistoryRoute(entry) {
    var route = entry && entry.__app === "smart-notebook-ai" ? entry : null;
    var tab = route ? safeText(route.tab) : "notebooks";
    var notebookId = route ? safeText(route.activeNotebookId) : "";
    var plainTab = tab === "shared" || tab === "trash" || tab === "notebooks";

    if (tab === "workspace" && notebookId) {
      var n = byId(notebookId);
      if (n && !n.trashedAt) {
        state.ui.activeNotebookId = n.id;
        state.ui.selectedSourceId = n.sources[0] ? n.sources[0].id : null;
        setRightPane("studio");
        setTab("workspace", { skipHistory: true });
        return;
      }
    }

    if (plainTab) {
      setTab(tab, { skipHistory: true });
      return;
    }

    setTab("notebooks", { skipHistory: true });
  }

  function render() {
    renderNotebooks();
    renderTrash();
    renderWorkspace();
  }

  function notebookBannerClass(id) {
    var colors = ["#eef2ff", "#eff6ff", "#ecfdf3", "#fff7ed", "#f5f3ff", "#fff1f2"];
    return colors[Math.abs(hash(id)) % colors.length];
  }

  function hash(s) {
    var h = 0;
    for (var i = 0; i < s.length; i += 1) h = ((h << 5) - h) + s.charCodeAt(i);
    return h;
  }

  function renderNotebooks() {
    var grid = q("notebookGrid");
    var items = state.notebooks.filter(function (n) { return !n.trashedAt; });

    if (state.ui.sort === "title") items.sort(function (a, b) { return a.title.localeCompare(b.title); });
    else items.sort(function (a, b) { return b.updatedAt - a.updatedAt; });

    var html = items.map(function (n) {
      return [
        "<article class='card notebook'>",
        "<div class='notebook-banner' style='background:", notebookBannerClass(n.id), "'><span class='material-symbols-outlined'>", escapeHtml(n.icon), "</span></div>",
        "<div class='notebook-body'>",
        "<div class='notebook-head'><h3>", escapeHtml(n.title), "</h3>",
        "<button class='icon-btn' data-trash-notebook='", n.id, "' title='Move to trash'><span class='material-symbols-outlined'>delete</span></button></div>",
        "<p>", escapeHtml(n.description), "</p>",
        "<div class='notebook-meta'><span>", n.sources.length, " documents</span><span>Updated ", relTime(n.updatedAt), "</span></div>",
        "<button class='btn btn-ghost full' data-open-notebook='", n.id, "'>Open Notebook</button>",
        "</div></article>"
      ].join("");
    }).join("");

    html += "<article class='card notebook'><div class='notebook-body' style='padding-top:20px;display:grid;place-items:center;min-height:220px;'><button id='createTile' class='btn btn-outline'>+ Create New Notebook</button></div></article>";

    grid.innerHTML = html;

    Array.prototype.forEach.call(document.querySelectorAll("[data-open-notebook]"), function (btn) {
      btn.addEventListener("click", function () { openWorkspace(btn.getAttribute("data-open-notebook")); });
    });

    Array.prototype.forEach.call(document.querySelectorAll("[data-trash-notebook]"), function (btn) {
      btn.addEventListener("click", function () { moveNotebookToTrash(btn.getAttribute("data-trash-notebook")); });
    });

    if (q("createTile")) q("createTile").addEventListener("click", openCreateModal);
  }

  function renderTrash() {
    var wrap = q("trashList");
    var items = state.notebooks.filter(function (n) { return !!n.trashedAt; }).sort(function (a, b) {
      return Number(b.trashedAt || 0) - Number(a.trashedAt || 0);
    });

    if (!items.length) {
      wrap.innerHTML = "<article class='card' style='padding:18px;color:#667085;'>Trash is empty.</article>";
      return;
    }

    wrap.innerHTML = items.map(function (n) {
      return [
        "<article class='card' style='padding:12px;display:flex;justify-content:space-between;align-items:center;gap:8px;'>",
        "<div><strong>", escapeHtml(n.title), "</strong><div class='muted' style='font-size:12px;'>Deleted ", relTime(n.trashedAt), "</div></div>",
        "<div style='display:flex;gap:8px;'>",
        "<button class='btn btn-ghost small' data-restore='", n.id, "'>Restore</button>",
        "<button class='btn small' style='background:#ffe4e6;color:#be123c;' data-delete='", n.id, "'>Delete Permanently</button>",
        "</div></article>"
      ].join("");
    }).join("");

    Array.prototype.forEach.call(document.querySelectorAll("[data-restore]"), function (btn) {
      btn.addEventListener("click", function () {
        var n = byId(btn.getAttribute("data-restore"));
        if (!n) return;
        n.trashedAt = null;
        n.updatedAt = Date.now();
        save();
        render();
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll("[data-delete]"), function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-delete");
        state.notebooks = state.notebooks.filter(function (n) { return n.id !== id; });
        save();
        render();
      });
    });
  }

  function renderWorkspace() {
    var n = activeNotebook();
    if (!n) {
      q("workspaceTitle").textContent = "Ask Questions";
      q("sourceList").innerHTML = "<p class='muted' style='padding:10px;'>Open a notebook first.</p>";
      q("messageList").innerHTML = "";
      q("viewerName").textContent = "No source selected";
      q("viewerMeta").textContent = "Upload or select a source from the left panel.";
      q("viewerText").textContent = "";
      q("suggestedChips").innerHTML = "";
      q("storageProgress").style.width = "0%";
      q("storageLabel").textContent = "0 MB of 1.0 GB used";
      q("notebookNotes").value = "";
      q("studioTitle").textContent = "Studio output";
      q("studioMeta").textContent = "Generate grounded artifacts from uploaded sources.";
      q("studioOutput").textContent = "";
      q("studioCitations").innerHTML = "";
      return;
    }

    q("workspaceTitle").textContent = n.title;
    q("notebookNotes").value = n.notes || "";

    renderSources(n);
    renderMessages(n);
    renderViewer(n);
    renderChips(n);
    renderStudio(n);

    var used = totalNotebookBytes(n);
    var pct = Math.min(100, (used / MAX_NOTEBOOK_BYTES) * 100);
    q("storageProgress").style.width = pct.toFixed(2) + "%";
    q("storageLabel").textContent = formatBytes(used) + " of 1.0 GB used";
  }

  function renderStudio(n) {
    var studio = n.studio || { title: "Studio output", text: "", citations: [] };
    q("studioTitle").textContent = studio.title || "Studio output";
    q("studioMeta").textContent = "Grounded to uploaded notebook sources.";
    q("studioOutput").textContent = studio.text || "Generate grounded artifacts from uploaded sources.";
    var cites = Array.isArray(studio.citations) ? studio.citations : [];
    q("studioCitations").innerHTML = cites.map(function (c) {
      return "<span class='citation'>" + escapeHtml(c) + "</span>";
    }).join("");
  }

  function renderSources(n) {
    var list = q("sourceList");
    if (!n.sources.length) {
      list.innerHTML = "<p class='muted' style='padding:10px;'>No sources yet. Add one to start asking.</p>";
      return;
    }

    list.innerHTML = n.sources.map(function (s) {
      var active = s.id === state.ui.selectedSourceId;
      var tag = s.extractable ? escapeHtml((s.kind || "file").toUpperCase()) : "UNSUPPORTED";
      return [
        "<article class='source-item", active ? " active" : "", "' data-select-source='", s.id, "'>",
        "<div class='source-title'>", escapeHtml(s.name), "</div>",
        "<div class='source-meta'><span>", formatBytes(s.size), "</span><span>", tag, "</span></div>",
        "<div class='source-actions'><button class='icon-btn' data-remove-source='", s.id, "' title='Delete source'><span class='material-symbols-outlined'>delete</span></button></div>",
        "</article>"
      ].join("");
    }).join("");

    Array.prototype.forEach.call(document.querySelectorAll("[data-select-source]"), function (node) {
      node.addEventListener("click", function (e) {
        if (e.target.closest("[data-remove-source]")) return;
        state.ui.selectedSourceId = node.getAttribute("data-select-source");
        renderViewer(n);
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll("[data-remove-source]"), function (btn) {
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        var id = btn.getAttribute("data-remove-source");
        n.sources = n.sources.filter(function (s) { return s.id !== id; });
        if (state.ui.selectedSourceId === id) state.ui.selectedSourceId = n.sources[0] ? n.sources[0].id : null;
        n.updatedAt = Date.now();
        save();
        renderWorkspace();
      });
    });
  }

  function renderViewer(n) {
    var src = n.sources.find(function (s) { return s.id === state.ui.selectedSourceId; }) || null;
    if (!src) {
      q("viewerName").textContent = "No source selected";
      q("viewerMeta").textContent = "Upload or select a source from the left panel.";
      q("viewerText").textContent = "";
      return;
    }

    q("viewerName").textContent = src.name;
    q("viewerMeta").textContent = (src.kind || "file").toUpperCase() + " • " + formatBytes(src.size) + " • uploaded " + relTime(src.createdAt);
    if (!src.extractable) {
      q("viewerText").textContent = src.preview || "This file is stored but cannot be used for grounded Q&A in this local build. Use text files or add PDF/DOCX extraction.";
      return;
    }
    q("viewerText").textContent = src.preview || "No text preview available for this file type.";
  }

  function renderMessages(n) {
    var wrap = q("messageList");
    if (!n.messages.length) {
      wrap.innerHTML = "<article class='msg assistant'><strong>Start asking questions</strong><div class='muted' style='margin-top:6px;'>Upload sources and ask grounded questions. Use Studio on the right for briefing docs, FAQ, timelines, study guides, flash cards, quizzes, and Q&A sheets.</div></article>";
      return;
    }

    wrap.innerHTML = n.messages.map(function (m, idx) {
      var cite = "";
      if (Array.isArray(m.citations) && m.citations.length) {
        cite = "<div>" + m.citations.map(function (c) {
          return "<span class='citation'>" + escapeHtml(c) + "</span>";
        }).join("") + "</div>";
      }

      var tools = [];
      if (m.role === "assistant" && m.toolCall && safeText(m.toolCall.targetUrl).trim()) {
        tools.push(
          "<button class='icon-btn msg-tool-btn msg-open-btn' data-open-tool-url='"
          + escapeHtml(m.toolCall.targetUrl)
          + "' title='Open "
          + escapeHtml(m.toolCall.name || "tool")
          + "'><span class='material-symbols-outlined'>open_in_new</span></button>"
        );
      }
      if (m.role === "assistant" && safeText(m.text).trim()) {
        var isActive = supportsSpeech()
          && speechState.currentMessageIndex === idx
          && window.speechSynthesis.speaking;
        var icon = isActive ? "stop_circle" : "volume_up";
        var title = isActive ? "Stop voice" : "Voice explanation";
        tools.push("<button class='icon-btn msg-tool-btn msg-voice-btn' data-speak-message='" + idx + "' title='" + title + "'><span class='material-symbols-outlined'>" + icon + "</span></button>");
      }

      var toolbar = tools.length ? ("<div class='msg-tools'>" + tools.join("") + "</div>") : "";
      var body = m.role === "assistant"
        ? renderAssistantText(m.text)
        : escapeHtml(m.text).replace(/\n/g, "<br>");
      return "<article class='msg " + m.role + "'>" + body + cite + toolbar + "</article>";
    }).join("");

    Array.prototype.forEach.call(wrap.querySelectorAll("[data-open-tool-url]"), function (btn) {
      btn.addEventListener("click", function () {
        var targetUrl = btn.getAttribute("data-open-tool-url");
        if (!targetUrl) return;
        window.open(targetUrl, "_blank", "noopener,noreferrer");
      });
    });

    Array.prototype.forEach.call(wrap.querySelectorAll("[data-speak-message]"), function (btn) {
      btn.addEventListener("click", function () {
        var i = Number(btn.getAttribute("data-speak-message"));
        if (!Number.isFinite(i) || !n.messages[i]) return;
        speakMessage(n.messages[i].text, i);
      });
    });

    wrap.scrollTop = wrap.scrollHeight;
  }

  function renderChips(n) {
    var chips = q("suggestedChips");
    var items = n.sources.length
      ? ["Summarize the core thesis", "What are the key risks?", "Extract concrete dates", "List open questions"]
      : ["Upload a source first", "Then ask: summarize this notebook"];

    chips.innerHTML = items.map(function (text) {
      return "<button class='chip' data-chip='" + escapeHtml(text) + "'>" + escapeHtml(text) + "</button>";
    }).join("");

    Array.prototype.forEach.call(chips.querySelectorAll("[data-chip]"), function (btn) {
      btn.addEventListener("click", function () {
        q("chatInput").value = btn.getAttribute("data-chip") || "";
        q("chatInput").focus();
      });
    });
  }

  function moveNotebookToTrash(id) {
    var n = byId(id);
    if (!n || n.trashedAt) return;
    n.trashedAt = Date.now();
    n.updatedAt = Date.now();
    if (state.ui.activeNotebookId === id) {
      state.ui.activeNotebookId = null;
      state.ui.selectedSourceId = null;
      setTab("notebooks");
    }
    save();
    render();
  }

  function openCreateModal() {
    q("createModal").classList.remove("hidden");
    q("nameInput").focus();
  }

  function closeCreateModal() {
    q("createModal").classList.add("hidden");
    q("createForm").reset();
  }

  function openUploadModal() {
    if (!activeNotebook()) {
      toast("Open a notebook first.");
      return;
    }
    q("uploadModal").classList.remove("hidden");
  }

  function closeUploadModal() {
    q("uploadModal").classList.add("hidden");
    q("fileInput").value = "";
  }

  function setUploadStatus(percent, text, meta) {
    q("uploadPercent").textContent = percent + "%";
    q("uploadProgress").style.width = percent + "%";
    q("uploadStatusText").textContent = text;
    q("uploadMeta").textContent = meta;
  }

  function parseFile(file) {
    return new Promise(function (resolve) {
      var ext = safeText(file.name.split(".").pop()).toLowerCase();
      var textExt = { txt: true, md: true, csv: true, json: true, log: true, html: true, xml: true, pdf: true, docx: true, pptx: true };

      if (!textExt[ext]) {
        resolve({
          kind: ext || "file",
          text: "",
          preview: "Unsupported file type for text extraction in browser mode.",
          extractable: false
        });
        return;
      }

      if (file.size > MAX_TEXT_BYTES) {
        resolve({
          kind: ext,
          text: "",
          preview: "File too large for text extraction in local mode (2 MB limit per file).",
          extractable: false
        });
        return;
      }

      var reader = new FileReader();
      reader.onload = function () {
        var base64Data = ext === 'pdf' || ext === 'docx' || ext === 'pptx' ? reader.result.split(',')[1] : null;
        var text = base64Data ? '' : safeText(reader.result);
        resolve({
          kind: ext,
          text: text,
          preview: text ? text.slice(0, MAX_PREVIEW_CHARS) : "Preview not available. Extracted on server.",
          extractable: true,
          base64: base64Data
        });
      };
      reader.onerror = function () {
        resolve({ kind: ext, text: "", preview: "Could not read this file.", extractable: false });
      };

      if (ext === 'pdf' || ext === 'docx' || ext === 'pptx') {
        reader.readAsDataURL(file);
      } else {
        reader.readAsText(file);
      }
    });
  }

  function answerQuestionLocal(question, sources) {
    var toolResponse = runToolIntent(parseToolIntent(question));
    if (toolResponse) return toolResponse;

    if (!sources.length) return { text: "No sources are uploaded yet. Add a text source and ask again.", citations: [] };

    var keywords = question.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(function (w) { return w.length > 2; });
    var scored = [];

    sources.forEach(function (src) {
      var corpus = safeText(src.text);
      if (!corpus.trim()) return;
      splitSentences(corpus).filter(function (s) { return s.trim().split(/\s+/).filter(Boolean).length >= 3; }).forEach(function (sentence) {
        var low = sentence.toLowerCase();
        var score = keywords.reduce(function (sum, k) { return sum + (low.indexOf(k) >= 0 ? 1 : 0); }, 0);
        if (score > 0) scored.push({ score: score, source: src.name, sentence: sentence.trim() });
      });
    });

    scored.sort(function (a, b) { return b.score - a.score; });
    var top = scored.slice(0, 4);
    if (!top.length) {
      var fallback = sources.find(function (s) { return safeText(s.text).trim().length > 0; });
      if (!fallback) return { text: "I could not extract readable text from current sources.", citations: [] };
      return { text: "I found no direct match in extracted text. Try a narrower question or upload more text-based sources.", citations: [] };
    }

    var sourceMap = {};
    var lines = ["Structured Answer", ""];
    if (safeText(question).trim()) {
      lines.push("Question");
      lines.push("- " + safeText(question).trim());
      lines.push("");
    }
    lines.push("Key Points");
    top.forEach(function (t, i) {
      var raw = safeText(t.sentence).trim();
      var first = splitSentences(raw)[0] || raw;
      var point = first.replace(/\s+/g, " ");
      if (point.length > 220) point = point.slice(0, 219).trim() + "…";
      lines.push((i + 1) + ". " + point);
      if (!sourceMap[t.source]) sourceMap[t.source] = [];
      sourceMap[t.source].push(String(i + 1));
    });
    var sourcesUsed = Object.keys(sourceMap);
    if (sourcesUsed.length) {
      lines.push("");
      lines.push("Source Mapping");
      sourcesUsed.forEach(function (s) {
        lines.push("- " + s + ": points " + sourceMap[s].join(", "));
      });
    }

    return {
      text: lines.join("\n"),
      citations: top.map(function (t) { return t.source; }).filter(function (v, i, arr) { return arr.indexOf(v) === i; })
    };
  }

  function splitSentences(text) {
    var cleaned = safeText(text).replace(/\r/g, "\n");
    var out = [];
    cleaned.split(/\n+/).forEach(function (line) {
      line.split(/[.!?]+/).forEach(function (part) {
        var s = part.trim();
        if (s) out.push(s);
      });
    });
    return out;
  }

  function generateStudioLocal(task, sources) {
    var all = [];
    sources.forEach(function (src) {
      splitSentences(src.text).forEach(function (s) {
        var sentence = safeText(s).trim().replace(/\s+/g, " ");
        if (sentence.length >= 20) all.push({ source: src.name, sentence: sentence });
      });
    });

    if (!all.length) {
      return {
        title: "Studio output",
        text: "No extractable text found in the current sources.",
        citations: []
      };
    }

    var top = all.slice(0, 8);
    var taskName = ({
      briefing: "Executive briefing",
      faq: "FAQ",
      timeline: "Timeline",
      study_guide: "Study guide",
      flash_cards: "Flash cards",
      quiz: "Quiz",
      qa_sheet: "Q&A sheet"
    })[task] || "Studio output";

    var lines = [taskName, "", "Key Points"];
    top.forEach(function (x, i) {
      lines.push((i + 1) + ". " + x.sentence);
    });

    if (task === "timeline") {
      var timeline = top.filter(function (x) { return /\b(19|20)\d{2}\b/.test(x.sentence); });
      if (timeline.length) {
        lines.push("");
        lines.push("Timeline");
        timeline.forEach(function (x) { lines.push("- " + x.sentence); });
      }
    }

    var citations = top.map(function (x) { return x.source; }).filter(function (v, i, arr) {
      return arr.indexOf(v) === i;
    });

    return {
      title: taskName,
      text: lines.join("\n"),
      citations: citations
    };
  }

  async function handleUploads(files) {
    var n = activeNotebook();
    if (!n) return;
    var items = Array.prototype.slice.call(files || []);
    if (!items.length) return;

    var accepted = [];
    var unsupported = 0;
    for (var i = 0; i < items.length; i += 1) {
      var file = items[i];
      setUploadStatus(Math.round((i / items.length) * 100), "Processing " + file.name + "...", (i + 1) + "/" + items.length);
      var parsed = await parseFile(file);
      if (!parsed.extractable) unsupported += 1;
      accepted.push({
        id: uid(),
        name: file.name,
        kind: parsed.kind,
        size: Number(file.size || 0),
        text: parsed.text,
        base64: parsed.base64,
        preview: parsed.preview,
        extractable: !!parsed.extractable,
        createdAt: Date.now()
      });
    }

    n.sources = accepted.concat(n.sources);
    n.updatedAt = Date.now();
    state.ui.selectedSourceId = n.sources[0] ? n.sources[0].id : null;

    save();
    renderWorkspace();
    setUploadStatus(100, accepted.length + " file(s) uploaded.", unsupported ? (unsupported + " file(s) are not extractable for Q&A") : "Done");
    toast(unsupported ? ("Upload complete. " + unsupported + " file(s) stored but not extractable.") : "Upload complete");
  }

  function ask() {
    var n = activeNotebook();
    if (!n) {
      toast("Open a notebook first.");
      return;
    }

    var input = q("chatInput");
    var text = safeText(input.value).trim();
    if (!text) return;

    n.messages.push({ role: "user", text: text, citations: [], toolCall: null, createdAt: Date.now() });
    var pending = { role: "assistant", text: "Thinking...", citations: [], toolCall: null, createdAt: Date.now() };
    n.messages.push(pending);
    input.value = "";
    renderWorkspace();

    var extractableSources = n.sources.filter(function (s) { return !!s.extractable && (safeText(s.text).trim().length > 0 || !!s.base64); });

    apiRequest("/answer", "POST", { question: text, sources: extractableSources }, 10000)
      .then(function (ans) {
        pending.text = safeText(ans && ans.text) || "No answer text returned.";
        pending.citations = Array.isArray(ans && ans.citations) ? ans.citations : [];
        pending.toolCall = normalizeToolCall(ans && ans.tool_call);
      })
      .catch(function () {
        var fallback = answerQuestionLocal(text, extractableSources);
        pending.text = fallback.text;
        pending.citations = fallback.citations;
        pending.toolCall = normalizeToolCall(fallback.tool_call || fallback.toolCall);
        toast("Backend unavailable. Used local answer.");
      })
      .finally(function () {
        n.updatedAt = Date.now();
        save();
        renderWorkspace();
        renderNotebooks();
      });
  }

  function generateStudio(task) {
    var n = activeNotebook();
    if (!n) {
      toast("Open a notebook first.");
      return;
    }
    var extractableSources = n.sources.filter(function (s) { return !!s.extractable && (safeText(s.text).trim().length > 0 || !!s.base64); });
    if (!extractableSources.length) {
      toast("Upload at least one extractable text source first.");
      return;
    }

    n.studio = {
      title: "Generating " + task + "...",
      text: "Working on grounded synthesis from your uploaded sources.",
      citations: []
    };
    setRightPane("studio");
    renderStudio(n);

    apiRequest("/studio", "POST", { task: task, sources: extractableSources })
      .then(function (out) {
        n.studio = {
          title: safeText(out && out.title) || "Studio output",
          text: safeText(out && out.text),
          citations: Array.isArray(out && out.citations) ? out.citations : []
        };
        n.updatedAt = Date.now();
        save();
        renderWorkspace();
      })
      .catch(function () {
        n.studio = generateStudioLocal(task, extractableSources);
        renderStudio(n);
        toast("Backend unavailable. Used local studio output.");
      });
  }

  function toast(message) {
    var node = q("toast");
    node.textContent = message;
    node.classList.remove("hidden");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () {
      node.classList.add("hidden");
    }, 2200);
  }

  function bindBaseEvents() {
    Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (tab) {
      tab.addEventListener("click", function () { setTab(tab.dataset.tab); });
    });

    q("rightTabStudio").addEventListener("click", function () { setRightPane("studio"); });
    q("rightTabNotes").addEventListener("click", function () { setRightPane("notes"); });
    q("rightTabSource").addEventListener("click", function () { setRightPane("source"); });

    q("generateBriefingBtn").addEventListener("click", function () { generateStudio("briefing"); });
    q("generateFaqBtn").addEventListener("click", function () { generateStudio("faq"); });
    q("generateTimelineBtn").addEventListener("click", function () { generateStudio("timeline"); });
    q("generateGuideBtn").addEventListener("click", function () { generateStudio("study_guide"); });
    q("generateFlashcardsBtn").addEventListener("click", function () { generateStudio("flash_cards"); });
    q("generateQuizBtn").addEventListener("click", function () { generateStudio("quiz"); });
    q("generateQABtn").addEventListener("click", function () { generateStudio("qa_sheet"); });

    q("createNotebookBtn").addEventListener("click", openCreateModal);
    q("sortRecentBtn").addEventListener("click", function () { state.ui.sort = "recent"; renderNotebooks(); });
    q("sortTitleBtn").addEventListener("click", function () { state.ui.sort = "title"; renderNotebooks(); });
    q("mobileHomeBtn").addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      var hist = window.history && window.history.state;
      if (hist && hist.__app === "smart-notebook-ai" && window.history.length > 1) {
        window.history.back();
        return;
      }
      setTab("notebooks");
    });
    window.addEventListener("popstate", function (e) {
      applyHistoryRoute(e.state);
    });

    q("notebookNotes").addEventListener("input", function (e) {
      var n = activeNotebook();
      if (!n) return;
      n.notes = safeText(e.target.value);
      n.updatedAt = Date.now();
      clearTimeout(bindBaseEvents._notesTimer);
      bindBaseEvents._notesTimer = setTimeout(function () { save(); renderNotebooks(); }, 300);
    });

    q("createForm").addEventListener("submit", function (e) {
      e.preventDefault();
      var title = safeText(q("nameInput").value).trim();
      if (!title) return;
      state.notebooks.unshift({
        id: uid(),
        title: title,
        description: safeText(q("descInput").value).trim() || "No description yet.",
        icon: safeText(q("iconInput").value) || "book_2",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        trashedAt: null,
        sources: [],
        messages: [],
        notes: "",
        studio: {
          title: "Studio output",
          text: "Generate grounded artifacts from uploaded sources.",
          citations: []
        }
      });
      save();
      closeCreateModal();
      renderNotebooks();
      toast("Notebook created");
    });

    Array.prototype.forEach.call(document.querySelectorAll("[data-close='create']"), function (btn) {
      btn.addEventListener("click", closeCreateModal);
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-close='upload']"), function (btn) {
      btn.addEventListener("click", closeUploadModal);
    });

    q("addSourceBtn").addEventListener("click", openUploadModal);
    q("addSourceWideBtn").addEventListener("click", openUploadModal);
    q("fileInput").addEventListener("change", function (e) {
      handleUploads(e.target.files);
      e.target.value = "";
    });

    var dropzone = document.querySelector(".dropzone");
    dropzone.addEventListener("dragover", function (e) {
      e.preventDefault();
      dropzone.style.borderColor = "#1c35f2";
    });
    dropzone.addEventListener("dragleave", function () {
      dropzone.style.borderColor = "#c6cedc";
    });
    dropzone.addEventListener("drop", function (e) {
      e.preventDefault();
      dropzone.style.borderColor = "#c6cedc";
      handleUploads(e.dataTransfer.files);
    });

    q("chatForm").addEventListener("submit", function (e) {
      e.preventDefault();
      ask();
    });

    q("moveNotebookToTrashBtn").addEventListener("click", function () {
      var n = activeNotebook();
      if (!n) return;
      moveNotebookToTrash(n.id);
      toast("Notebook moved to trash");
    });
  }

  function bootstrap() {
    load()
      .catch(function () {
        state = migrate({ notebooks: defaults() });
      })
      .finally(function () {
        bindBaseEvents();
        setRightPane("studio");
        setTab("notebooks", { skipHistory: true });
        syncRouteHistory(true);
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }
})();

import React, { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { BookOpen, Upload, X, Plus, Layers, BarChart3, Settings2, ChevronLeft, ChevronRight, RotateCcw, Check, Flame, Library, Trash2, Focus } from "lucide-react";

/* ============================================================
   CONFIG / LIBS LOADED FROM CDN (pdf.js + mammoth)
   ============================================================ */
const PDFJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const MAMMOTH_URL = "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js";

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

/* ============================================================
   SENTENCE SPLITTING — paragraph-aware, abbreviation-safe
   ============================================================ */
const ABBR = new Set([
  "mr","mrs","ms","dr","prof","sr","jr","st","vs","etc","e.g","i.e",
  "u.s","u.k","u.n","ph.d","b.a","m.a","inc","ltd","co","fig","no",
  "approx","dept","gov","jan","feb","mar","apr","jun","jul","aug",
  "sep","sept","oct","nov","dec"
]);

function splitSentences(paragraph) {
  // Tokenize on sentence enders, but check trailing context to avoid abbreviation cuts
  const raw = paragraph.match(/[^.!?]+[.!?]+(\s+(?=[A-Z"“(])|$)|[^.!?]+$/g) || [paragraph];
  const sentences = [];
  let buffer = "";
  for (let frag of raw) {
    buffer += frag;
    const trimmed = buffer.trim();
    const wordBeforeDot = trimmed.split(/\s+/).pop().replace(/[.!?]+$/, "").toLowerCase();
    const isAbbr = ABBR.has(wordBeforeDot) || /^[A-Z]$/.test(wordBeforeDot); // single initial like "J."
    if (!isAbbr || /[!?]$/.test(trimmed)) {
      sentences.push(trimmed);
      buffer = "";
    }
  }
  if (buffer.trim()) sentences.push(buffer.trim());
  return sentences.filter(s => s.length > 0);
}

function groupIntoBlocks(paragraphs, mode, n) {
  // paragraphs: array of raw paragraph strings
  // mode: 'paragraph' | 'sentences'
  const blocks = [];
  paragraphs.forEach((para, pIdx) => {
    const sents = splitSentences(para);
    if (sents.length === 0) return;
    if (mode === "paragraph") {
      blocks.push({ id: `p${pIdx}`, sentences: sents });
    } else {
      for (let i = 0; i < sents.length; i += n) {
        blocks.push({ id: `p${pIdx}-b${i}`, sentences: sents.slice(i, i + n) });
      }
    }
  });
  return blocks;
}

/* ============================================================
   FILE PARSING
   ============================================================ */
async function parsePdf(file) {
  await loadScript(PDFJS_URL);
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  const buf = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
  const paragraphs = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    let lineY = null;
    let currentLine = "";
    const lines = [];
    for (const item of content.items) {
      const y = item.transform[5];
      if (lineY === null || Math.abs(y - lineY) > 2) {
        if (currentLine.trim()) lines.push(currentLine.trim());
        currentLine = item.str;
        lineY = y;
      } else {
        currentLine += (currentLine.endsWith(" ") ? "" : " ") + item.str;
      }
    }
    if (currentLine.trim()) lines.push(currentLine.trim());
    // merge lines into paragraphs: blank-ish gaps or short lines ending mid-sentence get joined
    let para = "";
    for (const line of lines) {
      para += (para ? " " : "") + line;
      if (/[.!?]["')\]]?$/.test(line) && para.length > 40) {
        paragraphs.push(para);
        para = "";
      }
    }
    if (para.trim()) paragraphs.push(para);
  }
  return paragraphs.filter(p => p.trim().length > 0);
}

async function parseDocx(file) {
  await loadScript(MAMMOTH_URL);
  const buf = await file.arrayBuffer();
  const result = await window.mammoth.extractRawText({ arrayBuffer: buf });
  return result.value.split(/\n+/).map(s => s.trim()).filter(s => s.length > 0);
}

/* ============================================================
   TEXT-TO-SPEECH — Web Speech API (free, built into browser)
   ============================================================ */
function speak(text, lang = "en") {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  // Pick best available voice for the language
  const langCode = lang === "de" ? "de-DE" : "en-US";
  const voices = window.speechSynthesis.getVoices();
  const match = voices.find(v => v.lang.startsWith(langCode.slice(0, 2))) || null;
  if (match) utter.voice = match;
  utter.lang = langCode;
  utter.rate = 0.9;
  window.speechSynthesis.speak(utter);
}

/* ============================================================
   TRANSLATION API CALL
   Calls OUR OWN backend (/api/translate), which holds the real
   Gemini API key server-side. Never call the API
   directly from the browser — that would expose your key.
   ============================================================ */
async function translateText(text, contextSentence, sourceLang = "en") {
  const response = await fetch("/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, contextSentence, sourceLang }),
  });
  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(errBody.error || `Translate request failed (${response.status})`);
  }
  return response.json();
}

/* ============================================================
   SPACED REPETITION (simplified SM-2)
   ============================================================ */
function scheduleNext(card, grade) {
  // grade: 0=forgot, 1=hard, 2=good, 3=easy
  let { interval = 0, ease = 2.5, reps = 0 } = card;
  if (grade === 0) {
    reps = 0;
    interval = 1;
    ease = Math.max(1.3, ease - 0.2);
  } else {
    reps += 1;
    if (reps === 1) interval = 1;
    else if (reps === 2) interval = 3;
    else interval = Math.round(interval * ease);
    if (grade === 1) ease = Math.max(1.3, ease - 0.15);
    if (grade === 3) ease = ease + 0.1;
  }
  const next = new Date();
  next.setDate(next.getDate() + interval);
  return { interval, ease, reps, nextReview: next.toISOString(), lastReview: new Date().toISOString() };
}

/* ============================================================
   STORAGE HELPERS — uses localStorage (per-browser, on-device)
   ============================================================ */
const VOCAB_KEY = "lectio-vocab-cards-v1";
const LIBRARY_KEY = "lectio-library-docs-v1";
const FOLDERS_KEY = "lectio-folders-v1";

async function loadVocab() {
  try { const raw = localStorage.getItem(VOCAB_KEY); return raw ? JSON.parse(raw) : []; } catch { return []; }
}
async function saveVocab(cards) {
  try { localStorage.setItem(VOCAB_KEY, JSON.stringify(cards)); } catch (e) { console.error(e); }
}
async function loadLibrary() {
  try { const raw = localStorage.getItem(LIBRARY_KEY); return raw ? JSON.parse(raw) : []; } catch { return []; }
}
async function saveLibrary(docs) {
  try { localStorage.setItem(LIBRARY_KEY, JSON.stringify(docs)); } catch (e) { console.error(e); }
}
async function loadFolders() {
  try { const raw = localStorage.getItem(FOLDERS_KEY); return raw ? JSON.parse(raw) : []; } catch { return []; }
}
async function saveFolders(folders) {
  try { localStorage.setItem(FOLDERS_KEY, JSON.stringify(folders)); } catch (e) { console.error(e); }
}

/* ============================================================
   MAIN APP
   ============================================================ */
export default function App() {
  const [view, setView] = useState("library");
  const [docs, setDocs] = useState([]);
  const [activeDoc, setActiveDoc] = useState(null);
  const [vocab, setVocab] = useState([]);
  const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState("");

  useEffect(() => {
    (async () => {
      setDocs(await loadLibrary());
      setVocab(await loadVocab());
      setFolders(await loadFolders());
    })();
  }, []);

  const vocabSet = useMemo(() => new Set(vocab.map(v => v.original.toLowerCase())), [vocab]);

  const addDoc = async (doc) => {
    const updated = [doc, ...docs];
    setDocs(updated);
    await saveLibrary(updated);
    setActiveDoc(doc);
    setView("reader");
  };

  const updateDoc = async (docId, patch) => {
    const updated = docs.map(d => d.id === docId ? { ...d, ...patch } : d);
    setDocs(updated);
    await saveLibrary(updated);
    if (activeDoc?.id === docId) setActiveDoc(prev => ({ ...prev, ...patch }));
  };

  const deleteDoc = async (docId) => {
    const updated = docs.filter(d => d.id !== docId);
    setDocs(updated);
    await saveLibrary(updated);
    if (activeDoc?.id === docId) { setActiveDoc(null); setView("library"); }
  };

  const addVocabCard = async (card) => {
    const exists = vocab.find(v => v.original.toLowerCase() === card.original.toLowerCase());
    if (exists) return;
    const newCard = {
      id: `v${Date.now()}`,
      original: card.original,
      meaning_vi: card.meaning_vi,
      part_of_speech: card.part_of_speech || "",
      pronunciation: card.pronunciation || "",
      example_en: card.example_en || "",
      example_vi: card.example_vi || "",
      source: card.source || "",
      sourceLang: card.sourceLang || "en",
      folderId: null,
      created: new Date().toISOString(),
    };
    const updated = [newCard, ...vocab];
    setVocab(updated);
    await saveVocab(updated);
  };

  const updateVocabCard = async (id, patch) => {
    const updated = vocab.map(v => v.id === id ? { ...v, ...patch } : v);
    setVocab(updated);
    await saveVocab(updated);
  };

  const deleteVocabCard = async (id) => {
    const updated = vocab.filter(v => v.id !== id);
    setVocab(updated);
    await saveVocab(updated);
  };

  const addFolder = async (name) => {
    const f = { id: `f${Date.now()}`, name, created: new Date().toISOString() };
    const updated = [...folders, f];
    setFolders(updated);
    await saveFolders(updated);
    return f.id;
  };

  const deleteFolder = async (folderId) => {
    // unassign cards in this folder
    const updatedVocab = vocab.map(v => v.folderId === folderId ? { ...v, folderId: null } : v);
    setVocab(updatedVocab);
    await saveVocab(updatedVocab);
    const updated = folders.filter(f => f.id !== folderId);
    setFolders(updated);
    await saveFolders(updated);
  };

  const renameFolder = async (folderId, name) => {
    const updated = folders.map(f => f.id === folderId ? { ...f, name } : f);
    setFolders(updated);
    await saveFolders(updated);
  };

  return (
    <div style={styles.app}>
      <style>{globalCss}</style>
      <Sidebar
        view={view} setView={setView}
        vocabCount={vocab.length}
        docCount={docs.length}
        activeDoc={activeDoc}
      />
      <main style={styles.main}>
        {loading && <LoadingOverlay msg={loadingMsg} />}
        {view === "library" && (
          <LibraryView
            docs={docs}
            onAdd={addDoc}
            onOpen={(d) => { setActiveDoc(d); setView("reader"); }}
            onDelete={deleteDoc}
            setLoading={setLoading}
            setLoadingMsg={setLoadingMsg}
          />
        )}
        {view === "reader" && activeDoc && (
          <ReaderView
            doc={activeDoc}
            onUpdateDoc={updateDoc}
            vocabSet={vocabSet}
            onAddVocab={addVocabCard}
            onBack={() => setView("library")}
          />
        )}
        {view === "vocab" && (
          <VocabView
            vocab={vocab}
            folders={folders}
            onDelete={deleteVocabCard}
            onUpdate={updateVocabCard}
            onAddFolder={addFolder}
            onDeleteFolder={deleteFolder}
            onRenameFolder={renameFolder}
          />
        )}
        {view === "review" && (
          <ReviewView
            vocab={vocab}
            folders={folders}
            onDone={() => setView("vocab")}
          />
        )}
      </main>
    </div>
  );
}

/* ============================================================
   SIDEBAR
   ============================================================ */
function Sidebar({ view, setView, vocabCount, docCount, activeDoc }) {
  const items = [
    { id: "library", label: "Thư viện", icon: Library, badge: docCount || null },
    { id: "reader", label: "Đang đọc", icon: BookOpen, disabled: !activeDoc },
    { id: "vocab", label: "Kho từ vựng", icon: Layers, badge: vocabCount || null },
    { id: "review", label: "Ôn tập", icon: Flame },
  ];
  return (
    <nav style={styles.sidebar}>
      <div style={styles.brand}>
        <BookOpen size={22} color="var(--accent)" />
        <span style={styles.brandText}>Lectio</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {items.map(it => (
          <button
            key={it.id}
            onClick={() => !it.disabled && setView(it.id)}
            disabled={it.disabled}
            style={{
              ...styles.navItem,
              ...(view === it.id ? styles.navItemActive : {}),
              opacity: it.disabled ? 0.35 : 1,
              cursor: it.disabled ? "default" : "pointer",
            }}
          >
            <it.icon size={17} />
            <span style={{ flex: 1, textAlign: "left" }}>{it.label}</span>
            {it.badge ? (
              <span style={{
                ...styles.badge,
                ...(it.highlight ? { background: "var(--accent)", color: "#fff" } : {})
              }}>{it.badge}</span>
            ) : null}
          </button>
        ))}
      </div>
      <div style={styles.sidebarFooter}>Dữ liệu lưu cục bộ trên thiết bị này</div>
    </nav>
  );
}

function LoadingOverlay({ msg }) {
  return (
    <div style={styles.loadingOverlay}>
      <div className="lectio-spinner" />
      <div style={{ marginTop: 14, fontFamily: "var(--font-ui)", fontSize: 14, color: "var(--ink-soft)" }}>{msg}</div>
    </div>
  );
}

/* ============================================================
   LIBRARY VIEW
   ============================================================ */
function LibraryView({ docs, onAdd, onOpen, onDelete, setLoading, setLoadingMsg }) {
  const fileRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const [pasteMode, setPasteMode] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteTitle, setPasteTitle] = useState("");
  const pasteAreaRef = useRef(null);

  const handlePasteSubmit = () => {
    const text = pasteText.trim();
    if (!text) return;
    const paragraphs = text.split(/\n\s*\n|\n/).map(p => p.trim()).filter(p => p.length > 0);
    const title = pasteTitle.trim() || `Đoạn dán ${new Date().toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`;
    const doc = {
      id: `doc${Date.now()}`,
      title,
      paragraphs,
      splitMode: "paragraph",
      splitN: 2,
      progress: 0,
      created: new Date().toISOString(),
    };
    onAdd(doc);
    setPasteText("");
    setPasteTitle("");
    setPasteMode(false);
  };

  // Allow pasting directly anywhere on the dropzone (Ctrl+V) without opening the textarea first
  const handleZonePaste = (e) => {
    const text = e.clipboardData?.getData("text/plain");
    if (text && text.trim().length > 0) {
      e.preventDefault();
      setPasteMode(true);
      setPasteText(text);
      setTimeout(() => pasteAreaRef.current?.focus(), 0);
    }
  };

  const handleFile = async (file) => {
    if (!file) return;
    const ext = file.name.split(".").pop().toLowerCase();
    if (!["pdf", "docx"].includes(ext)) {
      alert("Chỉ hỗ trợ file .pdf hoặc .docx");
      return;
    }
    setLoading(true);
    setLoadingMsg(ext === "pdf" ? "Đang đọc PDF…" : "Đang đọc Word…");
    try {
      const paragraphs = ext === "pdf" ? await parsePdf(file) : await parseDocx(file);
      const doc = {
        id: `doc${Date.now()}`,
        title: file.name.replace(/\.(pdf|docx)$/i, ""),
        paragraphs,
        splitMode: "paragraph",
        splitN: 2,
        progress: 0,
        created: new Date().toISOString(),
      };
      onAdd(doc);
    } catch (e) {
      console.error(e);
      alert("Không thể đọc file này. Vui lòng thử file khác.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.viewWrap}>
      <header style={styles.viewHeader}>
        <h1 style={styles.h1}>Thư viện</h1>
        <p style={styles.subtitle}>Tải lên sách hoặc bài báo tiếng Anh để bắt đầu đọc</p>
      </header>

      <div
        style={{ ...styles.dropzone, ...(dragOver ? styles.dropzoneActive : {}) }}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]); }}
        onPaste={handleZonePaste}
        tabIndex={0}
      >
        {!pasteMode ? (
          <div onClick={() => fileRef.current?.click()} style={{ cursor: "pointer" }}>
            <Upload size={28} color="var(--accent)" />
            <div style={{ fontFamily: "var(--font-ui)", fontSize: 15, color: "var(--ink)", marginTop: 10, fontWeight: 600 }}>
              Kéo thả file vào đây, hoặc bấm để chọn
            </div>
            <div style={{ fontFamily: "var(--font-ui)", fontSize: 13, color: "var(--ink-soft)", marginTop: 4 }}>
              Hỗ trợ .pdf và .docx — hoặc dán văn bản (Ctrl+V) ngay tại đây
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.docx"
              style={{ display: "none" }}
              onChange={(e) => handleFile(e.target.files[0])}
            />
            <div style={{ marginTop: 14 }}>
              <button
                style={styles.pasteToggleBtn}
                onClick={(e) => { e.stopPropagation(); setPasteMode(true); setTimeout(() => pasteAreaRef.current?.focus(), 0); }}
              >
                Hoặc dán đoạn văn vào đây
              </button>
            </div>
          </div>
        ) : (
          <div onClick={(e) => e.stopPropagation()} style={{ textAlign: "left" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontFamily: "var(--font-ui)", fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>
                Dán văn bản tiếng Anh
              </span>
              <button
                style={styles.iconBtnGhost}
                onClick={() => { setPasteMode(false); setPasteText(""); setPasteTitle(""); }}
              >
                <X size={14} />
              </button>
            </div>
            <input
              placeholder="Tiêu đề (tuỳ chọn)"
              value={pasteTitle}
              onChange={(e) => setPasteTitle(e.target.value)}
              style={styles.pasteTitleInput}
            />
            <textarea
              ref={pasteAreaRef}
              placeholder="Dán nội dung vào đây (Ctrl+V / Cmd+V)…"
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              style={styles.pasteTextarea}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") handlePasteSubmit();
              }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
              <span style={{ fontFamily: "var(--font-ui)", fontSize: 11.5, color: "var(--ink-faint)" }}>
                {pasteText.trim() ? `${pasteText.trim().split(/\s+/).length} từ` : ""} · Ctrl/Cmd+Enter để thêm nhanh
              </span>
              <button
                style={{ ...styles.translateBtn, width: "auto", padding: "8px 20px" }}
                disabled={!pasteText.trim()}
                onClick={handlePasteSubmit}
              >
                Thêm vào thư viện
              </button>
            </div>
          </div>
        )}
      </div>

      {docs.length > 0 && (
        <div style={styles.docGrid}>
          {docs.map(doc => (
            <div key={doc.id} style={styles.docCard} onClick={() => onOpen(doc)}>
              <div style={styles.docCardTop}>
                <BookOpen size={18} color="var(--accent)" />
                <button
                  onClick={(e) => { e.stopPropagation(); if (confirm(`Xoá "${doc.title}"?`)) onDelete(doc.id); }}
                  style={styles.iconBtnGhost}
                  aria-label="Xoá"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <div style={styles.docCardTitle}>{doc.title}</div>
              <div style={styles.docCardMeta}>{doc.paragraphs.length} đoạn văn</div>
              <div style={styles.progressTrack}>
                <div style={{ ...styles.progressFill, width: `${Math.round((doc.progress || 0) * 100)}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {docs.length === 0 && (
        <div style={styles.emptyState}>
          Chưa có tài liệu nào. Tải lên file đầu tiên để bắt đầu.
        </div>
      )}
    </div>
  );
}

/* ============================================================
   READER VIEW
   ============================================================ */
function ReaderView({ doc, onUpdateDoc, vocabSet, onAddVocab, onBack }) {
  const [splitMode, setSplitMode] = useState(doc.splitMode || "paragraph");
  const [splitN, setSplitN] = useState(doc.splitN || 2);
  const [selection, setSelection] = useState(null);
  const [translation, setTranslation] = useState(null);
  const [translating, setTranslating] = useState(false);
  const [translateError, setTranslateError] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const posKey = `lectio-pos-${doc.id}`;
  const [focusIdx, setFocusIdx] = useState(() => {
    try { return parseInt(localStorage.getItem(posKey) || "0", 10) || 0; } catch { return 0; }
  });
  const [jumpInput, setJumpInput] = useState(""); // for the editable counter

  // Save position with useEffect — fires after every focusIdx change, guaranteed
  useEffect(() => {
    try { localStorage.setItem(posKey, String(focusIdx)); } catch (e) { console.error(e); }
  }, [focusIdx, posKey]);

  const setFocusIdxAndSave = useCallback((valOrFn) => {
    setFocusIdx(prev => {
      const next = typeof valOrFn === "function" ? valOrFn(prev) : valOrFn;
      return next;
    });
  }, []);
  const [sourceLang, setSourceLang] = useState("en"); // "en" | "de"
  const contentRef = useRef(null);

  const blocks = useMemo(
    () => groupIntoBlocks(doc.paragraphs, splitMode, splitN),
    [doc.paragraphs, splitMode, splitN]
  );

  useEffect(() => {
    onUpdateDoc(doc.id, { splitMode, splitN });
    // eslint-disable-next-line
  }, [splitMode, splitN]);

  // Keyboard navigation for Focus Mode
  useEffect(() => {
    if (!focusMode) return;
    const handler = (e) => {
      if (e.key === "ArrowRight" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setFocusIdxAndSave(i => Math.min(i + 1, blocks.length - 1));
        setSelection(null); setTranslation(null);
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setFocusIdxAndSave(i => Math.max(i - 1, 0));
        setSelection(null); setTranslation(null);
      }
      if (e.key === "Escape") {
        setFocusMode(false);
        setSelection(null); setTranslation(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [focusMode, blocks.length]);

  const handleMouseUp = useCallback((e) => {
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    if (!text || text.length < 1 || text.length > 200) return;
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    let node = range.startContainer;
    while (node && node.nodeType !== 1) node = node.parentNode;
    const sentenceEl = node?.closest?.("[data-sentence]");
    const contextSentence = sentenceEl?.getAttribute("data-sentence") || text;
    const containerEl = focusMode ? document.getElementById("focus-content") : contentRef.current;
    const containerRect = containerEl?.getBoundingClientRect() || { left: 0, top: 0 };
    setSelection({
      text, contextSentence,
      x: rect.left - containerRect.left + rect.width / 2,
      y: rect.top - containerRect.top,
      fixed: focusMode, // use fixed positioning in focus mode
    });
    setTranslation(null);
    setTranslateError(null);
  }, [focusMode]);

  const doTranslate = async () => {
    if (!selection) return;
    setTranslating(true); setTranslateError(null);
    try {
      const result = await translateText(selection.text, selection.contextSentence, sourceLang);
      setTranslation(result);
    } catch (e) {
      console.error(e);
      setTranslateError("Không thể dịch lúc này. Thử lại nhé.");
    } finally {
      setTranslating(false);
    }
  };

  const saveCard = async () => {
    if (!translation) return;
    await onAddVocab({
      original: translation.original || selection.text,
      meaning_vi: translation.meaning_vi,
      part_of_speech: translation.part_of_speech,
      pronunciation: translation.pronunciation,
      example_en: selection.contextSentence,
      example_vi: translation.example_vi,
      source: doc.title,
      sourceLang,
    });
    setSelection(null); setTranslation(null);
  };

  const TranslatePopup = ({ fixedPos }) => {
    if (!selection) return null;
    const popupStyle = fixedPos
      ? { ...styles.translatePopup, position: "fixed", left: "50%", top: "72%", transform: "translate(-50%, -100%)", zIndex: 200 }
      : {
          ...styles.translatePopup,
          left: Math.min(Math.max(selection.x - 140, 8), (contentRef.current?.clientWidth || 600) - 288),
          top: Math.max(selection.y - 12, 0),
        };
    return (
      <div style={popupStyle}>
        <div style={styles.popupHeader}>
          <span style={styles.popupWord}>{selection.text}</span>
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <button
              style={{ ...styles.iconBtnGhost, fontSize: 16 }}
              title="Nghe phát âm"
              onClick={() => speak(selection.text, sourceLang)}
            >🔊</button>
            <button style={styles.iconBtnGhost} onClick={() => { setSelection(null); setTranslation(null); }}>
              <X size={14} />
            </button>
          </div>
        </div>
        {/* Language selector */}
        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          <button
            style={{ ...styles.pill, ...(sourceLang === "en" ? styles.pillActive : {}), fontSize: 11, padding: "3px 10px" }}
            onClick={() => { setSourceLang("en"); setTranslation(null); setTranslateError(null); }}
          >🇬🇧 Anh → Việt</button>
          <button
            style={{ ...styles.pill, ...(sourceLang === "de" ? styles.pillActive : {}), fontSize: 11, padding: "3px 10px" }}
            onClick={() => { setSourceLang("de"); setTranslation(null); setTranslateError(null); }}
          >🇩🇪 Đức → Việt</button>
        </div>
        {!translation && !translating && !translateError && (
          <button style={styles.translateBtn} onClick={doTranslate}>Dịch nghĩa</button>
        )}
        {translating && <div style={styles.popupLoading}><span className="lectio-spinner-sm" /> Đang dịch…</div>}
        {translateError && (
          <div>
            <div style={styles.popupError}>{translateError}</div>
            <button style={styles.translateBtn} onClick={doTranslate}>Thử lại</button>
          </div>
        )}
        {translation && (
          <div>
            <div style={styles.popupMeaning}>{translation.meaning_vi}</div>
            {(translation.part_of_speech || translation.pronunciation) && (
              <div style={styles.popupMeta}>
                {translation.part_of_speech && <span>{translation.part_of_speech}</span>}
                {translation.pronunciation && <span>{translation.pronunciation}</span>}
              </div>
            )}
            {translation.via === "google_translate" && (
              <div style={{ fontFamily: "var(--font-ui)", fontSize: 11, color: "var(--ink-faint)", marginBottom: 6, fontStyle: "italic" }}>
                🔄 Kết quả từ Google Dịch (Gemini tạm thời không khả dụng)
              </div>
            )}
            <button style={styles.saveBtn} onClick={saveCard}>
              <Plus size={14} /> Lưu vào kho từ
            </button>
          </div>
        )}
      </div>
    );
  };

  // ── FOCUS MODE OVERLAY ──────────────────────────────────────
  if (focusMode) {
    const block = blocks[focusIdx] || { sentences: [] };
    const pct = blocks.length > 1 ? focusIdx / (blocks.length - 1) : 1;
    return (
      <div style={styles.focusOverlay} onClick={() => { if (!selection) { setFocusIdxAndSave(i => Math.min(i + 1, blocks.length - 1)); } }}>
        {/* Top bar */}
        <div style={styles.focusTopBar} onClick={e => e.stopPropagation()}>
          <button style={styles.focusExitBtn} onClick={() => { setFocusMode(false); setSelection(null); setTranslation(null); }}>
            <X size={15} /> Thoát
          </button>
          <div style={styles.focusDocTitle}>{doc.title}</div>
          {/* Editable counter — click to type a sentence number and jump */}
          <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
            <input
              value={jumpInput !== "" ? jumpInput : String(focusIdx + 1)}
              onChange={e => setJumpInput(e.target.value.replace(/[^0-9]/g, ""))}
              onFocus={e => { setJumpInput(String(focusIdx + 1)); e.target.select(); }}
              onBlur={() => {
                const n = parseInt(jumpInput, 10);
                if (!isNaN(n) && n >= 1 && n <= blocks.length) {
                  setFocusIdxAndSave(n - 1);
                  setSelection(null); setTranslation(null);
                }
                setJumpInput("");
              }}
              onKeyDown={e => {
                if (e.key === "Enter") e.target.blur();
                if (e.key === "Escape") { setJumpInput(""); e.target.blur(); }
              }}
              style={styles.jumpInput}
              title="Nhập số câu để nhảy đến"
            />
            <span style={styles.focusCounter}>/ {blocks.length}</span>
          </div>
        </div>

        {/* Progress bar */}
        <div style={styles.focusProgressTrack}>
          <div style={{ ...styles.focusProgressFill, width: `${pct * 100}%` }} />
        </div>

        {/* Block of sentences */}
        <div style={styles.focusCenter} onClick={e => e.stopPropagation()}>
          <div id="focus-content" style={styles.focusSentence} onMouseUp={handleMouseUp}>
            {block.sentences.map((s, i) => (
              <span key={i} data-sentence={s}>
                {renderWithHighlights(s, vocabSet)}{i < block.sentences.length - 1 ? " " : ""}
              </span>
            ))}
          </div>
          <div style={styles.focusHint}>
            <span>← Câu trước</span>
            <span>Bấm màn hình / Space / Enter / → Tiếp theo</span>
            <span>Câu sau →</span>
          </div>
        </div>

        {/* Prev / Next buttons */}
        <button
          style={{ ...styles.focusNavBtn, left: 20 }}
          onClick={(e) => { e.stopPropagation(); setFocusIdxAndSave(i => Math.max(i - 1, 0)); setSelection(null); setTranslation(null); }}
          disabled={focusIdx === 0}
        >
          <ChevronLeft size={22} />
        </button>
        <button
          style={{ ...styles.focusNavBtn, right: 20 }}
          onClick={(e) => { e.stopPropagation(); setFocusIdxAndSave(i => Math.min(i + 1, blocks.length - 1)); setSelection(null); setTranslation(null); }}
          disabled={focusIdx === blocks.length - 1}
        >
          <ChevronRight size={22} />
        </button>

        <TranslatePopup fixedPos />
      </div>
    );
  }

  // ── NORMAL SCROLL MODE ──────────────────────────────────────
  return (
    <div style={styles.readerWrap}>
      <div style={styles.readerToolbar}>
        <button style={styles.backBtn} onClick={onBack}>
          <ChevronLeft size={16} /> Thư viện
        </button>
        <div style={styles.readerTitle}>{doc.title}</div>
        <button
          style={{ ...styles.iconBtn, marginRight: 4, background: "var(--accent)", color: "#fff", border: "none" }}
          onClick={() => { setFocusMode(true); setFocusIdxAndSave(0); setSelection(null); setTranslation(null); }}
          title="Đọc tập trung từng câu"
        >
          <Focus size={16} />
        </button>
        <button style={styles.iconBtn} onClick={() => setShowSettings(s => !s)}>
          <Settings2 size={16} />
        </button>
      </div>

      {showSettings && (
        <div style={styles.settingsPanel}>
          <div style={{ fontFamily: "var(--font-ui)", fontSize: 13, fontWeight: 600, color: "var(--ink)", marginBottom: 10 }}>
            Cách ngắt câu
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button
              style={{ ...styles.pill, ...(splitMode === "paragraph" ? styles.pillActive : {}) }}
              onClick={() => setSplitMode("paragraph")}
            >
              Theo đoạn gốc
            </button>
            <button
              style={{ ...styles.pill, ...(splitMode === "sentences" ? styles.pillActive : {}) }}
              onClick={() => setSplitMode("sentences")}
            >
              Theo số câu
            </button>
            {splitMode === "sentences" && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 4 }}>
                <span style={{ fontFamily: "var(--font-ui)", fontSize: 13, color: "var(--ink-soft)" }}>Số câu:</span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={splitN}
                  onChange={(e) => setSplitN(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
                  style={styles.numInput}
                />
              </div>
            )}
          </div>
        </div>
      )}

      <div style={styles.readerContent} ref={contentRef} onMouseUp={handleMouseUp}>
        {blocks.map((block) => (
          <p key={block.id} style={styles.readerBlock}>
            {block.sentences.map((s, j) => (
              <span key={j} data-sentence={s} style={styles.sentenceSpan}>
                {renderWithHighlights(s, vocabSet)}{" "}
              </span>
            ))}
          </p>
        ))}
      </div>

      <TranslatePopup fixedPos={false} />
    </div>
  );
}

function renderWithHighlights(sentence, vocabSet) {
  if (vocabSet.size === 0) return sentence;
  const words = sentence.split(/(\s+)/);
  return words.map((w, i) => {
    const clean = w.replace(/[^a-zA-Z'-]/g, "").toLowerCase();
    if (clean && vocabSet.has(clean)) {
      return <mark key={i} style={styles.vocabMark}>{w}</mark>;
    }
    return w;
  });
}

/* ============================================================
   VOCAB VIEW — with folders
   ============================================================ */
function VocabView({ vocab, folders, onDelete, onUpdate, onAddFolder, onDeleteFolder, onRenameFolder }) {
  const [filter, setFilter] = useState("");
  const [activeFolderId, setActiveFolderId] = useState(null); // null = "Tất cả"
  const [newFolderName, setNewFolderName] = useState("");
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [renamingId, setRenamingId] = useState(null);
  const [renameVal, setRenameVal] = useState("");
  const [movingCardId, setMovingCardId] = useState(null);

  const filtered = vocab.filter(v => {
    const matchFolder = activeFolderId === null ? true : v.folderId === activeFolderId;
    const matchText = !filter ||
      v.original.toLowerCase().includes(filter.toLowerCase()) ||
      v.meaning_vi.toLowerCase().includes(filter.toLowerCase());
    return matchFolder && matchText;
  });

  const handleAddFolder = async () => {
    if (!newFolderName.trim()) return;
    await onAddFolder(newFolderName.trim());
    setNewFolderName(""); setShowNewFolder(false);
  };

  return (
    <div style={styles.viewWrap}>
      <header style={styles.viewHeader}>
        <h1 style={styles.h1}>Kho từ vựng</h1>
        <p style={styles.subtitle}>{vocab.length} thẻ đã lưu</p>
      </header>

      {/* Folder tabs */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16, alignItems: "center" }}>
        <button
          style={{ ...styles.pill, ...(activeFolderId === null ? styles.pillActive : {}) }}
          onClick={() => setActiveFolderId(null)}
        >📚 Tất cả ({vocab.length})</button>

        {folders.map(f => {
          const count = vocab.filter(v => v.folderId === f.id).length;
          return (
            <div key={f.id} style={{ position: "relative", display: "flex", alignItems: "center", gap: 2 }}>
              {renamingId === f.id ? (
                <input
                  autoFocus
                  value={renameVal}
                  onChange={e => setRenameVal(e.target.value)}
                  onBlur={async () => { await onRenameFolder(f.id, renameVal || f.name); setRenamingId(null); }}
                  onKeyDown={async e => { if (e.key === "Enter") { await onRenameFolder(f.id, renameVal || f.name); setRenamingId(null); } }}
                  style={{ ...styles.pasteTitleInput, width: 100, padding: "4px 8px", marginBottom: 0 }}
                />
              ) : (
                <button
                  style={{ ...styles.pill, ...(activeFolderId === f.id ? styles.pillActive : {}) }}
                  onClick={() => setActiveFolderId(f.id)}
                  onDoubleClick={() => { setRenamingId(f.id); setRenameVal(f.name); }}
                >📁 {f.name} ({count})</button>
              )}
              <button
                style={{ ...styles.iconBtnGhost, padding: 2, fontSize: 11 }}
                onClick={() => { if (confirm(`Xoá folder "${f.name}"? Các từ sẽ về "Tất cả".`)) onDeleteFolder(f.id); }}
                title="Xoá folder"
              >×</button>
            </div>
          );
        })}

        {showNewFolder ? (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              autoFocus
              placeholder="Tên folder…"
              value={newFolderName}
              onChange={e => setNewFolderName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") handleAddFolder(); if (e.key === "Escape") setShowNewFolder(false); }}
              style={{ ...styles.pasteTitleInput, width: 130, padding: "5px 10px", marginBottom: 0 }}
            />
            <button style={{ ...styles.translateBtn, width: "auto", padding: "5px 14px" }} onClick={handleAddFolder}>Thêm</button>
            <button style={styles.iconBtnGhost} onClick={() => setShowNewFolder(false)}><X size={13} /></button>
          </div>
        ) : (
          <button style={{ ...styles.pill }} onClick={() => setShowNewFolder(true)}>
            <Plus size={12} style={{ marginRight: 4 }} />Folder mới
          </button>
        )}
      </div>

      <input
        placeholder="Tìm từ hoặc nghĩa…"
        value={filter}
        onChange={e => setFilter(e.target.value)}
        style={styles.searchInput}
      />

      {filtered.length === 0 && (
        <div style={styles.emptyState}>
          {vocab.length === 0 ? "Chưa có từ nào. Bôi đen từ khi đọc để lưu vào đây." : "Không tìm thấy từ nào."}
        </div>
      )}

      <div style={styles.vocabGrid}>
        {filtered.map(card => (
          <div key={card.id} style={styles.vocabCard}>
            <div style={styles.vocabCardTop}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span style={styles.vocabWord}>{card.original}</span>
                {card.pronunciation && <span style={styles.vocabIpa}>{card.pronunciation}</span>}
                <button style={{ ...styles.speakBtn, padding: "2px 8px", fontSize: 12 }}
                  onClick={() => speak(card.original, card.sourceLang || "en")}>🔊</button>
              </div>
              <div style={{ display: "flex", gap: 4 }}>
                {/* Move to folder */}
                <select
                  value={card.folderId || ""}
                  onChange={async e => await onUpdate(card.id, { folderId: e.target.value || null })}
                  style={styles.folderSelect}
                  title="Chuyển vào folder"
                >
                  <option value="">📚 Tất cả</option>
                  {folders.map(f => <option key={f.id} value={f.id}>📁 {f.name}</option>)}
                </select>
                <button style={styles.iconBtnGhost} onClick={() => onDelete(card.id)}>
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
            {card.part_of_speech && <div style={styles.vocabPos}>{card.part_of_speech}</div>}
            <div style={styles.vocabMeaning}>{card.meaning_vi}</div>
            {card.example_en && (
              <div style={styles.vocabExample}>
                <div style={styles.vocabExampleEn}>"{card.example_en}"</div>
                {card.example_vi && <div style={styles.vocabExampleVi}>{card.example_vi}</div>}
              </div>
            )}
            <div style={styles.vocabFooter}>
              <span>{card.source || "—"}</span>
              <span style={{ fontSize: 10 }}>{card.sourceLang === "de" ? "🇩🇪 Đức" : "🇬🇧 Anh"}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============================================================
   REVIEW VIEW — Flashcard kho + Gõ đáp án, chọn folder
   ============================================================ */
function ReviewView({ vocab, folders, onDone }) {
  const [reviewMode, setReviewMode] = useState("flashcard");
  const [activeFolderId, setActiveFolderId] = useState(null);
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [typedAnswer, setTypedAnswer] = useState("");
  const [checkResult, setCheckResult] = useState(null);
  const inputRef = useRef(null);

  const cards = useMemo(() => {
    const pool = activeFolderId === null ? vocab : vocab.filter(v => v.folderId === activeFolderId);
    // shuffle
    return [...pool].sort(() => Math.random() - 0.5);
  }, [vocab, activeFolderId]);

  useEffect(() => { setIdx(0); setFlipped(false); setTypedAnswer(""); setCheckResult(null); }, [cards]);

  useEffect(() => {
    if (reviewMode === "typing" && !checkResult) setTimeout(() => inputRef.current?.focus(), 50);
  }, [reviewMode, idx, checkResult]);

  // Keyboard nav + Ctrl+Alt+S to speak
  useEffect(() => {
    const handler = (e) => {
      if (e.key === "ArrowRight" && reviewMode === "flashcard" && flipped) goNext();
      if (e.key === "ArrowLeft" && reviewMode === "flashcard") goPrev();
      if (e.key === " " && reviewMode === "flashcard" && !e.target.matches("input,textarea")) {
        e.preventDefault(); setFlipped(f => !f);
      }
      // Ctrl+Alt+S — speak current card word
      if (e.ctrlKey && e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        const current = cards[idx];
        if (current) speak(current.original, current.sourceLang || "en");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [reviewMode, flipped, idx, cards]);

  const goNext = () => { setIdx(i => (i + 1) % Math.max(cards.length, 1)); setFlipped(false); setTypedAnswer(""); setCheckResult(null); };
  const goPrev = () => { setIdx(i => (i - 1 + Math.max(cards.length, 1)) % Math.max(cards.length, 1)); setFlipped(false); setTypedAnswer(""); setCheckResult(null); };

  const handleCheck = () => {
    if (!typedAnswer.trim() || !card) return;
    const status = fuzzyMatch(typedAnswer.trim(), card.original);
    setCheckResult({ status, correct: card.original });
    speak(card.original, card.sourceLang || "en");
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") { if (!checkResult) handleCheck(); else goNext(); }
  };

  const resultColors = {
    perfect: { bg: "#e6f4ea", border: "#4caf50", text: "#2e7d32", label: "✅ Chính xác!" },
    close:   { bg: "#e8f5e9", border: "#81c784", text: "#388e3c", label: "👍 Gần đúng!" },
    almost:  { bg: "#fff8e1", border: "#ffb300", text: "#e65100", label: "🤏 Gần rồi!" },
    wrong:   { bg: "#fdecea", border: "#e57373", text: "#c62828", label: "❌ Sai rồi!" },
  };

  if (vocab.length === 0) {
    return (
      <div style={styles.viewWrap}>
        <div style={styles.emptyState}>
          Chưa có từ nào để ôn. Hãy đọc tài liệu và lưu từ vựng trước.
        </div>
      </div>
    );
  }

  const card = cards[idx] || null;

  return (
    <div style={styles.viewWrap}>
      <header style={styles.viewHeader}>
        <h1 style={styles.h1}>Ôn tập</h1>
        <p style={styles.subtitle}>{cards.length > 0 ? `${idx + 1} / ${cards.length}` : "0 thẻ"}</p>
      </header>

      {/* Controls row */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 20 }}>
        {/* Mode toggle */}
        <button style={{ ...styles.pill, ...(reviewMode === "flashcard" ? styles.pillActive : {}) }}
          onClick={() => { setReviewMode("flashcard"); setFlipped(false); setCheckResult(null); }}>
          🃏 Lật thẻ</button>
        <button style={{ ...styles.pill, ...(reviewMode === "typing" ? styles.pillActive : {}) }}
          onClick={() => { setReviewMode("typing"); setFlipped(false); setTypedAnswer(""); setCheckResult(null); }}>
          ⌨️ Gõ đáp án</button>

        {/* Folder filter */}
        <select
          value={activeFolderId || ""}
          onChange={e => setActiveFolderId(e.target.value || null)}
          style={{ ...styles.folderSelect, marginLeft: "auto" }}
        >
          <option value="">📚 Tất cả ({vocab.length})</option>
          {folders.map(f => {
            const count = vocab.filter(v => v.folderId === f.id).length;
            return <option key={f.id} value={f.id}>📁 {f.name} ({count})</option>;
          })}
        </select>
      </div>

      {cards.length === 0 ? (
        <div style={styles.emptyState}>Folder này chưa có từ nào.</div>
      ) : !card ? null : (

        <div style={styles.flashcardWrap}>

          {/* ── FLASHCARD MODE ── */}
          {reviewMode === "flashcard" && (<>
            <div style={styles.flashcard} onClick={() => setFlipped(f => !f)}>
              {!flipped ? (
                <div style={styles.flashFront}>
                  <div style={styles.flashWord}>{card.original}</div>
                  {card.pronunciation && <div style={styles.flashIpa}>{card.pronunciation}</div>}
                  <button style={styles.speakBtn}
                    onClick={e => { e.stopPropagation(); speak(card.original, card.sourceLang || "en"); }}>
                    🔊 Nghe</button>
                  <div style={styles.flashHint}>Bấm thẻ để xem nghĩa · Space lật · Ctrl+Alt+S nghe</div>
                </div>
              ) : (
                <div style={styles.flashBack}>
                  {card.part_of_speech && <div style={styles.vocabPos}>{card.part_of_speech}</div>}
                  <div style={styles.flashMeaning}>{card.meaning_vi}</div>
                  {card.example_en && (
                    <div style={styles.vocabExample}>
                      <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
                        <div style={styles.vocabExampleEn}>"{card.example_en}"</div>
                        <button style={{ ...styles.speakBtn, padding: "2px 8px", fontSize: 12, flexShrink: 0 }}
                          onClick={e => { e.stopPropagation(); speak(card.example_en, card.sourceLang || "en"); }}>🔊</button>
                      </div>
                      {card.example_vi && <div style={styles.vocabExampleVi}>{card.example_vi}</div>}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 10, width: "100%", maxWidth: 480 }}>
              <button style={{ ...styles.gradeBtn, background: "var(--paper-deep)", color: "var(--ink)", border: "1px solid var(--line-strong)", flex: 1 }}
                onClick={goPrev}>← Trước</button>
              <button style={{ ...styles.gradeBtn, background: "var(--accent)", flex: 1 }}
                onClick={goNext}>Tiếp →</button>
            </div>
          </>)}

          {/* ── TYPING MODE ── */}
          {reviewMode === "typing" && (
            <div style={{ ...styles.flashcard, cursor: "default", minHeight: 240, width: "100%", maxWidth: 480 }}>
              <div style={styles.flashBack}>
                <div style={{ fontFamily: "var(--font-ui)", fontSize: 13, color: "var(--ink-faint)", marginBottom: 6 }}>
                  {card.sourceLang === "de" ? "🇩🇪 Gõ từ tiếng Đức" : "🇬🇧 Gõ từ tiếng Anh"}
                </div>
                <div style={styles.flashMeaning}>{card.meaning_vi}</div>
                {card.part_of_speech && <div style={{ ...styles.vocabPos, marginBottom: 8 }}>{card.part_of_speech}</div>}
                {card.pronunciation && !checkResult && (
                  <div style={{ fontFamily: "var(--font-ui)", fontSize: 12, color: "var(--ink-faint)", fontStyle: "italic", marginBottom: 4 }}>
                    Gợi ý phát âm: {card.pronunciation}
                  </div>
                )}
                {!checkResult ? (
                  <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                    <input ref={inputRef} value={typedAnswer}
                      onChange={e => setTypedAnswer(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder="Gõ từ vào đây…"
                      style={styles.typingInput}
                      autoComplete="off" autoCorrect="off" spellCheck="false" />
                    <button style={{ ...styles.translateBtn, width: "auto", padding: "0 16px" }} onClick={handleCheck}>
                      Kiểm tra</button>
                  </div>
                ) : (
                  <div style={{ marginTop: 14 }}>
                    <div style={{
                      background: resultColors[checkResult.status].bg,
                      border: `1.5px solid ${resultColors[checkResult.status].border}`,
                      borderRadius: 10, padding: "12px 16px", marginBottom: 10,
                    }}>
                      <div style={{ fontFamily: "var(--font-ui)", fontSize: 14, fontWeight: 700, color: resultColors[checkResult.status].text, marginBottom: 6 }}>
                        {resultColors[checkResult.status].label}
                      </div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <span style={{ fontFamily: "var(--font-ui)", fontSize: 13, color: "var(--ink-soft)" }}>Bạn gõ:</span>
                        <span style={{ fontFamily: "var(--font-display)", fontSize: 15, color: "var(--ink)", fontWeight: 600 }}>{typedAnswer}</span>
                      </div>
                      {checkResult.status !== "perfect" && (
                        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4, flexWrap: "wrap" }}>
                          <span style={{ fontFamily: "var(--font-ui)", fontSize: 13, color: "var(--ink-soft)" }}>Đáp án:</span>
                          <span style={{ fontFamily: "var(--font-display)", fontSize: 15, color: "var(--accent)", fontWeight: 600 }}>{checkResult.correct}</span>
                          <button style={{ ...styles.speakBtn, padding: "1px 8px", fontSize: 12, marginTop: 0 }}
                            onClick={() => speak(checkResult.correct, card.sourceLang || "en")}>🔊</button>
                        </div>
                      )}
                      {card.example_en && (
                        <div style={{ marginTop: 8, fontFamily: "var(--font-serif)", fontSize: 13, color: "var(--ink-soft)", fontStyle: "italic" }}>
                          "{card.example_en}"
                        </div>
                      )}
                    </div>
                    <div style={{ fontFamily: "var(--font-ui)", fontSize: 11.5, color: "var(--ink-faint)", marginBottom: 8, textAlign: "center" }}>
                      Enter để tiếp tục
                    </div>
                    <button style={{ ...styles.translateBtn }} onClick={goNext}>Từ tiếp theo →</button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
function fuzzyMatch(input, answer) {
  const normalize = s => s.toLowerCase()
    .replace(/[äÄ]/g, "a").replace(/[öÖ]/g, "o").replace(/[üÜ]/g, "u").replace(/ß/g, "ss")
    .replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
  const a = normalize(input);
  const b = normalize(answer);
  if (a === b) return "perfect";
  // Levenshtein distance
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 4) return "wrong";
  const dp = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  const dist = dp[m][n];
  const maxLen = Math.max(m, n);
  if (dist === 0) return "perfect";
  if (dist <= Math.max(1, Math.floor(maxLen * 0.15))) return "close"; // ≤15% sai
  if (dist <= Math.max(2, Math.floor(maxLen * 0.30))) return "almost"; // ≤30% sai
  return "wrong";
}

/* ============================================================
   REVIEW VIEW — Flashcard + Typing mode
   ============================================================ */
/* ============================================================
   STYLES — design tokens
   Palette: warm library paper, deep forest-ink accent
   ============================================================ */
const styles = {
  app: {
    display: "flex",
    minHeight: "100vh",
    background: "var(--paper)",
    fontFamily: "var(--font-ui)",
  },
  sidebar: {
    width: 200,
    flexShrink: 0,
    background: "var(--paper-deep)",
    borderRight: "1px solid var(--line)",
    padding: "20px 14px",
    display: "flex",
    flexDirection: "column",
    position: "sticky",
    top: 0,
    height: "100vh",
  },
  brand: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "0 8px",
    marginBottom: 24,
  },
  brandText: {
    fontFamily: "var(--font-display)",
    fontSize: 20,
    fontWeight: 600,
    color: "var(--ink)",
    letterSpacing: "-0.01em",
  },
  navItem: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "9px 10px",
    borderRadius: 8,
    border: "none",
    background: "transparent",
    color: "var(--ink-soft)",
    fontFamily: "var(--font-ui)",
    fontSize: 13.5,
    fontWeight: 500,
    textAlign: "left",
  },
  navItemActive: {
    background: "var(--paper)",
    color: "var(--ink)",
    boxShadow: "inset 0 0 0 1px var(--line)",
  },
  badge: {
    fontSize: 11,
    fontWeight: 600,
    background: "var(--line)",
    color: "var(--ink-soft)",
    borderRadius: 999,
    padding: "1px 7px",
    minWidth: 18,
    textAlign: "center",
  },
  sidebarFooter: {
    marginTop: "auto",
    fontSize: 11,
    color: "var(--ink-faint)",
    padding: "0 8px",
    lineHeight: 1.5,
  },
  main: {
    flex: 1,
    position: "relative",
    minHeight: "100vh",
  },
  viewWrap: {
    maxWidth: 920,
    margin: "0 auto",
    padding: "40px 32px 80px",
  },
  viewHeader: {
    marginBottom: 28,
  },
  h1: {
    fontFamily: "var(--font-display)",
    fontSize: 30,
    fontWeight: 600,
    color: "var(--ink)",
    margin: 0,
    letterSpacing: "-0.01em",
  },
  subtitle: {
    fontFamily: "var(--font-ui)",
    fontSize: 13.5,
    color: "var(--ink-soft)",
    marginTop: 4,
  },
  dropzone: {
    border: "1.5px dashed var(--line-strong)",
    borderRadius: 14,
    padding: "40px 24px",
    textAlign: "center",
    cursor: "pointer",
    background: "var(--paper)",
    transition: "border-color 0.15s, background 0.15s",
  },
  dropzoneActive: {
    borderColor: "var(--accent)",
    background: "var(--accent-faint)",
  },
  pasteToggleBtn: {
    background: "transparent",
    border: "none",
    color: "var(--accent)",
    fontFamily: "var(--font-ui)",
    fontSize: 12.5,
    fontWeight: 600,
    cursor: "pointer",
    textDecoration: "underline",
    textUnderlineOffset: 3,
  },
  pasteTitleInput: {
    width: "100%",
    padding: "8px 12px",
    borderRadius: 8,
    border: "1px solid var(--line-strong)",
    fontFamily: "var(--font-ui)",
    fontSize: 13,
    color: "var(--ink)",
    marginBottom: 8,
    background: "var(--paper)",
  },
  pasteTextarea: {
    width: "100%",
    minHeight: 140,
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px solid var(--line-strong)",
    fontFamily: "var(--font-serif)",
    fontSize: 14,
    lineHeight: 1.6,
    color: "var(--ink)",
    background: "var(--paper)",
    resize: "vertical",
  },
  docGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
    gap: 14,
    marginTop: 24,
  },
  docCard: {
    background: "var(--paper)",
    border: "1px solid var(--line)",
    borderRadius: 12,
    padding: 16,
    cursor: "pointer",
  },
  docCardTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  docCardTitle: {
    fontFamily: "var(--font-display)",
    fontSize: 16,
    fontWeight: 600,
    color: "var(--ink)",
    marginBottom: 4,
    lineHeight: 1.3,
  },
  docCardMeta: {
    fontFamily: "var(--font-ui)",
    fontSize: 12,
    color: "var(--ink-faint)",
    marginBottom: 10,
  },
  progressTrack: {
    height: 4,
    borderRadius: 999,
    background: "var(--line)",
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    background: "var(--accent)",
  },
  emptyState: {
    textAlign: "center",
    padding: "60px 20px",
    color: "var(--ink-soft)",
    fontFamily: "var(--font-ui)",
    fontSize: 14,
  },
  iconBtn: {
    background: "var(--paper)",
    border: "1px solid var(--line)",
    borderRadius: 8,
    padding: 7,
    color: "var(--ink-soft)",
    cursor: "pointer",
  },
  iconBtnGhost: {
    background: "transparent",
    border: "none",
    color: "var(--ink-faint)",
    cursor: "pointer",
    padding: 4,
    borderRadius: 6,
  },
  /* Reader */
  readerWrap: {
    maxWidth: 760,
    margin: "0 auto",
    padding: "24px 32px 100px",
    position: "relative",
  },
  readerToolbar: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    marginBottom: 8,
    paddingBottom: 14,
    borderBottom: "1px solid var(--line)",
  },
  backBtn: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    background: "transparent",
    border: "none",
    color: "var(--ink-soft)",
    fontFamily: "var(--font-ui)",
    fontSize: 13,
    cursor: "pointer",
    padding: "4px 2px",
  },
  readerTitle: {
    flex: 1,
    fontFamily: "var(--font-display)",
    fontSize: 16,
    fontWeight: 600,
    color: "var(--ink)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  settingsPanel: {
    background: "var(--paper-deep)",
    border: "1px solid var(--line)",
    borderRadius: 10,
    padding: 14,
    marginTop: 12,
    marginBottom: 8,
  },
  pill: {
    fontFamily: "var(--font-ui)",
    fontSize: 12.5,
    fontWeight: 500,
    padding: "6px 12px",
    borderRadius: 999,
    border: "1px solid var(--line-strong)",
    background: "var(--paper)",
    color: "var(--ink-soft)",
    cursor: "pointer",
  },
  pillActive: {
    background: "var(--accent)",
    borderColor: "var(--accent)",
    color: "#fff",
  },
  numInput: {
    width: 50,
    padding: "5px 8px",
    borderRadius: 6,
    border: "1px solid var(--line-strong)",
    fontFamily: "var(--font-ui)",
    fontSize: 13,
    color: "var(--ink)",
  },
  readerContent: {
    marginTop: 20,
    fontFamily: "var(--font-serif)",
    fontSize: 19,
    lineHeight: 1.85,
    color: "var(--ink)",
  },
  readerBlock: {
    marginBottom: "1.3em",
  },
  sentenceSpan: {
    cursor: "text",
  },
  vocabMark: {
    background: "var(--accent-faint)",
    color: "var(--ink)",
    borderRadius: 3,
    padding: "0.5px 2px",
    boxShadow: "inset 0 -1.5px 0 var(--accent-soft)",
  },
  translatePopup: {
    position: "absolute",
    width: 280,
    background: "var(--paper)",
    border: "1px solid var(--line-strong)",
    borderRadius: 12,
    boxShadow: "0 8px 28px rgba(40, 30, 20, 0.16)",
    padding: 14,
    zIndex: 50,
    transform: "translateY(-100%)",
  },
  popupHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 8,
  },
  popupWord: {
    fontFamily: "var(--font-display)",
    fontSize: 16,
    fontWeight: 600,
    color: "var(--ink)",
  },
  popupLoading: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontFamily: "var(--font-ui)",
    fontSize: 13,
    color: "var(--ink-soft)",
  },
  popupError: {
    fontFamily: "var(--font-ui)",
    fontSize: 12.5,
    color: "#a8442f",
    marginBottom: 8,
  },
  popupMeaning: {
    fontFamily: "var(--font-ui)",
    fontSize: 14.5,
    color: "var(--ink)",
    fontWeight: 500,
    marginBottom: 6,
  },
  popupMeta: {
    display: "flex",
    gap: 10,
    fontFamily: "var(--font-ui)",
    fontSize: 12,
    color: "var(--ink-faint)",
    fontStyle: "italic",
    marginBottom: 10,
  },
  translateBtn: {
    width: "100%",
    background: "var(--accent)",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "9px 0",
    fontFamily: "var(--font-ui)",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  saveBtn: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    background: "var(--ink)",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "9px 0",
    fontFamily: "var(--font-ui)",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
  },
  /* Vocab */
  searchInput: {
    width: "100%",
    padding: "10px 14px",
    borderRadius: 10,
    border: "1px solid var(--line-strong)",
    fontFamily: "var(--font-ui)",
    fontSize: 14,
    color: "var(--ink)",
    marginBottom: 20,
    background: "var(--paper)",
  },
  vocabGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
    gap: 14,
  },
  vocabCard: {
    background: "var(--paper)",
    border: "1px solid var(--line)",
    borderRadius: 12,
    padding: 16,
  },
  vocabCardTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  vocabWord: {
    fontFamily: "var(--font-display)",
    fontSize: 17,
    fontWeight: 600,
    color: "var(--ink)",
  },
  vocabIpa: {
    fontFamily: "var(--font-ui)",
    fontSize: 12,
    color: "var(--ink-faint)",
    marginLeft: 8,
  },
  vocabPos: {
    fontFamily: "var(--font-ui)",
    fontSize: 11,
    color: "var(--accent)",
    fontStyle: "italic",
    marginTop: 4,
  },
  vocabMeaning: {
    fontFamily: "var(--font-ui)",
    fontSize: 14.5,
    color: "var(--ink)",
    marginTop: 6,
    fontWeight: 500,
  },
  vocabExample: {
    marginTop: 10,
    paddingTop: 10,
    borderTop: "1px solid var(--line)",
  },
  vocabExampleEn: {
    fontFamily: "var(--font-serif)",
    fontSize: 13,
    color: "var(--ink-soft)",
    fontStyle: "italic",
    lineHeight: 1.5,
  },
  vocabExampleVi: {
    fontFamily: "var(--font-ui)",
    fontSize: 12,
    color: "var(--ink-faint)",
    marginTop: 4,
  },
  vocabFooter: {
    display: "flex",
    justifyContent: "space-between",
    marginTop: 12,
    fontFamily: "var(--font-ui)",
    fontSize: 11,
    color: "var(--ink-faint)",
  },
  /* Review / flashcards */
  flashcardWrap: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 20,
  },
  flashcard: {
    width: "100%",
    maxWidth: 480,
    minHeight: 280,
    background: "var(--paper)",
    border: "1px solid var(--line-strong)",
    borderRadius: 16,
    boxShadow: "0 4px 20px rgba(40,30,20,0.08)",
    padding: 32,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
    cursor: "pointer",
  },
  speakBtn: {
    background: "var(--paper-deep)",
    border: "1px solid var(--line)",
    borderRadius: 6,
    padding: "3px 10px",
    fontFamily: "var(--font-ui)",
    fontSize: 13,
    color: "var(--ink-soft)",
    cursor: "pointer",
    marginTop: 6,
  },
  folderSelect: {
    padding: "5px 8px",
    borderRadius: 7,
    border: "1px solid var(--line-strong)",
    fontFamily: "var(--font-ui)",
    fontSize: 12,
    color: "var(--ink)",
    background: "var(--paper)",
    cursor: "pointer",
  },
  typingInput: {
    flex: 1,
    padding: "9px 12px",
    borderRadius: 8,
    border: "1.5px solid var(--line-strong)",
    fontFamily: "var(--font-display)",
    fontSize: 15,
    color: "var(--ink)",
    background: "var(--paper)",
  },
  flashWord: {
    fontFamily: "var(--font-display)",
    fontSize: 32,
    fontWeight: 600,
    color: "var(--ink)",
  },
  flashIpa: {
    fontFamily: "var(--font-ui)",
    fontSize: 14,
    color: "var(--ink-faint)",
  },
  flashHint: {
    fontFamily: "var(--font-ui)",
    fontSize: 12,
    color: "var(--ink-faint)",
    marginTop: 14,
  },
  flashBack: { width: "100%" },
  flashMeaning: {
    fontFamily: "var(--font-ui)",
    fontSize: 20,
    fontWeight: 600,
    color: "var(--ink)",
    marginTop: 6,
  },
  gradeRow: {
    display: "flex",
    gap: 8,
    width: "100%",
    maxWidth: 480,
  },
  gradeBtn: {
    flex: 1,
    padding: "11px 0",
    borderRadius: 10,
    border: "none",
    fontFamily: "var(--font-ui)",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    color: "#fff",
  },
  gradeForgot: { background: "#a8442f" },
  gradeHard: { background: "#c08a3e" },
  gradeGood: { background: "var(--accent-soft)" },
  gradeEasy: { background: "var(--accent)" },
  /* Stats */
  statsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
    gap: 12,
    marginBottom: 28,
  },
  statCard: {
    background: "var(--paper)",
    border: "1px solid var(--line)",
    borderRadius: 12,
    padding: "18px 16px",
  },
  statValue: {
    fontFamily: "var(--font-display)",
    fontSize: 28,
    fontWeight: 600,
    color: "var(--ink)",
  },
  statLabel: {
    fontFamily: "var(--font-ui)",
    fontSize: 12,
    color: "var(--ink-soft)",
    marginTop: 2,
  },
  statsBarWrap: {
    background: "var(--paper)",
    border: "1px solid var(--line)",
    borderRadius: 12,
    padding: 18,
  },
  statsBar: {
    display: "flex",
    height: 10,
    borderRadius: 999,
    overflow: "hidden",
  },
  statsLegend: {
    display: "flex",
    gap: 16,
    marginTop: 10,
    fontFamily: "var(--font-ui)",
    fontSize: 12,
    color: "var(--ink-soft)",
  },
  loadingOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(244, 240, 230, 0.85)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 100,
  },
  /* Focus Mode */
  focusOverlay: {
    position: "fixed",
    inset: 0,
    background: "var(--paper)",
    zIndex: 150,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    userSelect: "none",
  },
  focusTopBar: {
    position: "absolute",
    top: 0, left: 0, right: 0,
    display: "flex",
    alignItems: "center",
    padding: "14px 20px",
    borderBottom: "1px solid var(--line)",
    background: "var(--paper-deep)",
    cursor: "default",
    gap: 12,
  },
  focusExitBtn: {
    display: "flex", alignItems: "center", gap: 5,
    background: "transparent",
    border: "1px solid var(--line-strong)",
    borderRadius: 8,
    padding: "5px 10px",
    fontFamily: "var(--font-ui)",
    fontSize: 13,
    color: "var(--ink-soft)",
    cursor: "pointer",
  },
  focusDocTitle: {
    flex: 1,
    fontFamily: "var(--font-display)",
    fontSize: 14,
    fontWeight: 600,
    color: "var(--ink)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  focusCounter: {
    fontFamily: "var(--font-ui)",
    fontSize: 13,
    color: "var(--ink-soft)",
    flexShrink: 0,
  },
  jumpInput: {
    width: 52,
    padding: "4px 6px",
    borderRadius: 6,
    border: "1px solid var(--line-strong)",
    fontFamily: "var(--font-ui)",
    fontSize: 13,
    fontWeight: 600,
    color: "var(--ink)",
    background: "var(--paper)",
    textAlign: "center",
    cursor: "text",
  },
  focusProgressTrack: {
    position: "absolute",
    top: 53,
    left: 0, right: 0,
    height: 3,
    background: "var(--line)",
  },
  focusProgressFill: {
    height: "100%",
    background: "var(--accent)",
    transition: "width 0.2s ease",
  },
  focusCenter: {
    maxWidth: 680,
    width: "90%",
    textAlign: "center",
    cursor: "text",
    userSelect: "text",
  },
  focusSentence: {
    fontFamily: "var(--font-serif)",
    fontSize: 28,
    lineHeight: 1.7,
    color: "var(--ink)",
    marginBottom: 32,
    letterSpacing: "-0.01em",
  },
  focusHint: {
    display: "flex",
    justifyContent: "space-between",
    fontFamily: "var(--font-ui)",
    fontSize: 12,
    color: "var(--ink-faint)",
    marginTop: 8,
  },
  focusNavBtn: {
    position: "absolute",
    top: "50%",
    transform: "translateY(-50%)",
    background: "var(--paper-deep)",
    border: "1px solid var(--line-strong)",
    borderRadius: 10,
    padding: "10px 8px",
    color: "var(--ink-soft)",
    cursor: "pointer",
    zIndex: 10,
    opacity: 0.7,
  },
};

const globalCss = `
:root {
  --paper: #FBF8F2;
  --paper-deep: #F3EEE3;
  --ink: #2B2620;
  --ink-soft: #6B6356;
  --ink-faint: #9C9484;
  --line: #E6DFCF;
  --line-strong: #D8CEB8;
  --accent: #3E5C46;
  --accent-soft: #7C9678;
  --accent-faint: #E1E9DC;
  --font-display: 'Source Serif 4', Georgia, serif;
  --font-serif: 'Source Serif 4', Georgia, 'Times New Roman', serif;
  --font-ui: 'Inter', -apple-system, sans-serif;
}
@import url('https://fonts.googleapis.com/css2?family=Source+Serif+4:wght@400;500;600;700&family=Inter:wght@400;500;600;700&display=swap');
* { box-sizing: border-box; }
body { margin: 0; }
mark.lectio-vm { }
.lectio-spinner {
  width: 28px; height: 28px;
  border: 3px solid var(--line);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: lectio-spin 0.8s linear infinite;
}
.lectio-spinner-sm {
  display: inline-block;
  width: 13px; height: 13px;
  border: 2px solid var(--line);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: lectio-spin 0.8s linear infinite;
}
@keyframes lectio-spin { to { transform: rotate(360deg); } }
button:focus-visible, input:focus-visible, [tabindex]:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
::selection {
  background: var(--accent-faint);
}
@media (max-width: 640px) {
  .lectio-sidebar { display: none; }
}
`;

import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import {
  collectImagesFromDataTransfer,
  collectImagesFromFileList,
} from "./fileEnum";
import { scanImage, terminateWorker, type OcrFinding } from "./ocr";
import { ImageCard } from "./ImageCard";
import { Wizard } from "./Wizard";

export type ScanStatus = "queued" | "scanning" | "done" | "error";

export interface ScanItem {
  id: string;
  file: File;
  url: string;
  status: ScanStatus;
  findings: OcrFinding[];
  error?: string;
}

// How many images we OCR at once. Small so hundreds of images do not blow up
// memory or lock the tab. tesseract shares one worker, so this bounds queueing.
const CONCURRENCY = 2;

let idCounter = 0;
function nextId() {
  return `img-${idCounter++}`;
}

export default function App() {
  const [items, setItems] = useState<ScanItem[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [enumCount, setEnumCount] = useState<number | null>(null);

  const itemsRef = useRef<ScanItem[]>([]);
  itemsRef.current = items;

  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  // A simple queue: ids of items waiting to be scanned, plus active count.
  const queueRef = useRef<string[]>([]);
  const activeRef = useRef(0);

  useEffect(() => {
    return () => {
      // Clean up on unmount: revoke URLs and stop the OCR worker.
      itemsRef.current.forEach((it) => URL.revokeObjectURL(it.url));
      terminateWorker();
    };
  }, []);

  const updateItem = useCallback((id: string, patch: Partial<ScanItem>) => {
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, ...patch } : it)),
    );
  }, []);

  const pump = useCallback(() => {
    while (activeRef.current < CONCURRENCY && queueRef.current.length > 0) {
      const id = queueRef.current.shift()!;
      const item = itemsRef.current.find((it) => it.id === id);
      if (!item) continue;
      activeRef.current++;
      updateItem(id, { status: "scanning" });
      scanImage(item.url)
        .then((findings) => {
          updateItem(id, { status: "done", findings });
          // Bound memory: if nothing was found we no longer need the object URL
          // for an overlay. Keep it only when there are findings to inspect.
          if (findings.length === 0) {
            URL.revokeObjectURL(item.url);
          }
        })
        .catch((err) => {
          updateItem(id, {
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          activeRef.current--;
          pump();
        });
    }
  }, [updateItem]);

  const addFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      const newItems: ScanItem[] = files.map((file) => ({
        id: nextId(),
        file,
        url: URL.createObjectURL(file),
        status: "queued" as ScanStatus,
        findings: [],
      }));
      setItems((prev) => [...prev, ...newItems]);
      queueRef.current.push(...newItems.map((it) => it.id));
      // Let state settle so scanImage can find items in the ref, then pump.
      setTimeout(pump, 0);
    },
    [pump],
  );

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setDragActive(false);
      setEnumCount(0);
      const files = await collectImagesFromDataTransfer(e.dataTransfer, (n) =>
        setEnumCount(n),
      );
      setEnumCount(null);
      addFiles(files);
    },
    [addFiles],
  );

  const onPickFiles = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!e.target.files) return;
      addFiles(collectImagesFromFileList(e.target.files));
      e.target.value = "";
    },
    [addFiles],
  );

  const clearAll = useCallback(() => {
    itemsRef.current.forEach((it) => URL.revokeObjectURL(it.url));
    queueRef.current = [];
    setItems([]);
  }, []);

  const total = items.length;
  const scanned = items.filter(
    (it) => it.status === "done" || it.status === "error",
  ).length;
  const totalFindings = items.reduce((n, it) => n + it.findings.length, 0);
  const highFindings = items.reduce(
    (n, it) => n + it.findings.filter((f) => f.tier === "high").length,
    0,
  );
  const scanning = scanned < total;

  return (
    <div className="app">
      <header className="hero">
        <div className="logo-row">
          <span className="logo">LeakShot</span>
          <span className="badge-web">web</span>
          <a
            className="src-link"
            href="https://github.com/avitalmintz/leakshot-web"
            target="_blank"
            rel="noreferrer"
          >
            source
          </a>
        </div>
        <p className="kicker">Client-side secret scanner</p>
        <h1>
          Find the <span className="redacted">secrets</span> hiding in your
          screenshots.
        </h1>
        <p className="tagline">
          Scans run in your browser. Your screenshots never leave your device.
        </p>
        <p className="subtag">
          OCR and secret detection run entirely on your machine via WebAssembly.
          The only network request is your browser downloading the OCR engine to
          run locally. There is no server, and no image is ever uploaded.
        </p>
      </header>

      <Wizard
        onChooseFolder={() => folderInput.current?.click()}
        onChooseFiles={() => fileInput.current?.click()}
      />

      <DropZone
        dragActive={dragActive}
        enumCount={enumCount}
        onDrop={onDrop}
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onChooseFiles={() => fileInput.current?.click()}
        onChooseFolder={() => folderInput.current?.click()}
      />

      {/* Shared hidden inputs, triggered by both the wizard and the drop zone.
          The file picker uses accept=image/* so iOS opens the photo library. */}
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/*"
        multiple
        hidden
        onChange={onPickFiles}
      />
      <input
        ref={folderInput}
        type="file"
        hidden
        multiple
        // @ts-expect-error non-standard attributes for directory selection
        webkitdirectory=""
        directory=""
        onChange={onPickFiles}
      />

      {total > 0 && (
        <section className="summary">
          <div className="progress-row">
            <div className="progress-track">
              <div
                className="progress-fill"
                style={{ width: `${total ? (scanned / total) * 100 : 0}%` }}
              />
            </div>
            <span className="progress-label">
              {scanning
                ? `Scanning ${scanned} / ${total}…`
                : `Scanned ${total} image${total === 1 ? "" : "s"}`}
            </span>
          </div>
          <div className="summary-stats">
            <span className="stat stat-high">{highFindings} HIGH</span>
            <span className="stat stat-total">{totalFindings} findings</span>
            <button className="btn-ghost" onClick={clearAll}>
              Clear all
            </button>
          </div>
        </section>
      )}

      <main className="grid">
        {items.map((item) => (
          <ImageCard key={item.id} item={item} onUpdate={updateItem} />
        ))}
      </main>

      <footer className="how">
        <h2>How it works</h2>
        <ol>
          <li>
            You drop in screenshots (or a whole folder / your Photos selection).
          </li>
          <li>
            <strong>tesseract.js</strong> runs OCR in your browser via
            WebAssembly to read the text and word positions.
          </li>
          <li>
            The LeakShot detector engine (a faithful port of the desktop tool)
            scans that text for API keys, tokens, JWTs, credit cards, SSNs and
            more, with checksum / decode validation to keep precision high.
          </li>
          <li>
            You review findings and redact them. Redaction paints opaque black
            boxes and downloads a flattened PNG, all locally.
          </li>
        </ol>
        <p className="privacy-note">
          <strong>Privacy:</strong> No backend exists. Open the network tab and
          you will only see the OCR engine and language model being fetched.
          Your images stay in this tab and are discarded when you close it.
        </p>
      </footer>
    </div>
  );
}

interface DropZoneProps {
  dragActive: boolean;
  enumCount: number | null;
  onDrop: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onChooseFiles: () => void;
  onChooseFolder: () => void;
}

function DropZone({
  dragActive,
  enumCount,
  onDrop,
  onDragOver,
  onDragLeave,
  onChooseFiles,
  onChooseFolder,
}: DropZoneProps) {
  return (
    <section
      className={`dropzone ${dragActive ? "drag" : ""}`}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      <div className="dropzone-inner">
        <p className="drop-title">Drop your screenshots here</p>
        <p className="drop-sub">
          PNG, JPG or WebP. Folders are scanned recursively.
        </p>

        {enumCount !== null && (
          <p className="enum-count">Found {enumCount} images…</p>
        )}

        <div className="drop-buttons">
          <button className="btn" onClick={onChooseFiles}>
            Choose files
          </button>
          <button className="btn btn-secondary" onClick={onChooseFolder}>
            Choose folder
          </button>
        </div>
      </div>
    </section>
  );
}

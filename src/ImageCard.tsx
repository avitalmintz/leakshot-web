import { useEffect, useRef, useState } from "react";
import type { ScanItem } from "./App";
import { drawOverlay, redactToDataUrl, triggerDownload } from "./redact";
import { maskSecret } from "./mask";

interface Props {
  item: ScanItem;
  onUpdate: (id: string, patch: Partial<ScanItem>) => void;
}

export function ImageCard({ item }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [imgReady, setImgReady] = useState(false);

  const hasFindings = item.findings.length > 0;

  // Load the image once (only when there are findings to overlay). Images with
  // no findings had their object URL revoked, so we do not draw them.
  useEffect(() => {
    if (!hasFindings || item.status !== "done") return;
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      setImgReady(true);
    };
    img.src = item.url;
    return () => {
      imgRef.current = null;
    };
  }, [hasFindings, item.status, item.url]);

  // Redraw overlay whenever findings, highlight, or image readiness change.
  useEffect(() => {
    if (!imgReady || !imgRef.current || !canvasRef.current) return;
    drawOverlay(canvasRef.current, imgRef.current, item.findings, highlight);
  }, [imgReady, item.findings, highlight]);

  const redactHigh = () => {
    if (!imgRef.current) return;
    const high = item.findings.filter((f) => f.tier === "high");
    const url = redactToDataUrl(imgRef.current, high);
    const base = item.file.name.replace(/\.[^.]+$/, "");
    triggerDownload(url, `${base}.redacted.png`);
  };

  const highCount = item.findings.filter((f) => f.tier === "high").length;

  return (
    <article className={`card ${hasFindings ? "has-findings" : ""}`}>
      <div className="card-media">
        {item.status === "done" && hasFindings ? (
          <canvas ref={canvasRef} className="card-canvas" />
        ) : (
          <img className="card-thumb" src={item.url} alt={item.file.name} />
        )}
        {item.status === "scanning" && (
          <div className="card-overlay">
            <div className="spinner" />
            <span>Reading text…</span>
          </div>
        )}
        {item.status === "queued" && (
          <div className="card-overlay dim">
            <span>Queued</span>
          </div>
        )}
        {item.status === "done" && !hasFindings && (
          <div className="card-badge clean">Clean</div>
        )}
        {item.status === "error" && (
          <div className="card-overlay error">
            <span>OCR failed</span>
          </div>
        )}
      </div>

      <div className="card-body">
        <div className="card-title" title={item.file.name}>
          {item.file.name}
        </div>

        {item.status === "done" && (
          <>
            {hasFindings ? (
              <ul className="findings">
                {item.findings.map((f, i) => (
                  <li
                    key={i}
                    className={`finding ${highlight === i ? "active" : ""}`}
                    onMouseEnter={() => setHighlight(i)}
                    onMouseLeave={() => setHighlight(null)}
                    onClick={() => setHighlight(i)}
                  >
                    <span className={`tier tier-${f.tier}`}>
                      {f.tier === "high" ? "HIGH" : "MED"}
                    </span>
                    <span className="finding-detector">{f.detector}</span>
                    <code className="finding-text">
                      {maskSecret(f.matchedText)}
                    </code>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="no-findings">No secrets detected.</p>
            )}
          </>
        )}
      </div>

      {item.status === "done" && highCount > 0 && (
        <div className="card-actions">
          <button className="btn btn-danger" onClick={redactHigh}>
            Redact {highCount} HIGH & download
          </button>
        </div>
      )}
    </article>
  );
}

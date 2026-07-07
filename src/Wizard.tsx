import { useEffect, useState } from "react";

// The exact one-liner a Mac user pastes into Terminal. It gathers every
// screenshot Spotlight knows about into one folder and opens it. Uses
// `mdfind kMDItemIsScreenCapture:1` (no Full Disk Access needed) and `cp -n`
// so nothing is ever overwritten. Quoting is verified safe for spaced names.
const MAC_COMMAND =
  'mkdir -p ~/Desktop/my-screenshots && mdfind kMDItemIsScreenCapture:1 | while IFS= read -r f; do cp -n "$f" ~/Desktop/my-screenshots/; done && open ~/Desktop/my-screenshots';

type Platform = "mac" | "iphone" | "other";

function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return "iphone";
  if (/Macintosh|Mac OS X/.test(ua)) return "mac";
  return "other";
}

interface WizardProps {
  onChooseFolder: () => void;
  onChooseFiles: () => void;
}

export function Wizard({ onChooseFolder, onChooseFiles }: WizardProps) {
  const [platform, setPlatform] = useState<Platform>("other");

  // Auto-detect on mount (client only), but let the user override via tabs.
  useEffect(() => {
    setPlatform(detectPlatform());
  }, []);

  return (
    <section className="wizard">
      <div className="wizard-head">
        <h2>Get your screenshots</h2>
        <div className="platform-tabs" role="tablist">
          <TabButton
            active={platform === "mac"}
            onClick={() => setPlatform("mac")}
            label="Mac"
          />
          <TabButton
            active={platform === "iphone"}
            onClick={() => setPlatform("iphone")}
            label="iPhone"
          />
          <TabButton
            active={platform === "other"}
            onClick={() => setPlatform("other")}
            label="Other"
          />
        </div>
      </div>

      {platform === "mac" && (
        <MacSteps onChooseFolder={onChooseFolder} />
      )}
      {platform === "iphone" && <IphoneSteps onChooseFiles={onChooseFiles} />}
      {platform === "other" && <OtherSteps onChooseFiles={onChooseFiles} />}
    </section>
  );
}

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      className={`platform-tab ${active ? "active" : ""}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function Step({
  n,
  children,
}: {
  n: number;
  children: React.ReactNode;
}) {
  return (
    <div className="step">
      <div className="step-num">{n}</div>
      <div className="step-content">{children}</div>
    </div>
  );
}

function MacSteps({ onChooseFolder }: { onChooseFolder: () => void }) {
  return (
    <div className="steps">
      <Step n={1}>
        <p className="step-line">
          Copy this command and paste it into Terminal (press{" "}
          <kbd>⌘</kbd>
          <kbd>Space</kbd>, type <em>Terminal</em>, hit Return).
        </p>
        <CommandBlock command={MAC_COMMAND} />
        <p className="step-fineprint">
          It only copies files, never deletes or overwrites, and needs no
          special permissions.
        </p>
      </Step>
      <Step n={2}>
        <p className="step-line">
          A folder called <strong>my-screenshots</strong> opens on your Desktop.
        </p>
      </Step>
      <Step n={3}>
        <p className="step-line">
          Drag that folder into the drop zone below — or{" "}
          <button className="link-btn" onClick={onChooseFolder}>
            choose the folder
          </button>
          .
        </p>
      </Step>
      <div className="sub-tip">
        <span className="sub-tip-label">Screenshots saved in Photos?</span>{" "}
        Open Photos → Media Types → Screenshots → <kbd>⌘</kbd>
        <kbd>A</kbd> → drag them into this window.
      </div>
    </div>
  );
}

function IphoneSteps({ onChooseFiles }: { onChooseFiles: () => void }) {
  return (
    <div className="steps">
      <Step n={1}>
        <p className="step-line">
          Tap <strong>Add screenshots</strong> — your photo library opens.
        </p>
        <button className="btn" onClick={onChooseFiles}>
          Add screenshots
        </button>
      </Step>
      <Step n={2}>
        <p className="step-line">
          Search <strong>Screenshots</strong>, then tap <strong>Select All</strong>.
        </p>
      </Step>
      <Step n={3}>
        <p className="step-line">
          Tap <strong>Add</strong> — everything scans right here on your phone.
        </p>
      </Step>
    </div>
  );
}

function OtherSteps({ onChooseFiles }: { onChooseFiles: () => void }) {
  return (
    <div className="steps">
      <Step n={1}>
        <p className="step-line">
          Find your screenshots folder (Windows: <em>Pictures → Screenshots</em>
          ; Linux: your <em>Pictures</em> folder).
        </p>
      </Step>
      <Step n={2}>
        <p className="step-line">
          Drag the folder into the drop zone below — or{" "}
          <button className="link-btn" onClick={onChooseFiles}>
            choose files
          </button>
          .
        </p>
      </Step>
      <Step n={3}>
        <p className="step-line">
          Everything scans in your browser. Nothing is uploaded.
        </p>
      </Step>
    </div>
  );
}

function CommandBlock({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      // Fallback for browsers/contexts without the async clipboard API.
      const ta = document.createElement("textarea");
      ta.value = command;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* give up silently; user can select manually */
      }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="cmd-block">
      <code className="cmd-text">{command}</code>
      <button
        className={`cmd-copy ${copied ? "copied" : ""}`}
        onClick={copy}
        aria-label="Copy command"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

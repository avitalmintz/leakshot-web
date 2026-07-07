import { useEffect, useState } from "react";

// The exact one-liner a Mac user pastes into Terminal. It gathers every
// screenshot into one folder, reports how many, and opens the folder.
// Two discovery paths because macOS privacy filtering can hide Spotlight
// (mdfind) results from a Terminal that hasn't been granted folder access
// yet: the `find` fallback over the usual folders triggers the standard
// "allow access" prompts instead of silently returning nothing. `cp -n`
// never overwrites; quoting is verified safe for spaced filenames.
const MAC_COMMAND =
  "mkdir -p ~/Desktop/my-screenshots; { mdfind 'kMDItemIsScreenCapture = 1'; find ~/Desktop ~/Downloads ~/Documents ~/Pictures -type f \\( -iname 'screenshot*' -o -iname 'screen shot*' \\) 2>/dev/null; } | sort -u | while IFS= read -r f; do cp -n \"$f\" ~/Desktop/my-screenshots/ 2>/dev/null; done; echo \"Collected $(ls ~/Desktop/my-screenshots | wc -l | tr -d ' ') screenshots.\"; open ~/Desktop/my-screenshots";

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
          To gather the screenshots saved <strong>on this Mac&apos;s disk</strong>,
          copy this command and paste it into Terminal (press <kbd>⌘</kbd>
          <kbd>Space</kbd>, type <em>Terminal</em>, hit Return).
        </p>
        <CommandBlock command={MAC_COMMAND} />
        <p className="step-fineprint">
          It only copies files, never deletes or overwrites. If your Mac asks
          whether Terminal can access your Desktop, Documents, or Downloads,
          click <strong>Allow</strong> — that&apos;s where your screenshots
          live. It prints how many it collected.
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
      <div className="alt-method">
        <p className="alt-method-label">
          iPhone screenshots? They live in the Photos app, not on disk — the
          command above can&apos;t see them. Get them like this:
        </p>
        <ol className="alt-method-steps">
          <li>
            Open <strong>Photos</strong> on this Mac
          </li>
          <li>
            Sidebar → <strong>Media Types → Screenshots</strong>
          </li>
          <li>
            <kbd>⌘</kbd>
            <kbd>A</kbd> to select all, then <strong>drag the selection into
            the drop zone below</strong>
          </li>
        </ol>
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

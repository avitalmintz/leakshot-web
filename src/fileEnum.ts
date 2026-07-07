/**
 * Pure helpers for enumerating dropped files and folders.
 *
 * The DOM-touching part (reading a FileSystemEntry tree) is thin and delegates
 * all decisions to `isImageFile`, which is pure and unit-tested. This keeps the
 * folder-recursion logic verifiable without a browser.
 */

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp"];
const IMAGE_MIME_PREFIX = "image/";

/**
 * Decide whether a file (by name and optional MIME type) is an image we scan.
 * Accepts png/jpg/jpeg/webp by extension, or anything with an image/* MIME
 * type. Case-insensitive on the extension. Pure: no DOM.
 */
export function isImageFile(name: string, type = ""): boolean {
  if (type && type.toLowerCase().startsWith(IMAGE_MIME_PREFIX)) {
    // Still restrict to the formats OCR handles well.
    const lower = type.toLowerCase();
    return (
      lower === "image/png" ||
      lower === "image/jpeg" ||
      lower === "image/jpg" ||
      lower === "image/webp"
    );
  }
  const lower = name.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Filter a list of {name, type} entries down to the image files. Pure helper
 * used by the folder enumeration and directly unit-tested.
 */
export function filterImageEntries<T extends { name: string; type?: string }>(
  entries: T[],
): T[] {
  return entries.filter((e) => isImageFile(e.name, e.type ?? ""));
}

// ---- DOM-facing enumeration (not unit tested; thin wrapper) ----

// Minimal structural types for the non-standard FileSystem entry API so we do
// not depend on lib.dom's spotty coverage of it.
interface FSEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (cb: (file: File) => void, err?: (e: unknown) => void) => void;
  createReader?: () => {
    readEntries: (cb: (entries: FSEntry[]) => void, err?: (e: unknown) => void) => void;
  };
}

function entryToFile(entry: FSEntry): Promise<File | null> {
  return new Promise((resolve) => {
    if (!entry.isFile || !entry.file) return resolve(null);
    entry.file(
      (file) => resolve(file),
      () => resolve(null),
    );
  });
}

function readAllEntries(
  reader: { readEntries: (cb: (e: FSEntry[]) => void, err?: (e: unknown) => void) => void },
): Promise<FSEntry[]> {
  // readEntries returns results in batches; call until it returns empty.
  return new Promise((resolve) => {
    const all: FSEntry[] = [];
    const pump = () => {
      reader.readEntries(
        (batch) => {
          if (batch.length === 0) {
            resolve(all);
          } else {
            all.push(...batch);
            pump();
          }
        },
        () => resolve(all),
      );
    };
    pump();
  });
}

/**
 * Recurse a dropped FileSystemEntry, collecting image files (including nested
 * subfolders). `onCount` is called as files accumulate so the UI can show a
 * live "Found N images..." counter.
 */
export async function collectImagesFromEntry(
  entry: FSEntry,
  onCount: (n: number) => void,
  acc: File[] = [],
): Promise<File[]> {
  if (entry.isFile) {
    const file = await entryToFile(entry);
    if (file && isImageFile(file.name, file.type)) {
      acc.push(file);
      onCount(acc.length);
    }
    return acc;
  }
  if (entry.isDirectory && entry.createReader) {
    const children = await readAllEntries(entry.createReader());
    for (const child of children) {
      await collectImagesFromEntry(child, onCount, acc);
    }
  }
  return acc;
}

/**
 * Given a DataTransferItemList (from a drop event), enumerate all image files,
 * recursing into any dropped folders. Falls back to DataTransfer.files when the
 * entry API is unavailable.
 */
export async function collectImagesFromDataTransfer(
  dt: DataTransfer,
  onCount: (n: number) => void,
): Promise<File[]> {
  const items = dt.items;
  const entries: FSEntry[] = [];
  if (items && items.length) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      // webkitGetAsEntry is the non-standard folder-aware accessor.
      const getEntry = (item as unknown as {
        webkitGetAsEntry?: () => FSEntry | null;
      }).webkitGetAsEntry;
      const entry = getEntry ? getEntry.call(item) : null;
      if (entry) entries.push(entry);
    }
  }

  if (entries.length) {
    const acc: File[] = [];
    for (const entry of entries) {
      await collectImagesFromEntry(entry, onCount, acc);
    }
    return acc;
  }

  // Fallback: no entry API (or plain file drop). Use the flat file list.
  const files = Array.from(dt.files ?? []);
  const images = files.filter((f) => isImageFile(f.name, f.type));
  onCount(images.length);
  return images;
}

/** Filter a plain FileList (from an <input>) down to image files. */
export function collectImagesFromFileList(files: FileList | File[]): File[] {
  const arr = Array.from(files);
  return arr.filter((f) => isImageFile(f.name, f.type));
}

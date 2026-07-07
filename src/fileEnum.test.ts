import { describe, it, expect } from "vitest";
import { isImageFile, filterImageEntries, collectImagesFromFileList } from "./fileEnum";

describe("isImageFile", () => {
  it("accepts png/jpg/jpeg/webp by extension", () => {
    expect(isImageFile("shot.png")).toBe(true);
    expect(isImageFile("shot.JPG")).toBe(true);
    expect(isImageFile("photo.jpeg")).toBe(true);
    expect(isImageFile("pic.webp")).toBe(true);
  });
  it("rejects non-image extensions", () => {
    expect(isImageFile("notes.txt")).toBe(false);
    expect(isImageFile("archive.zip")).toBe(false);
    expect(isImageFile("movie.mp4")).toBe(false);
    expect(isImageFile("data.heic")).toBe(false);
  });
  it("accepts by MIME type when provided", () => {
    expect(isImageFile("blob", "image/png")).toBe(true);
    expect(isImageFile("blob", "image/webp")).toBe(true);
  });
  it("rejects unsupported MIME types", () => {
    expect(isImageFile("blob", "application/pdf")).toBe(false);
    expect(isImageFile("blob", "image/gif")).toBe(false);
  });
});

describe("filterImageEntries", () => {
  it("filters a mixed entry list down to images, including a subfolder file", () => {
    const entries = [
      { name: "from_photos/IMG_0001.png" },
      { name: "from_photos/sub/IMG_0002.JPEG" },
      { name: "from_photos/readme.txt" },
      { name: "from_photos/.DS_Store" },
      { name: "from_photos/clip.mov" },
      { name: "screenshot.webp", type: "image/webp" },
    ];
    const out = filterImageEntries(entries);
    expect(out.map((e) => e.name)).toEqual([
      "from_photos/IMG_0001.png",
      "from_photos/sub/IMG_0002.JPEG",
      "screenshot.webp",
    ]);
  });
});

describe("collectImagesFromFileList", () => {
  it("filters a FileList-like array", () => {
    const files = [
      new File([""], "a.png", { type: "image/png" }),
      new File([""], "b.txt", { type: "text/plain" }),
      new File([""], "c.jpeg", { type: "image/jpeg" }),
    ];
    const out = collectImagesFromFileList(files);
    expect(out.map((f) => f.name)).toEqual(["a.png", "c.jpeg"]);
  });
});

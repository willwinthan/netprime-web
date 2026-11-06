// Pasting from a web page, chat app or slide tool often brings images in as HTML with a
// data: URL. BlockNote keeps those inside the document instead of calling uploadFile, so a
// single picture can push the saved content past the API's size limits. Call this before
// saving: each inline image is uploaded and its block points at the stored copy instead.

type BlockLike = { id: string; props?: Record<string, unknown>; children?: BlockLike[] };
interface EditorLike {
  document: BlockLike[];
  updateBlock(id: string, update: { props: { url: string } }): unknown;
}

function dataUrlToFile(url: string, name: string): File {
  const comma = url.indexOf(",");
  const header = url.slice(5, comma); // "image/png;base64"
  const type = header.split(";")[0];
  const data = url.slice(comma + 1);
  const bytes = header.includes(";base64")
    ? Uint8Array.from(atob(data), c => c.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(data));
  const ext = type.split("/")[1]?.replace("jpeg", "jpg") || "png";
  return new File([bytes], `${name}.${ext}`, { type });
}

/** Uploads every data: image in the document and rewrites its block. Throws if an upload fails. */
export async function uploadInlineImages(editor: EditorLike, upload: (file: File) => Promise<string>): Promise<void> {
  const inline: { id: string; url: string }[] = [];
  const walk = (blocks: BlockLike[]) => {
    for (const block of blocks) {
      const url = block.props?.url;
      if (typeof url === "string" && url.startsWith("data:image/")) inline.push({ id: block.id, url });
      if (block.children?.length) walk(block.children);
    }
  };
  walk(editor.document);
  for (const [i, { id, url }] of inline.entries()) {
    let stored: string;
    try {
      stored = await upload(dataUrlToFile(url, `pasted-image-${i + 1}`));
    } catch (err: any) {
      throw new Error(`อัปโหลดรูปที่วางไว้ในเนื้อหาไม่สำเร็จ: ${err?.message || "ไม่ทราบสาเหตุ"} (รองรับ PNG, JPG, WebP, GIF ไม่เกิน 5 MB)`);
    }
    editor.updateBlock(id, { props: { url: stored } });
  }
}

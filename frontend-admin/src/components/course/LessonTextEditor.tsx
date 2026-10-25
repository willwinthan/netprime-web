import React, { forwardRef, useEffect, useImperativeHandle, useMemo } from "react";
import "@blocknote/ariakit/style.css";
import { BlockNoteSchema, defaultBlockSpecs } from "@blocknote/core";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/ariakit";
import { useApi } from "../../hooks/useApi";
import { uploadImage } from "../site-admin/ui";
import { thaiDictionary } from "../editor/thaiDictionary";

// Notion-like editor for text lessons (same BlockNote setup as the article editor, minus uploads
// we cannot store). Loaded lazily by LessonEditorModal; the learner side renders the saved JSON
// with site/BlockRenderer without loading BlockNote.

const { video, audio, file, ...blockSpecs } = defaultBlockSpecs;
const schema = BlockNoteSchema.create({ blockSpecs });

export interface LessonTextEditorHandle {
  /** Current document as BlockNote JSON plus a Markdown fallback. */
  getContent(): { content_json: string; content_md: string };
}

interface Props { initialJson: string | null; initialMarkdown: string | null; onChange?: () => void }

const LessonTextEditor = forwardRef<LessonTextEditorHandle, Props>(({ initialJson, initialMarkdown, onChange }, ref) => {
  const api = useApi();
  const dictionary = useMemo(() => thaiDictionary(), []);
  const initialContent = useMemo(() => {
    if (!initialJson) return undefined;
    try {
      const doc = JSON.parse(initialJson);
      return Array.isArray(doc) && doc.length ? doc : undefined;
    } catch { return undefined; }
  }, []);
  const editor = useCreateBlockNote({
    schema,
    dictionary,
    initialContent,
    uploadFile: async (upload: File) => {
      if (!upload.type.startsWith("image/")) throw new Error("อัปโหลดได้เฉพาะรูปภาพ");
      return uploadImage(upload, api.token);
    }
  });

  // Lessons saved before the block editor (or via the API) may only have Markdown.
  useEffect(() => {
    if (!initialContent && initialMarkdown) {
      const blocks = editor.tryParseMarkdownToBlocks(initialMarkdown);
      if (blocks.length) editor.replaceBlocks(editor.document, blocks);
    }
  }, []);

  useImperativeHandle(ref, () => ({
    getContent: () => ({
      content_json: JSON.stringify(editor.document),
      content_md: editor.blocksToMarkdownLossy(editor.document).trim()
    })
  }), [editor]);

  return (
    <div className="np-lesson-editor">
      <BlockNoteView editor={editor} theme="light" onChange={() => onChange?.()} />
    </div>
  );
});

export default LessonTextEditor;

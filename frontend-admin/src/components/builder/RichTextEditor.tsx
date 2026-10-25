import React, { useMemo, useRef } from "react";
import "@blocknote/ariakit/style.css";
import "../editor/editor.css";
import { BlockNoteSchema, defaultBlockSpecs } from "@blocknote/core";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/ariakit";
import { thaiDictionary } from "../editor/thaiDictionary";

/**
 * Notion-like editor for the page builder's "ข้อความ" block (lazy-loaded; same BlockNote package and JSON
 * format as articles, rendered publicly by site/BlockRenderer). Uploads, video, audio and file blocks are
 * left out: images go in the builder's image blocks instead.
 */
const { video, audio, file, image, ...blockSpecs } = defaultBlockSpecs;
const schema = BlockNoteSchema.create({ blockSpecs });

const RichTextEditor: React.FC<{ value: unknown[]; onChange: (doc: unknown[]) => void }> = ({ value, onChange }) => {
  const dictionary = useMemo(() => thaiDictionary(), []);
  const editor = useCreateBlockNote({
    schema,
    dictionary,
    initialContent: Array.isArray(value) && value.length ? (value as any) : undefined
  });
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  return (
    <div style={{ border: "1px solid rgba(0,0,0,0.08)", borderRadius: 12, background: "#fff", minHeight: 160, padding: "8px 0" }}>
      <BlockNoteView editor={editor} theme="light" onChange={() => changeRef.current(editor.document as unknown[])} />
    </div>
  );
};

export default RichTextEditor;

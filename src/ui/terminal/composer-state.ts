import type { HostClipboardService, KeyEvent, TextareaRenderable } from "@opentui/core";
import { createSignal } from "solid-js";
import type { ComposerImage } from "../images.js";
import type { ThreadTuiViewModel } from "./view-model.js";
import { beginClipboardImagePaste, handleComposerPaste, pasteHostClipboard, pasteHostClipboardImage, type ComposerPasteHost } from "./composer-paste.js";

/** Owns the draft and fences asynchronous clipboard work when that draft is cleared. */
export function createComposerDraft(controller: ThreadTuiViewModel, clipboard?: HostClipboardService) {
  const [text, setText] = createSignal("");
  const [cursor, setCursor] = createSignal(0);
  const [forcePaths, setForcePaths] = createSignal(false);
  const [attachments, setAttachments] = createSignal<ComposerImage[]>([]);
  const [pending, setPending] = createSignal(0);
  let editor: TextareaRenderable | undefined;
  let epoch = 0;
  let directPastes = 0;
  let lastDirectPasteAt = 0;
  const replace = (value: string, offset = value.length) => {
    editor?.setText(value);
    if (editor) editor.cursorOffset = offset;
    setText(value);
    setCursor(offset);
    setForcePaths(false);
  };
  const host = (): ComposerPasteHost => {
    const started = epoch;
    return {
      rootPath: controller.meta.rootPath, attachments,
      setAttachments: (images) => { if (started === epoch) setAttachments(images); },
      insertText: (value) => {
        if (started !== epoch || !editor) return;
        editor.editBuffer.insertText(value);
        setText(editor.plainText);
        setCursor(editor.cursorOffset);
      },
      note: (value, level) => { if (started === epoch) controller.note(value, level); },
      ...(clipboard ? { hostClipboard: clipboard } : {}),
    };
  };
  const track = (operation: Promise<unknown>, direct = false) => {
    const started = epoch;
    if (direct) directPastes++;
    setPending((count) => count + 1);
    const settled = () => {
      if (direct) { directPastes = Math.max(0, directPastes - 1); lastDirectPasteAt = Date.now(); }
      if (started === epoch) setPending((count) => Math.max(0, count - 1));
    };
    void operation.then(settled, settled);
  };
  return {
    text, cursor, forcePaths, attachments, setText, setCursor, setForcePaths, setAttachments, replace,
    busy: () => pending() > 0,
    get editor() { return editor; },
    setEditor: (value: TextareaRenderable) => { editor = value; },
    clear() {
      epoch++;
      setPending(0);
      editor?.clear();
      replace("");
      setAttachments([]);
    },
    paste(event: Parameters<typeof handleComposerPaste>[1]) {
      if (directPastes > 0 || Date.now() - lastDirectPasteAt < 400) { event.preventDefault(); return; }
      track(handleComposerPaste(host(), event));
    },
    pasteKey(key: KeyEvent): boolean {
      if (key.name !== "v" || key.shift) return false;
      const ctrlV = key.ctrl && !key.meta && !key.option;
      const altV = !key.ctrl && (key.meta || key.option);
      if (!ctrlV && !altV) return false;
      // Alt+V remains available when Windows Terminal intercepts Ctrl+V.
      const native = beginClipboardImagePaste(host());
      if (native) {
        lastDirectPasteAt = Date.now();
        track(native, true);
        return true;
      }
      if (clipboard) {
        lastDirectPasteAt = Date.now();
        track(altV ? pasteHostClipboardImage(host()).then((attached) => {
          if (!attached) controller.note("No image in the clipboard.", "info");
        }) : pasteHostClipboard(host()), true);
        return true;
      }
      if (altV) controller.note("No image in the clipboard.", "info");
      return false;
    },
  };
}
export type ComposerDraft = ReturnType<typeof createComposerDraft>;

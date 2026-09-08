/**
 * Modal.tsx — Confirmation modal (DESIGN.md Level 2)
 *
 * Two variants:
 *   - delete: red confirm button, asks before destructive action
 *   - closeDirty: 3-button (Cancel / Don't Save / Save)
 *
 * Visual: backdrop-blur-xl scrim + glassmorphism panel (same as ContextMenu).
 */

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { ModalState } from "../ide/store.tsx";
import { Button } from "./ui/primitives";

// ── Component ──────────────────────────────────────────────────────────────

export function Modal({
  modal,
  onConfirmDelete,
  onCancelDelete,
  onCloseDirtyCancel,
  onCloseDirtyDontSave,
  onCloseDirtySave,
  onClose,
}: {
  modal: ModalState;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onCloseDirtyCancel: () => void;
  onCloseDirtyDontSave: () => void;
  onCloseDirtySave: () => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape to cancel, focus first button
  useEffect(() => {
    if (!modal) return;
    const currentModal = modal;
    const firstBtn = panelRef.current?.querySelector<HTMLButtonElement>(
      "button:not([disabled])",
    );
    firstBtn?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        if (currentModal.kind === "delete") onCancelDelete();
        else onCloseDirtyCancel();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal, onCancelDelete, onCloseDirtyCancel]);

  if (!modal) return null;

  // Delete variant
  if (modal.kind === "delete") {
    return createPortal(
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        className="fixed inset-0 z-[9990] flex items-center justify-center bg-black/40 px-4"
        onClick={(e) => {
          if (e.target === e.currentTarget) onCancelDelete();
        }}
      >
        <div
          ref={panelRef}
          style={{ width: 400 }}
          className="rounded border border-outline/20 bg-surface/80 font-sans backdrop-blur-xl"
        >
          <h2
            id="modal-title"
            className="px-4 pt-4 font-sans text-[18px] font-medium leading-[24px] text-on-surface"
          >
            {modal.isFolder
              ? `Delete folder "${modal.name}" and its contents?`
              : `Delete "${modal.name}"?`}
          </h2>
          <p className="px-4 py-3 font-body text-[14px] leading-[20px] text-on-surface-variant">
            {modal.isFolder
              ? `This will permanently delete the folder and ${modal.descendantCount} item${modal.descendantCount === 1 ? "" : "s"} inside.`
              : "This will permanently delete the file. This action cannot be undone."}
          </p>
          <div className="flex justify-end gap-2 px-4 pb-4">
            <Button variant="secondary" onClick={onCancelDelete}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={onConfirmDelete}
              className="border-error bg-error/10 text-error hover:bg-error/15"
            >
              Delete
            </Button>
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  // closeDirty variant
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      className="fixed inset-0 z-[9990] flex items-center justify-center bg-black/40 px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCloseDirtyCancel();
      }}
    >
      <div
        ref={panelRef}
        style={{ width: 400 }}
        className="rounded border border-outline/20 bg-surface/80 font-sans backdrop-blur-xl"
      >
        <h2
          id="modal-title"
          className="px-4 pt-4 font-sans text-[18px] font-medium leading-[24px] text-on-surface"
        >
          Save changes to &ldquo;{modal.name}&rdquo;?
        </h2>
        <p className="px-4 py-3 font-body text-[14px] leading-[20px] text-on-surface-variant">
          Your changes will be lost if you don&apos;t save them.
        </p>
        <div className="flex justify-end gap-2 px-4 pb-4">
          <Button variant="secondary" onClick={onCloseDirtyCancel}>
            Cancel
          </Button>
          <Button variant="ghost" onClick={onCloseDirtyDontSave}>
            Don&apos;t Save
          </Button>
          <Button variant="primary" onClick={onCloseDirtySave}>
            Save
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

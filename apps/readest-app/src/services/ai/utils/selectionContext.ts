// Build the model context for a selected passage: the section text UP TO the
// selection (capped to `maxChars` of preceding context) followed by the
// selection marked with « ». Text after the selection is never included, so a
// reader can never be spoiled by content they have not reached. Falls back to
// just the marked selection when it can't be located in the section text.
export function buildSelectionContext(
  sectionText: string,
  selectedText: string,
  maxChars: number,
): string {
  const idx = sectionText.indexOf(selectedText);
  if (idx < 0) return `«${selectedText}»`;
  const start = Math.max(0, idx - maxChars);
  return `${sectionText.slice(start, idx)}«${selectedText}»`;
}

import { useEffect, useRef } from 'react';
import { EditorState, StateEffect } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { LanguageDescription, foldGutter, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { defaultKeymap } from '@codemirror/commands';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { classHighlighter } from '@lezer/highlight';
import '../../styles/code-view.css';

/** The language CodeMirror would highlight this file as, by name (null for plain text). */
export const languageOf = (filename: string) => LanguageDescription.matchFilename(languages, filename);

/**
 * A read-only code view: line numbers, folding, search (Mod+F), and syntax highlighting picked
 * from the file name. Each language's parser loads only when a file of that kind is opened.
 * Token colours come from CSS (`.tok-*`), so the view follows the app's light and dark themes.
 */
export default function CodeView({ text, filename }: { text: string; filename: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: text,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          lineNumbers(),
          foldGutter(),
          drawSelection(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          syntaxHighlighting(classHighlighter),
          keymap.of([...defaultKeymap, ...searchKeymap]),
          EditorView.lineWrapping,
        ],
      }),
    });
    let alive = true;
    void languageOf(filename)?.load()
      .then((support) => { if (alive) view.dispatch({ effects: StateEffect.appendConfig.of(support) }); })
      .catch(() => { /* plain text is still readable */ });
    return () => { alive = false; view.destroy(); };
  }, [text, filename]);

  return <div ref={host} className="code-view" data-language={languageOf(filename)?.name ?? 'Plain text'} />;
}

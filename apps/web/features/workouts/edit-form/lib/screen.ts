import type { EditorState } from './editor-state';

// A union, not a status flag beside a nullable EditorState: the pair allowed
// `ready` with nothing to render, and every consumer had to re-check for it.
// Here the editor exists exactly where it is meant to.
export type EditScreen =
  | { status: 'loading' }
  | { status: 'not-found' }
  | { status: 'not-editable' }
  | { status: 'error' }
  | { status: 'ready'; editor: EditorState };

export type EditScreenWithoutEditor = Exclude<EditScreen, { status: 'ready' }>;

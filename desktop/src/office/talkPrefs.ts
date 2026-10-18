import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { TALK_TOOLS, talkPrefsOf, type TalkPrefs, type TalkTool } from '@shared/office';
import { useChat } from '../chat/chatStore';
import { useSaved } from '../store/saved';

/**
 * The office's live conversations as the person set them (shared/office.ts):
 * on or off, the tool and the model that write them, how often. One choice,
 * changed in the office's own settings or in the app's (Settings → Ofis), kept
 * in this window's storage.
 */

export { TALK_EVERY, TALK_TOOL_NAME } from '@shared/office';

const KEY = 'cortex.office.talk.v1';
// Until 1.0.17 the office kept these with its own preferences.
const OLD_KEY = 'cortex.office.v1';

function load(): TalkPrefs {
  try {
    return talkPrefsOf(JSON.parse(localStorage.getItem(KEY) ?? localStorage.getItem(OLD_KEY) ?? '{}'));
  } catch {
    return talkPrefsOf({});
  }
}

interface TalkState extends TalkPrefs {
  change(patch: Partial<TalkPrefs>): void;
}

export const useTalk = create<TalkState>((set, get) => ({
  ...load(),
  change(patch) {
    set(patch);
    const { live, tool, model, every } = get();
    try {
      localStorage.setItem(KEY, JSON.stringify({ live, tool, model, every }));
    } catch {
      /* for this run */
    }
    useSaved.getState().flash();
  },
}));

/** Whether a tool can write now: a model server up on this machine, Claude Code signed in. */
export type TalkToolState = 'ready' | 'off' | 'signedOut';

/** Every tool that can write the office's talk, each with whether it can now. */
export function useTalkTools(): Array<{ id: TalkTool; state: TalkToolState }> {
  const auth = useChat((state) => state.auth);
  const clis = useChat((state) => state.clis);
  return useMemo(
    () =>
      TALK_TOOLS.map((id) => {
        if (id === 'claude') {
          const claude = (auth ?? []).find((one) => one.id === 'claude');
          return { id, state: claude?.installed && claude.signedIn !== false ? 'ready' : 'signedOut' };
        }
        return { id, state: (clis ?? []).some((one) => one.id === id && one.local === 'up') ? 'ready' : 'off' };
      }),
    [auth, clis],
  );
}

/** The models a ready tool offers, its loaded ones among them; null while asked. */
export function useTalkModels(tool: TalkTool | null, ready: boolean): { models: string[]; loaded: string[] } | null {
  const [models, setModels] = useState<{ models: string[]; loaded: string[] } | null>(null);
  useEffect(() => {
    setModels(null);
    if (!tool || !ready) return;
    let live = true;
    window.cortex.office.models(tool).then(
      (found) => live && setModels(found),
      () => live && setModels({ models: [], loaded: [] }),
    );
    return () => {
      live = false;
    };
  }, [tool, ready]);
  return models;
}

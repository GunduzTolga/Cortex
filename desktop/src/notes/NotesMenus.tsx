import { useEffect, useRef, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { Button, Modal, inputClass } from '../ui/ui';
import { useT } from '../i18n/useT';
import { useEscapeLayer } from '../ui/useEscapeLayer';

/**
 * The notes screen's menus and its two questions: a menu under a button, one
 * at the pointer for a right click in the tree, "are you sure" before a note
 * goes to the bin, and a name for a new note or folder. Asked through one small
 * store and answered by `NotesDialogs`, drawn once by the screen, so a part of
 * it can await an answer the way it would await a call.
 */

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  run: () => void;
  danger?: boolean;
  disabled?: boolean;
}

interface Asked {
  confirm: { title: string; detail: string; action: string; done: (yes: boolean) => void } | null;
  prompt: { title: string; label: string; value: string; action: string; check: (value: string) => string | null; done: (value: string | null) => void } | null;
  menu: { x: number; y: number; items: MenuItem[] } | null;
}

const useAsked = create<Asked>(() => ({ confirm: null, prompt: null, menu: null }));

export const useConfirm = () => (input: { title: string; detail: string; action: string }) =>
  new Promise<boolean>((done) => useAsked.setState({ confirm: { ...input, done } }));

export const usePrompt = () => (input: { title: string; label: string; value: string; action: string; check: (value: string) => string | null }) =>
  new Promise<string | null>((done) => useAsked.setState({ prompt: { ...input, done } }));

export const openContextMenu = (event: React.MouseEvent, items: MenuItem[]) => {
  event.preventDefault();
  useAsked.setState({ menu: { x: event.clientX, y: event.clientY, items } });
};

function MenuList({ items, onDone }: { items: MenuItem[]; onDone: () => void }) {
  return (
    <div role="menu" className="min-w-[12rem] overflow-hidden rounded-xl border border-zinc-200 bg-white py-1 shadow-[0_16px_40px_-16px_rgba(27,23,18,0.45)]">
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => {
            onDone();
            item.run();
          }}
          className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] transition-colors disabled:opacity-40 ${item.danger ? 'text-bad hover:bg-red-50' : 'text-zinc-700 hover:bg-zinc-50'}`}
        >
          <span className="w-4 shrink-0 text-zinc-400">{item.icon}</span>
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** A button that opens a menu under it. */
export function Menu({ label, trigger, items }: { label: string; trigger: ReactNode; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // Escape closes it as the top layer, and only it (src/shell/escapeLayers.ts).
  useEscapeLayer(open, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', away);
    return () => window.removeEventListener('mousedown', away);
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button type="button" aria-label={label} title={label} aria-expanded={open} onClick={() => setOpen(!open)} className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-darkDelegation">
        {trigger}
      </button>
      {open ? (
        <div className="absolute right-0 top-full z-30 mt-1">
          <MenuList items={items} onDone={() => setOpen(false)} />
        </div>
      ) : null}
    </div>
  );
}

function ContextMenu() {
  const menu = useAsked((state) => state.menu);
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  useEscapeLayer(Boolean(menu), () => useAsked.setState({ menu: null }));
  useEffect(() => {
    if (!menu) return;
    const close = () => useAsked.setState({ menu: null });
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) close();
    };
    window.addEventListener('mousedown', away);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('blur', close);
    };
  }, [menu]);
  // Kept inside the window: a menu opened near its edge opens the other way.
  useEffect(() => {
    if (!menu || !box.current) return setPlace(null);
    const { width, height } = box.current.getBoundingClientRect();
    setPlace({ left: Math.min(menu.x, window.innerWidth - width - 8), top: Math.min(menu.y, window.innerHeight - height - 8) });
  }, [menu]);
  if (!menu) return null;
  return (
    <div ref={box} className="fixed z-[90]" style={place ?? { left: menu.x, top: menu.y, visibility: 'hidden' }} data-note-context-menu>
      <MenuList items={menu.items} onDone={() => useAsked.setState({ menu: null })} />
    </div>
  );
}

function PromptDialog() {
  const t = useT();
  const prompt = useAsked((state) => state.prompt);
  const [value, setValue] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    setValue(prompt?.value ?? '');
    setProblem(null);
  }, [prompt]);
  if (!prompt) return null;
  const close = (answer: string | null) => {
    useAsked.setState({ prompt: null });
    prompt.done(answer);
  };
  const submit = () => {
    const found = prompt.check(value);
    if (found) setProblem(found);
    else close(value.trim());
  };
  return (
    <Modal
      open
      title={prompt.title}
      onClose={() => close(null)}
      width="max-w-md"
      dismissOnBackdrop={false}
      footer={
        <>
          <Button tone="quiet" onClick={() => close(null)}>
            {t('notes.cancel')}
          </Button>
          <Button tone="primary" onClick={submit} data-note-prompt-ok>
            {prompt.action}
          </Button>
        </>
      }
    >
      <label className="block text-[12px] text-zinc-500">
        {prompt.label}
        <input
          autoFocus
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setProblem(null);
          }}
          onKeyDown={(event) => event.key === 'Enter' && submit()}
          className={`${inputClass} mt-1.5 text-[13px]`}
          data-note-prompt
        />
      </label>
      {problem ? <p className="mt-2 text-[12px] text-bad">{problem}</p> : null}
    </Modal>
  );
}

function ConfirmDialog() {
  const t = useT();
  const confirm = useAsked((state) => state.confirm);
  if (!confirm) return null;
  const close = (yes: boolean) => {
    useAsked.setState({ confirm: null });
    confirm.done(yes);
  };
  return (
    <Modal
      open
      title={confirm.title}
      onClose={() => close(false)}
      width="max-w-md"
      footer={
        <>
          <Button tone="quiet" onClick={() => close(false)}>
            {t('notes.cancel')}
          </Button>
          <Button tone="primary" onClick={() => close(true)} data-note-confirm>
            {confirm.action}
          </Button>
        </>
      }
    >
      <p className="text-[13px] leading-relaxed text-zinc-600">{confirm.detail}</p>
    </Modal>
  );
}

export function NotesDialogs() {
  return (
    <>
      <ContextMenu />
      <PromptDialog />
      <ConfirmDialog />
    </>
  );
}

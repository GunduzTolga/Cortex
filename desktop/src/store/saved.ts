import { create } from 'zustand';

/**
 * The settings window's "Kaydedildi": a setting is kept the moment it is
 * changed (the main process writes it, or the window's storage keeps it), and
 * the window says so for a moment. Whatever keeps a setting calls `flash`.
 */
export const useSaved = create<{ at: number; flash(): void }>((set) => ({
  at: 0,
  flash: () => set({ at: Date.now() }),
}));

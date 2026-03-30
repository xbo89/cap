import { useEffect } from "react";

interface KeyAction {
  key: string;
  meta?: boolean;
  shift?: boolean;
  action: () => void;
  /** Only active when this condition is true */
  when?: () => boolean;
}

/**
 * Global keyboard shortcut hook.
 * Bindings are only active when `when()` returns true (defaults to always).
 */
export function useKeyboard(actions: KeyAction[]) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't intercept when typing in inputs
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      for (const a of actions) {
        const keyMatch = e.key.toLowerCase() === a.key.toLowerCase();
        const metaMatch = a.meta ? e.metaKey || e.ctrlKey : !e.metaKey && !e.ctrlKey;
        const shiftMatch = a.shift ? e.shiftKey : true;
        const condMatch = a.when ? a.when() : true;

        if (keyMatch && metaMatch && shiftMatch && condMatch) {
          e.preventDefault();
          a.action();
          return;
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [actions]);
}

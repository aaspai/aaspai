"use client";

import { createContext, type ReactNode, useCallback, useContext, useState } from "react";

/**
 * Page header slots — Hermes's `PageHeaderProvider` pattern. Pages can
 * push a title, a small count/status after the title, and an action
 * into the shared header end slot (search input, primary button)
 * without each page rolling its own header markup. Values persist for
 * the lifetime of the mounted page and clear on unmount.
 */

export interface PageHeaderValue {
  title: ReactNode;
  afterTitle: ReactNode;
  end: ReactNode;
}

interface PageHeaderContextValue {
  setTitle: (node: ReactNode) => void;
  setAfterTitle: (node: ReactNode) => void;
  setEnd: (node: ReactNode) => void;
}

const PageHeaderContext = createContext<PageHeaderContextValue | null>(null);

export function PageHeaderProvider({ children }: { children: ReactNode }) {
  const [title, setTitleState] = useState<ReactNode>(null);
  const [afterTitle, setAfterTitleState] = useState<ReactNode>(null);
  const [end, setEndState] = useState<ReactNode>(null);

  const setTitle = useCallback((node: ReactNode) => setTitleState(node), []);
  const setAfterTitle = useCallback((node: ReactNode) => setAfterTitleState(node), []);
  const setEnd = useCallback((node: ReactNode) => setEndState(node), []);

  const hasHeader = title !== null || afterTitle !== null || end !== null;

  return (
    <PageHeaderContext.Provider value={{ setTitle, setAfterTitle, setEnd }}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {hasHeader && (
          <div className="flex items-center justify-between gap-3 pb-4">
            <div className="flex min-w-0 items-center gap-3">
              <div className="min-w-0 text-lg font-semibold tracking-tight">{title}</div>
              {afterTitle}
            </div>
            <div className="flex shrink-0 items-center gap-2">{end}</div>
          </div>
        )}
        {children}
      </div>
    </PageHeaderContext.Provider>
  );
}

export function usePageHeader(): PageHeaderContextValue {
  const ctx = useContext(PageHeaderContext);
  if (!ctx) {
    throw new Error("usePageHeader must be used within <PageHeaderProvider>");
  }
  return ctx;
}

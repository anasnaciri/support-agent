import { useCallback, useState } from "react";

import { DEFAULT_PAGE_SIZE, ROWS_COOKIE, parsePageSize } from "./pagination";

// Client-side table paging state for the SPA read pages. The Next app kept page
// + rows in the URL (server-resolved) with the rows preference in a cookie; the
// SPA drives useQuery from component state and persists the rows preference to
// localStorage (same ROWS_COOKIE key) so it survives reloads and carries across
// tables. Filters stay page-specific state; changing a filter resets to page 1.

const readRowsPref = (): number => {
  try {
    return parsePageSize(localStorage.getItem(ROWS_COOKIE) ?? undefined);
  } catch {
    return DEFAULT_PAGE_SIZE;
  }
};

export interface TableState {
  readonly page: number;
  readonly pageSize: number;
  readonly setPage: (page: number) => void;
  /** Change rows-per-page: persists the preference and jumps back to page 1. */
  readonly setPageSize: (size: number) => void;
  /** Reset to the first page — call when a filter changes. */
  readonly resetPage: () => void;
}

export const useTableState = (): TableState => {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState(readRowsPref);

  const setPageSize = useCallback((size: number) => {
    try {
      localStorage.setItem(ROWS_COOKIE, String(size));
    } catch {
      /* private mode — the preference just doesn't persist */
    }
    setPageSizeState(size);
    setPage(1);
  }, []);

  const resetPage = useCallback(() => setPage(1), []);

  return { page, pageSize, setPage, setPageSize, resetPage };
};

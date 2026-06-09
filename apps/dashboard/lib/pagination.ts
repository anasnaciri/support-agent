export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 10;

// Cookie holding a manager's preferred rows-per-page. Written client-side by
// TablePagination on every Rows change, read server-side by each table page so
// the saved size survives logins without a flash — same approach as
// `sidebar:width` (a server-rendered preference can't live in localStorage).
export const ROWS_COOKIE = "tables:rows";

const isPageSizeOption = (n: number): boolean =>
  PAGE_SIZE_OPTIONS.some((option) => option === n);

export const parsePageSize = (value: string | undefined): number =>
  isPageSizeOption(Number(value)) ? Number(value) : DEFAULT_PAGE_SIZE;

/** A manager's saved rows-per-page, or the built-in default when none is set. */
export const resolveDefaultPageSize = (
  cookieValue: string | undefined,
): number =>
  isPageSizeOption(Number(cookieValue)) ? Number(cookieValue) : DEFAULT_PAGE_SIZE;

/**
 * Active page size for a request: an explicit `?limit=` wins, otherwise the
 * manager's saved default (cookie), otherwise the built-in default.
 */
export const resolvePageSize = (
  urlValue: string | undefined,
  cookieValue: string | undefined,
): number =>
  isPageSizeOption(Number(urlValue))
    ? Number(urlValue)
    : resolveDefaultPageSize(cookieValue);

export const parsePageNumber = (value: string | undefined): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
};

export const totalPagesFor = (totalRows: number, pageSize: number): number =>
  Math.max(1, Math.ceil(totalRows / pageSize));

export const clampPage = (
  page: number,
  totalRows: number,
  pageSize: number,
): number => Math.min(page, totalPagesFor(totalRows, pageSize));

export const hrefWithQuery = (pathname: string, query: string): string =>
  query ? `${pathname}?${query}` : pathname;

export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;

export const parsePageSize = (value: string | undefined): number => {
  const parsed = Number(value);
  return PAGE_SIZE_OPTIONS.some((option) => option === parsed)
    ? parsed
    : DEFAULT_PAGE_SIZE;
};

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

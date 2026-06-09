"use client";

import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import {
  hrefWithQuery,
  PAGE_SIZE_OPTIONS,
  ROWS_COOKIE,
  totalPagesFor,
} from "@/lib/pagination";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

interface TablePaginationProps {
  readonly pathname: string;
  readonly page: number;
  readonly pageSize: number;
  readonly totalRows: number;
  // The manager's effective default size (saved cookie, else the built-in
  // default). `limit` is omitted from URLs when the active size matches it,
  // since the server resolves the same size from the cookie.
  readonly defaultPageSize: number;
  readonly hiddenParams?: ReadonlyArray<readonly [string, string]>;
}

const buildPageHref = (
  pathname: string,
  hiddenParams: ReadonlyArray<readonly [string, string]>,
  page: number,
  pageSize: number,
  defaultPageSize: number,
): string => {
  const qs = new URLSearchParams();
  for (const [key, value] of hiddenParams) {
    if (value) qs.set(key, value);
  }
  if (page > 1) qs.set("page", String(page));
  if (pageSize !== defaultPageSize) qs.set("limit", String(pageSize));
  return hrefWithQuery(pathname, qs.toString());
};

const persistRows = (pageSize: string) => {
  document.cookie = `${ROWS_COOKIE}=${pageSize}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
};

type PageOption =
  | { readonly kind: "page"; readonly value: number }
  | { readonly kind: "ellipsis"; readonly id: string };

const pageOptionsFor = (page: number, totalPages: number): PageOption[] => {
  if (totalPages <= 9) {
    return Array.from({ length: totalPages }, (_, i) => ({
      kind: "page",
      value: i + 1,
    }));
  }

  const pages = new Set<number>([1, totalPages]);
  const start = Math.max(2, page - 2);
  const end = Math.min(totalPages - 1, page + 2);
  for (let p = start; p <= end; p += 1) pages.add(p);

  const sorted = Array.from(pages).sort((a, b) => a - b);
  const options: PageOption[] = [];
  for (const p of sorted) {
    const previous = options[options.length - 1];
    if (
      previous?.kind === "page" &&
      p - previous.value > 1
    ) {
      options.push({ kind: "ellipsis", id: `ellipsis-${previous.value}-${p}` });
    }
    options.push({ kind: "page", value: p });
  }
  return options;
};

const submitFormFor = (target: HTMLSelectElement) => {
  target.form?.requestSubmit();
};

export function TablePagination({
  pathname,
  page,
  pageSize,
  totalRows,
  defaultPageSize,
  hiddenParams = [],
}: TablePaginationProps) {
  const totalPages = totalPagesFor(totalRows, pageSize);
  const firstRow = totalRows === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastRow = Math.min(totalRows, page * pageSize);
  const prevHref = buildPageHref(
    pathname,
    hiddenParams,
    page - 1,
    pageSize,
    defaultPageSize,
  );
  const nextHref = buildPageHref(
    pathname,
    hiddenParams,
    page + 1,
    pageSize,
    defaultPageSize,
  );
  const pageOptions = pageOptionsFor(page, totalPages);

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <p className="text-sm text-muted-foreground">
        Showing {firstRow}-{lastRow} of {totalRows}.
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <Button asChild variant="outline">
          <Link
            href={prevHref}
            aria-disabled={page <= 1}
            className={page <= 1 ? "pointer-events-none opacity-50" : ""}
          >
            <ChevronLeft className="size-3.5" />
            Previous
          </Link>
        </Button>

        <form method="get" className="flex flex-wrap items-end gap-2">
          {hiddenParams.map(([key, value]) =>
            value ? (
              <input key={key} type="hidden" name={key} value={value} />
            ) : null,
          )}
          <div className="w-24 space-y-1.5">
            <Label
              htmlFor="page"
              className="text-[11px] uppercase tracking-wider text-muted-foreground"
            >
              Page
            </Label>
            <NativeSelect
              id="page"
              name="page"
              defaultValue={page}
              className="h-9 tabular-nums"
              onChange={(event) => submitFormFor(event.currentTarget)}
            >
              {pageOptions.map((option) =>
                option.kind === "page" ? (
                  <option key={option.value} value={option.value}>
                    {option.value}
                  </option>
                ) : (
                  <option key={option.id} disabled>
                    ...
                  </option>
                ),
              )}
            </NativeSelect>
          </div>
          <div className="w-24 space-y-1.5">
            <Label
              htmlFor="limit"
              className="text-[11px] uppercase tracking-wider text-muted-foreground"
            >
              Rows
            </Label>
            <NativeSelect
              id="limit"
              name="limit"
              defaultValue={String(pageSize)}
              className="h-9 tabular-nums"
              onChange={(event) => {
                // Persist the choice so it carries to other tables and future
                // sessions, then jump back to the first page and reload.
                persistRows(event.currentTarget.value);
                const pageSelect = event.currentTarget.form?.elements.namedItem(
                  "page",
                );
                if (pageSelect instanceof HTMLSelectElement) {
                  pageSelect.value = "1";
                }
                submitFormFor(event.currentTarget);
              }}
            >
              {PAGE_SIZE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </NativeSelect>
          </div>
        </form>

        <span className="flex h-9 items-center text-sm text-muted-foreground">
          of {totalPages}
        </span>

        <Button asChild variant="outline">
          <Link
            href={nextHref}
            aria-disabled={page >= totalPages}
            className={
              page >= totalPages ? "pointer-events-none opacity-50" : ""
            }
          >
            Next
            <ChevronRight className="size-3.5" />
          </Link>
        </Button>
      </div>
    </div>
  );
}

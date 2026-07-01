import { ChevronLeft, ChevronRight } from "lucide-react";

import { PAGE_SIZE_OPTIONS, pageOptionsFor, totalPagesFor } from "@/lib/pagination";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

// SPA port of the Next TablePagination. The Next component built <Link> hrefs
// and submitted a GET form (server round-trip); here the page owns page/pageSize
// state (see useTableState) and this presentational control drives it through
// callbacks. The pure page-option windowing lives in lib/pagination.

interface TablePaginationProps {
  readonly page: number;
  readonly pageSize: number;
  readonly totalRows: number;
  readonly onPageChange: (page: number) => void;
  readonly onPageSizeChange: (pageSize: number) => void;
}

export function TablePagination({
  page,
  pageSize,
  totalRows,
  onPageChange,
  onPageSizeChange,
}: TablePaginationProps) {
  const totalPages = totalPagesFor(totalRows, pageSize);
  const firstRow = totalRows === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastRow = Math.min(totalRows, page * pageSize);
  const pageOptions = pageOptionsFor(page, totalPages);

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <p className="text-sm text-muted-foreground">
        Showing {firstRow}-{lastRow} of {totalRows}.
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <Button
          variant="outline"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft className="size-3.5" />
          Previous
        </Button>

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
            value={page}
            className="h-9 tabular-nums"
            onChange={(event) => onPageChange(Number(event.currentTarget.value))}
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
            value={String(pageSize)}
            className="h-9 tabular-nums"
            onChange={(event) =>
              onPageSizeChange(Number(event.currentTarget.value))
            }
          >
            {PAGE_SIZE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </NativeSelect>
        </div>

        <span className="flex h-9 items-center text-sm text-muted-foreground">
          of {totalPages}
        </span>

        <Button
          variant="outline"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          Next
          <ChevronRight className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

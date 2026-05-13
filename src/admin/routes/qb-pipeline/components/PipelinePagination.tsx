const PAGE_SIZE = 12;

type PipelinePaginationProps = {
  page: number;
  pageSize?: number;
  total: number;
  onPageChange: (page: number) => void;
};

export function PipelinePagination({
  page,
  pageSize = PAGE_SIZE,
  total,
  onPageChange,
}: PipelinePaginationProps) {
  const pageCount = Math.ceil(total / pageSize);
  if (pageCount <= 1) return null;

  return (
    <div className="flex items-center justify-between mt-3 pt-3 border-t border-ui-border-base">
      <span className="text-xs text-ui-fg-muted">
        Page {page + 1} of {pageCount}
      </span>
      <div className="flex gap-2">
        <button
          disabled={page === 0}
          onClick={() => onPageChange(page - 1)}
          className="text-xs px-3 py-1 rounded border border-ui-border-base disabled:opacity-40 hover:bg-ui-bg-subtle"
        >
          ← Prev
        </button>
        <button
          disabled={page >= pageCount - 1}
          onClick={() => onPageChange(page + 1)}
          className="text-xs px-3 py-1 rounded border border-ui-border-base disabled:opacity-40 hover:bg-ui-bg-subtle"
        >
          Next →
        </button>
      </div>
    </div>
  );
}

export { PAGE_SIZE };
